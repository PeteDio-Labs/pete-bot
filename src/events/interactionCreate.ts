/**
 * Slash-command handling. /status reports what pete-bot is holding; /update starts a media
 * update through GitHub Actions and reports what it did (PET-395); /lab relays a question to
 * lab-agent (PET-669). /ask went in PET-518.
 *
 * ⚠ DEFER FIRST, ALWAYS. Discord kills an interaction that is not acknowledged within
 * three seconds, and an update run takes minutes. deferReply buys fifteen minutes;
 * without it the user sees "The application did not respond" while the work succeeds
 * unseen.
 */
import type { Interaction, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/index.js';
import {
  runUpdate,
  UPDATE_TARGETS,
  type UpdateMode,
  type UpdateOutcome,
  type UpdateTarget,
} from '../clients/githubActions.js';
import { askLab, type LabOutcome } from '../clients/labAgent.js';
import { size as openIncidents } from '../server/alertStore.js';
import { askTotal, askDuration } from '../metrics/index.js';
import { getDesk } from '../desk/index.js';
import { BUTTON_PREFIX, type MergeDesk } from '../desk/desk.js';
import { getReports } from '../reports/index.js';
import { REPORT_NAMES, type ReportName } from '../reports/settings.js';

const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfee75c;
const COLOR_ERR = 0xed4245;

/**
 * Discord's interaction token lasts fifteen minutes. An update can outlast it, so past
 * this point the result goes out as a fresh DM rather than an edit that would fail.
 */
const EDIT_WINDOW_MS = 14 * 60_000;

/**
 * ⚠ AUTHORISE ON THE INSTALLER, NOT THE CALLER'S CONTEXT. A user-installed app travels
 * with its installer into every server they are in, so a command can arrive from a
 * channel this app knows nothing about. `interaction.user.id` is the person typing;
 * comparing it to the configured owner is what stops the app answering anyone else.
 */
function authorised(interaction: ChatInputCommandInteraction): boolean {
  return interaction.user.id === config.discord.ownerUserId;
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info('/status');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // No mtrace line since PET-518: pete-bot calls nothing on mtrace. An unconfigured
  // /update is the one state here that needs attention, so it alone turns the embed yellow.
  const incidents = openIncidents();
  const updates = Boolean(config.updates.token);
  const lines = [
    `📟 **alerts** — ${incidents} incident${incidents === 1 ? '' : 's'} open`,
    updates
      ? `🟢 **/update** — configured for \`${config.updates.repo}\``
      : '🟡 **/update** — not configured: `GITHUB_UPDATES_TOKEN` is empty',
    `⏱ **uptime** — ${Math.round(process.uptime())}s`,
  ];

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(updates ? COLOR_OK : COLOR_WARN)
        .setTitle('pete-bot status')
        .setDescription(lines.join('\n')),
    ],
  });
}

function updateTitle(mode: UpdateMode, target: UpdateTarget): string {
  return `/update ${mode} ${target}`;
}

/** Something left to do, or a service that skipped itself, turns a green run yellow. */
function needsAttention(report: string): boolean {
  return /Updates available: [1-9]|Pending: [1-9]|NOTE /.test(report);
}

function outcomeEmbed(mode: UpdateMode, target: UpdateTarget, outcome: UpdateOutcome): EmbedBuilder {
  const title = updateTitle(mode, target);
  if (outcome.kind === 'not-found') {
    return new EmbedBuilder()
      .setColor(COLOR_ERR)
      .setTitle(`${title}: the run never appeared`)
      .setDescription(
        `GitHub accepted the request, but no run named \`${outcome.requestId}\` showed up, ` +
          `so nothing is known to have run. [Workflow runs](${outcome.url})`,
      );
  }
  if (outcome.kind === 'timeout') {
    return new EmbedBuilder()
      .setColor(COLOR_WARN)
      .setTitle(`${title}: still running`)
      .setDescription(`It had not finished when I stopped following it. [Open the run](${outcome.url})`);
  }

  const passed = outcome.conclusion === 'success';
  const body = outcome.report
    ? '```\n' + outcome.report.slice(0, 3700) + '\n```'
    : `_No report came back${outcome.reportError ? `: ${outcome.reportError.slice(0, 200)}` : ''}._`;
  const color = !passed ? COLOR_ERR : outcome.report && !needsAttention(outcome.report) ? COLOR_OK : COLOR_WARN;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(passed ? title : `${title}: ${outcome.conclusion}`)
    .setDescription(`${body}\n[Open the run](${outcome.url})`);
}

