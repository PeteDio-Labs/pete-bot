/**
 * Plain DM handling — you should be able to just type at it.
 *
 * A DM with a single app is a conversation, and being ignored because you did not
 * remember to type a slash is a bad answer. Anything the owner writes here is treated
 * as the question, and forwarded to the same place /ask forwards to.
 *
 * ⚠ MESSAGE CONTENT IS A PRIVILEGED INTENT. Without it enabled in the Developer Portal
 * under Bot → Privileged Gateway Intents, `content` arrives EMPTY rather than absent —
 * the bot connects, receives the event, and silently sees nothing to answer. Worse,
 * requesting the intent while it is disabled makes login fail outright. The deploy's
 * login check catches that second case loudly; this handler catches the first by saying
 * so instead of ignoring the message.
 */
import type { Client, Message } from 'discord.js';
import { ChannelType, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/index.js';
import { ask } from '../clients/mtraceClient.js';
import { footer } from '../utils/footer.js';

const COLOR_OK = 0x57f287;
const COLOR_ERR = 0xed4245;

export function createMessageHandler(_client: Client) {
  return async function onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;
    if (message.author.id !== config.discord.ownerUserId) return;

    const question = message.content.trim();
    if (!question) {
      // Empty content in a DM the owner just sent means the privileged intent is off,
      // not that they sent nothing. Say which, rather than staying silent.
      logger.warn('DM had empty content — MessageContent intent is probably disabled');
      await message.reply(
        'I received that but cannot read it. Enable **Message Content Intent** under ' +
          'Bot → Privileged Gateway Intents in the Developer Portal, or use `/ask`.',
      );
      return;
    }

    logger.info(`DM question: ${question.slice(0, 120)}`);
    // mtrace crosses six hosts over SSH; without this the DM sits with no acknowledgement
    // for several seconds and reads as a bot that ignored you.
    await message.channel.sendTyping().catch(() => {});

    try {
      const { text, routedBy, timing } = await ask(question);
      const embed = new EmbedBuilder()
        .setColor(COLOR_OK)
        .setDescription(text.length > 4000 ? `${text.slice(0, 3997)}...` : text);
      const f = footer(routedBy, timing);
      if (f) embed.setFooter({ text: f });
      await message.reply({ embeds: [embed] });
      logger.info(`DM answered (${text.length} chars, routed by ${routedBy ?? 'unknown'})`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('DM question failed:', detail);
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_ERR)
            .setTitle('mtrace did not answer')
            .setDescription(`\`\`\`${detail.slice(0, 500)}\`\`\``),
        ],
      });
    }
  };
}

export default createMessageHandler;
