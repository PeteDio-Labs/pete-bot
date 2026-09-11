/**
 * Slash-command handling. /ask forwards to mtrace; /status asks whether mtrace is there;
 * /update starts a media update through GitHub Actions and reports what it did (PET-395).
 *
 * ⚠ DEFER FIRST, ALWAYS. Discord kills an interaction that is not acknowledged within
 * three seconds, and mtrace crosses six hosts over SSH to answer — a deep trace takes
 * far longer than that. deferReply buys fifteen minutes; without it the user sees
 * "The application did not respond" while the work succeeds unseen.
 */
import type { Interaction, ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/index.js';
import { ask, health } from '../clients/mtraceClient.js';
import {
  runUpdate,
  UPDATE_TARGETS,
  type UpdateMode,
  type UpdateOutcome,
  type UpdateTarget,
} from '../clients/githubActions.js';
import { footer } from '../utils/footer.js';
import { answerEmbeds } from '../utils/render.js';
import { size as openIncidents } from '../server/alertStore.js';
import { askTotal, askDuration } from '../metrics/index.js';

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

async function handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const question = interaction.options.getString('question', true);
  // ⚠ LOG THE SUCCESS PATH TOO. Logging only failures makes a working /ask
  // indistinguishable from one that never arrived — which cost a round of guessing at
  // whether Discord had delivered the interaction at all. Say what was asked.
  logger.info(`/ask: ${question.slice(0, 120)}`);
  const startedAt = Date.now();

  // Ephemeral: the answer describes internal infrastructure, and a user-installed app
  // can be invoked in someone else's server where that should not be readable.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { text, routedBy, timing, notice } = await ask(question);
    const parts = [footer(routedBy, timing), notice].filter(Boolean);
    await interaction.editReply({ embeds: answerEmbeds(text, parts.join(' · ') || undefined) });

    askTotal.inc({ surface: 'ask', status: 'success' });
    logger.info(`/ask answered (${text.length} chars, routed by ${routedBy ?? 'unknown'})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    askTotal.inc({ surface: 'ask', status: 'failure' });
    logger.error('/ask failed:', message);
    // Report the real reason. "Something went wrong" is what sends you reading logs
    // for a mistyped token, and mtrace already distinguishes its own failures.
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_ERR)
          .setTitle('mtrace did not answer')
          .setDescription(`\`\`\`${message.slice(0, 500)}\`\`\``),
      ],
    });
  } finally {
    askDuration.observe({ surface: 'ask' }, (Date.now() - startedAt) / 1000);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info('/status');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // health() never throws and never sends the bearer — it answers "is that process up",
  // which is the question /status is for.
  const mtrace = await health();
  const lines = [
    mtrace.reachable
      ? `🟢 **mtrace** — reachable${mtrace.model ? ` (${mtrace.model})` : ''}`
      : `🔴 **mtrace** — unreachable\n\`\`\`${(mtrace.detail ?? 'no detail').slice(0, 300)}\`\`\``,
    `📟 **alerts** — ${openIncidents()} incident${openIncidents() === 1 ? '' : 's'} open`,
    `⏱ **uptime** — ${Math.round(process.uptime())}s`,
  ];

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(mtrace.reachable ? COLOR_OK : COLOR_ERR)
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
async function handleUpdate(interaction: ChatInputCommandInteraction): Promise<void> {
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
    const outcome = await runUpdate(mode, target, force, {
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

export function createInteractionHandler() {
  return async function onInteraction(interaction: Interaction): Promise<void> {
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

    if (interaction.commandName === 'ask') await handleAsk(interaction);
    else if (interaction.commandName === 'status') await handleStatus(interaction);
    else if (interaction.commandName === 'update') await handleUpdate(interaction);
  };
}

export default createInteractionHandler;