/** Edit the deferred reply while its token lives; after that, DM the result instead. */
async function deliver(
  interaction: ChatInputCommandInteraction,
  startedAt: number,
  embed: EmbedBuilder,
): Promise<void> {
  if (Date.now() - startedAt < EDIT_WINDOW_MS) {
    try {
      await interaction.editReply({ embeds: [embed] });
      return;
    } catch (err) {
      logger.warn(
        '/update: could not edit the reply, sending a DM instead:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  await interaction.user.send({ embeds: [embed] });
}

/**
 * /update check|apply. The run does the work; this starts it, follows it, and reports the
 * report it printed. Every ending is said out loud: a run that never appeared, a run that
 * failed, and a run still going when this stopped following it are three different
 * messages, and none of them reads as success.
 */
async function handleUpdate(interaction: ChatInputCommandInteraction, run: typeof runUpdate): Promise<void> {
  const mode = interaction.options.getSubcommand(true) as UpdateMode;
  const target = (interaction.options.getString('target') ?? 'plex-and-arr') as UpdateTarget;
  // force exists only on apply; a check never forces.
  const force = mode === 'apply' && (interaction.options.getBoolean('force') ?? false);
  logger.info(`/update ${mode} ${target}${force ? ' (force)' : ''}`);
  const startedAt = Date.now();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const refuse = async (title: string, description: string): Promise<void> => {
    askTotal.inc({ surface: 'update', status: 'failure' });
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLOR_ERR).setTitle(title).setDescription(description)],
    });
  };
  if (!config.updates.token) {
    await refuse(
      '/update is not configured',
      '`GITHUB_UPDATES_TOKEN` is empty on this host, so pete-bot cannot start a run. See PET-395.',
    );
    return;
  }
  // Discord offers only the listed choices, but the workflow is the gate that matters: it
  // refuses anything outside the same list.
  if (!(UPDATE_TARGETS as readonly string[]).includes(target)) {
    await refuse('/update: unknown target', `\`${target}\` is not one of ${UPDATE_TARGETS.join(', ')}.`);
    return;
  }

  try {
    const outcome = await run(mode, target, force, {
      onStarted: async (run) => {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLOR_WARN)
              .setTitle(`${updateTitle(mode, target)}: running`)
              .setDescription(`[Follow the run](${run.url}). The result lands here when it finishes.`),
          ],
        });
      },
    });
    const ok = outcome.kind === 'completed' && outcome.conclusion === 'success';
    askTotal.inc({ surface: 'update', status: ok ? 'success' : 'failure' });
    logger.info(`/update ${mode} ${target}: ${outcome.kind === 'completed' ? outcome.conclusion : outcome.kind}`);
    await deliver(interaction, startedAt, outcomeEmbed(mode, target, outcome));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    askTotal.inc({ surface: 'update', status: 'failure' });
    logger.error(`/update ${mode} ${target} failed:`, message);
    await deliver(
      interaction,
      startedAt,
      new EmbedBuilder()
        .setColor(COLOR_ERR)
        .setTitle(`${updateTitle(mode, target)} failed`)
        .setDescription(`\`\`\`${message.slice(0, 500)}\`\`\``),
    );
  } finally {
    askDuration.observe({ surface: 'update' }, (Date.now() - startedAt) / 1000);
  }
}

/** The footer says what the answer cost and which tools it read, so a guess is visible. */
export function labEmbed(question: string, outcome: LabOutcome): EmbedBuilder {
  const title = `/lab ${question}`.slice(0, 256);
  if (outcome.kind === 'not-configured') {
    return new EmbedBuilder()
      .setColor(COLOR_WARN)
      .setTitle(title)
      .setDescription('Not configured: `LAB_ASK_TOKEN` is empty, so lab-agent is not deployed on this host yet.');
  }
  if (outcome.kind === 'failed') {
    return new EmbedBuilder().setColor(COLOR_ERR).setTitle(title).setDescription(`No answer: ${outcome.reason.slice(0, 500)}`);
  }
  const r = outcome.result;
  const failed = r.toolCalls.filter((t) => !t.ok).length;
  const tools = [...new Set(r.toolCalls.map((t) => t.name))].join(', ') || 'none';
  return new EmbedBuilder()
    .setColor(r.incomplete || failed > 0 ? COLOR_WARN : COLOR_OK)
    .setTitle(title)
    .setDescription(r.answer.slice(0, 4000))
    .setFooter({
      text: `${r.turns} turns · tools: ${tools}${failed ? ` (${failed} failed)` : ''} · ${r.usage.input} in / ${r.usage.output} out tokens`.slice(0, 2048),
    });
}

