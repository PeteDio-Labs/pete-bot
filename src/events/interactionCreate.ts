/**
 * Slash-command handling. /ask forwards to mtrace; /status asks whether mtrace is there.
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
import { footer } from '../utils/footer.js';
import { answerEmbeds } from '../utils/render.js';
import { size as openIncidents } from '../server/alertStore.js';
import { askTotal, askDuration } from '../metrics/index.js';

const COLOR_OK = 0x57f287;
const COLOR_ERR = 0xed4245;

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
  };
}

export default createInteractionHandler;
