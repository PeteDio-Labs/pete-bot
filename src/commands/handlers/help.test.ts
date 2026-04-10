import { describe, it, expect, mock } from 'bun:test';
import { handleHelpCommand } from './help.js';
import type { ChatInputCommandInteraction } from 'discord.js';

describe('handleHelpCommand', () => {
  it('should reply with a help embed', async () => {
    let repliedWith: unknown;
    const interaction = {
      reply: mock(async (payload: unknown) => { repliedWith = payload; }),
      followUp: mock(async () => {}),
    } as unknown as ChatInputCommandInteraction;

    await handleHelpCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const call = repliedWith as { embeds: Array<{ data: { title?: string; description?: string } }>; ephemeral: boolean };
    expect(call.ephemeral).toBe(true);
    expect(call.embeds[0]?.data.title).toBe('Pete Bot');
    expect(call.embeds[0]?.data.description).toContain('relay');
  });

  it('should handle reply failure gracefully', async () => {
    const interaction = {
      reply: mock(async () => { throw new Error('Discord error'); }),
      followUp: mock(async () => {}),
    } as unknown as ChatInputCommandInteraction;

    await expect(handleHelpCommand(interaction)).resolves.toBeUndefined();
  });
});