async function handleLab(interaction: ChatInputCommandInteraction, ask: typeof askLab): Promise<void> {
  const question = interaction.options.getString('question', true);
  logger.info('/lab');
  await interaction.deferReply();
  const startedAt = Date.now();
  const outcome = await ask(question, config.lab);
  askTotal.inc({ surface: 'lab', status: outcome.kind === 'answer' ? 'success' : 'failure' });
  askDuration.observe({ surface: 'lab' }, (Date.now() - startedAt) / 1000);
  if (outcome.kind === 'failed') logger.error(`/lab failed: ${outcome.reason}`);
  await interaction.editReply({ embeds: [labEmbed(question, outcome)] });
}

/** /report (PET-701): runs one report now. The report arrives as a DM; this answer only confirms it. */
async function handleReport(interaction: ChatInputCommandInteraction): Promise<void> {
  const which = interaction.options.getString('which', true) as ReportName;
  logger.info(`/report ${which}`);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reports = getReports();
  if (!reports || !(REPORT_NAMES as readonly string[]).includes(which)) {
    await interaction.editReply({ content: 'The scheduled reports are off on this host (REPORTS_MODE is empty or misconfigured).' });
    return;
  }
  const sent = await reports.run(which, { markRun: false });
  await interaction.editReply({ content: sent ? `Sent the ${which} report to your DMs.` : `The ${which} report was built but the DM did not send. Check the logs.` });
}

/**
 * A merge desk button (PET-645). The owner check comes first, then the desk reads every
 * fact again before it merges anything. The answer is ephemeral; the desk's own DM and
 * PR comment carry the record.
 */
async function handleDeskButton(interaction: ButtonInteraction, desk: MergeDesk | null): Promise<void> {
  if (interaction.user.id !== config.discord.ownerUserId) {
    askTotal.inc({ surface: 'desk', status: 'refused' });
    logger.warn(`Refused a merge desk button from ${interaction.user.id}`);
    await interaction.reply({ content: 'This app answers only the account that installed it.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!desk) {
    await interaction.editReply({ content: 'The merge desk is off on this host, so nothing was merged.' });
    return;
  }
  try {
    const answer = await desk.tap(interaction.customId);
    askTotal.inc({ surface: 'desk', status: 'success' });
    await interaction.editReply({ content: answer });
  } catch (err) {
    askTotal.inc({ surface: 'desk', status: 'failure' });
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`merge desk button failed: ${message}`);
    await interaction.editReply({ content: `Nothing was merged: ${message.slice(0, 300)}` });
  }
}

export interface InteractionDeps {
  /** Tests pass a fake, so /update never reaches GitHub. */
  runUpdate?: typeof runUpdate;
  /** Tests pass a fake, so /lab never reaches lab-agent. */
  askLab?: typeof askLab;
  /** Tests pass a fake desk; production reads the one main.ts started. */
  desk?: () => MergeDesk | null;
}

export function createInteractionHandler(deps: InteractionDeps = {}) {
  const run = deps.runUpdate ?? runUpdate;
  const desk = deps.desk ?? getDesk;
  const lab = deps.askLab ?? askLab;
  return async function onInteraction(interaction: Interaction): Promise<void> {
    if (typeof interaction.isButton === 'function' && interaction.isButton() && interaction.customId.startsWith(`${BUTTON_PREFIX}:`)) {
      await handleDeskButton(interaction, desk());
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    if (!authorised(interaction)) {
      // Counted, not only logged: an app that has quietly started answering nobody
      // should be visible on the dashboard rather than only in a journal nobody reads.
      askTotal.inc({ surface: interaction.commandName, status: 'refused' });
      logger.warn(`Refused /${interaction.commandName} from ${interaction.user.id}`);
      await interaction.reply({
        content: 'This app answers only the account that installed it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === 'status') await handleStatus(interaction);
    else if (interaction.commandName === 'update') await handleUpdate(interaction, run);
    else if (interaction.commandName === 'lab') await handleLab(interaction, lab);
    else if (interaction.commandName === 'report') await handleReport(interaction);
  };
}

export default createInteractionHandler;
