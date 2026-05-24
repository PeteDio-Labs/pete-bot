/**
 * Plan → Discord embed + button rows (PB.6).
 *
 * Converts a NotifyPayload (mirror of MC's services/notifications/peteBotClient.ts
 * NotifyPayload shape) into the Discord.js v14 message components.
 *
 * Button custom_id encoding: `pb:<planId>:<actionId>` — keeps Pete Bot stateless
 * (every needed identifier lives in the click event, no DB on the bot side).
 * MC enforces that planId matches /^pl_[a-zA-Z0-9_-]{4,64}$/ so the colon
 * separator is unambiguous.
 *
 * "Open in MC" is rendered as a Link button (style=5, no custom_id required),
 * which means it survives plan expiry / button-stripping and never round-trips
 * through the click handler.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIMessageComponent,
} from 'discord.js';

// ─── Plan shape (mirror of NotifyPayload from MC's peteBotClient.ts) ──

export interface NotifyPlan {
  planId: string;
  kind: string;
  severity: 'info' | 'warn' | 'error' | 'critical';
  source: string;
  target: string | null;
  summary: string;
  expiresAt: string | null;
  mcUrl: string;
  buttonsEnabled: boolean;
  actions: Array<{
    actionId: string;
    label: string;
    style: 'primary' | 'secondary' | 'danger' | 'link';
  }>;
}

// ─── Color + emoji per severity ────────────────────────────────────────

const SEVERITY_COLORS: Record<NotifyPlan['severity'], number> = {
  info:     0x3498db, // blue
  warn:     0xf39c12, // orange
  error:    0xed4245, // red
  critical: 0xff0033, // bright red
};

const SEVERITY_EMOJI: Record<NotifyPlan['severity'], string> = {
  info:     'ℹ',
  warn:     '⚠',
  error:    '🛑',
  critical: '🚨',
};

const STYLE_MAP: Record<'primary' | 'secondary' | 'danger' | 'link', ButtonStyle> = {
  primary:   ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger:    ButtonStyle.Danger,
  link:      ButtonStyle.Link,
};

// ─── Embed builder ─────────────────────────────────────────────────────

export function buildPlanEmbed(plan: NotifyPlan): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(SEVERITY_COLORS[plan.severity])
    .setTitle(`${SEVERITY_EMOJI[plan.severity]} ${plan.kind} · ${plan.severity}`)
    .setDescription(plan.summary)
    .setFooter({ text: `plan ${plan.planId} · source: ${plan.source}` });

  if (plan.target) embed.addFields({ name: 'Target', value: plan.target, inline: true });
  if (plan.expiresAt) {
    const expiresUnix = Math.floor(new Date(plan.expiresAt).getTime() / 1000);
    embed.addFields({ name: 'Expires', value: `<t:${expiresUnix}:R>`, inline: true });
  }

  return embed;
}

// ─── Button row builder ────────────────────────────────────────────────
// Discord allows up to 5 buttons per ActionRow and up to 5 rows per message.
// We render actions first, then append a final "Open in MC" link button.

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;

export function buildActionRows(plan: NotifyPlan): ActionRowBuilder<ButtonBuilder>[] {
  if (!plan.buttonsEnabled) {
    // Notification-only render: just an Open-in-MC link button.
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(openInMcButton(plan.mcUrl));
    return [row];
  }

  const buttons: ButtonBuilder[] = plan.actions.map((a) => {
    const btn = new ButtonBuilder().setLabel(truncateLabel(a.label));
    if (a.style === 'link') {
      // Link-styled action buttons need a URL. Per design, link-style actions
      // should be MC deep-links carried in the action's clickPayload; for v2
      // we don't have that wired, so render as a secondary button with a
      // placeholder custom_id (Pete Bot will respond with "not implemented").
      // Once PB.10 ships clickPayload.url, switch this to setURL().
      btn.setStyle(ButtonStyle.Secondary).setCustomId(encodeCustomId(plan.planId, a.actionId));
    } else {
      btn.setStyle(STYLE_MAP[a.style]).setCustomId(encodeCustomId(plan.planId, a.actionId));
    }
    return btn;
  });

  buttons.push(openInMcButton(plan.mcUrl));

  // Chunk into rows of up to 5
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < MAX_ROWS; i += MAX_BUTTONS_PER_ROW) {
    const chunk = buttons.slice(i, i + MAX_BUTTONS_PER_ROW);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...chunk));
  }
  return rows;
}

// ─── custom_id encoding ────────────────────────────────────────────────

const CUSTOM_ID_PREFIX = 'pb';

export function encodeCustomId(planId: string, actionId: string): string {
  // Discord caps custom_id at 100 chars. planId is pl_+12hex=15 chars,
  // prefix+separators+actionId can be up to 84 chars → enforced by Plan service.
  return `${CUSTOM_ID_PREFIX}:${planId}:${actionId}`;
}

export interface DecodedCustomId {
  planId: string;
  actionId: string;
}

export function decodeCustomId(customId: string): DecodedCustomId | null {
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}:`)) return null;
  const parts = customId.split(':');
  if (parts.length < 3) return null;
  const planId = parts[1];
  const actionId = parts.slice(2).join(':'); // allow colons in actionId
  if (!planId || !actionId) return null;
  return { planId, actionId };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function openInMcButton(mcUrl: string): ButtonBuilder {
  return new ButtonBuilder()
    .setLabel('Open in MC')
    .setStyle(ButtonStyle.Link)
    .setURL(mcUrl);
}

function truncateLabel(label: string): string {
  // Discord caps button label at 80 chars.
  return label.length > 80 ? label.slice(0, 77) + '…' : label;
}

// Type assertion helper for the JSON serialization Discord.js expects
// when posting to a channel. Used in the route handler.
export function toAPIComponents(
  rows: ActionRowBuilder<ButtonBuilder>[],
): APIMessageComponent[] {
  return rows.map((r) => r.toJSON());
}
