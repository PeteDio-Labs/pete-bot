// Interaction event handler — routes slash commands AND button clicks (PB.6).
import type { Interaction, ButtonInteraction } from 'discord.js';
import { handleHelpCommand } from '../commands/handlers/index.js';
import { discordMessagesProcessed, discordRequestDuration } from '../metrics/index.js';
import { logger } from '../utils/index.js';
import { decodeCustomId } from '../server/discordRenderer.js';
import { postDiscordCallback } from '../clients/missionControlClient.js';

export function createInteractionHandler(): (interaction: Interaction) => Promise<void> {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }
    if (interaction.isButton()) {
      await handlePlanButtonClick(interaction);
      return;
    }
    // Other interaction types (select menus, modals, etc.) not used yet.
  };
}

// ─── Slash command handler (unchanged behaviour) ──────────────────────

async function handleSlashCommand(
  interaction: Parameters<typeof handleHelpCommand>[0],
): Promise<void> {
  const { commandName } = interaction;
  const startTime = Date.now();
  let status: 'success' | 'error' = 'success';

  try {
    if (commandName === 'help') {
      await handleHelpCommand(interaction);
    } else {
      logger.warn(`Unknown command: ${commandName}`);
      status = 'error';
    }
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - startTime) / 1000;
    discordMessagesProcessed.labels(commandName, status).inc();
    discordRequestDuration.labels(commandName).observe(duration);
  }
}

// ─── PB.6 — button click → POST MC /discord/callback ──────────────────
// Forward the click to MC over HMAC-signed HTTP. MC owns:
//   - identity resolution (discord_user_id → mc_user_id)
//   - authz (Authentik group membership per plan kind)
//   - idempotency (first-click-wins via atomic UPDATE in planStore.recordClick)
//   - actual state transition (pending/presented → clicked)
//
// Pete Bot's only job here is: send the click, then tell the user what happened
// via an ephemeral reply. The public channel message is updated separately by
// MC posting back to POST /v1/edit-message.

async function handlePlanButtonClick(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  const decoded = decodeCustomId(customId);

  // Not one of our Plan buttons — leave it for other handlers (none today).
  if (!decoded) {
    logger.debug('Button click ignored (not a Plan custom_id)', { customId });
    return;
  }

  const { planId, actionId } = decoded;
  const discordUserId = interaction.user.id;
  const startTime = Date.now();
  let status: 'success' | 'error' = 'success';

  try {
    // Ephemeral defer — Discord requires a response within 3s. The MC POST
    // may take longer than that; deferReply buys us 15 minutes.
    await interaction.deferReply({ ephemeral: true });

    const result = await postDiscordCallback({
      planId,
      actionId,
      discordUserId,
      channelId: interaction.channelId ?? undefined,
      messageId: interaction.message?.id,
    });

    const userMessage = formatCallbackResultForUser(result);
    await interaction.editReply({ content: userMessage });

    if (!result.ok) status = 'error';

    logger.info('Plan button click forwarded', {
      planId,
      actionId,
      discordUserId,
      mcStatus: result.status,
    });
  } catch (err) {
    status = 'error';
    logger.error('Plan button click handler failed', {
      planId,
      actionId,
      discordUserId,
      error: (err as Error).message,
    });
    // Best-effort apology to the user — never throw out of the interaction handler
    try {
      const message = '⚠️ Pete Bot couldn\'t reach Mission Control. Try again or use the MC web UI.';
      if (interaction.deferred) {
        await interaction.editReply({ content: message });
      } else if (!interaction.replied) {
        await interaction.reply({ content: message, ephemeral: true });
      }
    } catch {
      /* ignore — interaction may have expired */
    }
  } finally {
    const duration = (Date.now() - startTime) / 1000;
    discordMessagesProcessed.labels('plan_button_click', status).inc();
    discordRequestDuration.labels('plan_button_click').observe(duration);
  }
}

function formatCallbackResultForUser(result: { status: number; body: unknown; ok: boolean }): string {
  if (result.ok) {
    const body = result.body as { messageEdit?: string; mcUrl?: string } | null;
    const tail = body?.mcUrl ? ` · [Open in MC](${body.mcUrl})` : '';
    return `✅ ${body?.messageEdit ?? 'Approved'}${tail}`;
  }
  const body = result.body as { error?: string; message?: string; reason?: string } | null;
  switch (result.status) {
    case 401:
      return `🔒 Pete Bot signature rejected by MC (${body?.reason ?? 'unknown'}). This is a server config issue — please ping an admin.`;
    case 403:
      if (body?.error === 'discord_not_linked') {
        return '🔗 Your Discord account is not linked to a Mission Control user. Ask an admin to link it.';
      }
      return `🚫 ${body?.message ?? 'You are not authorized to take this action.'}`;
    case 404:
      return `❓ ${body?.message ?? 'Plan or action not found — it may have been removed.'}`;
    case 409:
      return `⏱ ${body?.message ?? 'Someone already acted on this plan.'}`;
    case 410:
      return `🏁 ${body?.message ?? 'This plan is already closed.'}`;
    default:
      return `❌ MC returned ${result.status}. ${body?.error ?? body?.message ?? 'Unknown error.'}`;
  }
}

export default createInteractionHandler;
