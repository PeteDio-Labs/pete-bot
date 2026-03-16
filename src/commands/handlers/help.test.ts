import { describe, it, expect, vi } from 'vitest';
import { handleHelpCommand } from './help.js';
import { toolCatalog } from '../../data/toolCatalog.js';
import type { ChatInputCommandInteraction } from 'discord.js';

function createMockInteraction(topicOption: string | null = null) {
  const repliedEmbeds: Array<{ title: string; description: string; fields: Array<{ name: string; value: string }> }> = [];

  const interaction = {
    options: {
      getString: vi.fn().mockReturnValue(topicOption),
    },
    reply: vi.fn().mockImplementation(({ embeds }) => {
      const embed = embeds[0];
      repliedEmbeds.push({
        title: embed.data.title ?? '',
        description: embed.data.description ?? '',
        fields: (embed.data.fields ?? []).map((f: { name: string; value: string }) => ({
          name: f.name,
          value: f.value,
        })),
      });
      return Promise.resolve();
    }),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;

  return { interaction, repliedEmbeds };
}

describe('handleHelpCommand', () => {
  describe('general help (no topic)', () => {
    it('should show bot help with commands and tips', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction(null);
      await handleHelpCommand(interaction);

      expect(interaction.reply).toHaveBeenCalled();
      const embed = repliedEmbeds[0]!;
      expect(embed.title).toBe('Bot Help');
      expect(embed.description).toContain('/ask');
      expect(embed.description).toContain('/tools');
      expect(embed.description).toContain('/help');
      expect(embed.description).toContain('/info');
    });
  });

  describe('tools overview (topic: tools)', () => {
    it('should list all tools with examples', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('tools');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      expect(embed.title).toBe('Tool Help');

      const fieldNames = embed.fields.map((f) => f.name);
      expect(fieldNames).toContain('mission_control');
      expect(fieldNames).toContain('qbittorrent');
      expect(fieldNames).toContain('calculate');
    });

    it('should include summary and examples per tool', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('tools');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      const mcField = embed.fields.find((f) => f.name === 'mission_control');
      const mcCatalog = toolCatalog.mission_control!;
      expect(mcField?.value).toContain(mcCatalog.summary);
      expect(mcField?.value).toContain(mcCatalog.examples[0]);
    });
  });

  describe('per-tool help (topic: specific tool)', () => {
    it('should show capabilities for action-based tool', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('mission_control');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      expect(embed.title).toBe('Help: mission_control');
      expect(embed.description).toContain('You can ask about:');

      const mcCatalog = toolCatalog.mission_control!;
      for (const action of mcCatalog.actions!) {
        expect(embed.description).toContain(action.description);
      }
    });

    it('should show summary for simple tool', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('calculate');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      expect(embed.title).toBe('Help: calculate');
      expect(embed.description).toBe(toolCatalog.calculate!.summary);
    });

    it('should show example prompts', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('qbittorrent');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      const tryField = embed.fields.find((f) => f.name === 'Try asking:');
      expect(tryField).toBeDefined();
      for (const example of toolCatalog.qbittorrent!.examples) {
        expect(tryField!.value).toContain(example);
      }
    });

    it('should show notes when present', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('mission_control');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      const notesField = embed.fields.find((f) => f.name === 'Notes');
      expect(notesField).toBeDefined();
      expect(notesField!.value).toContain('sync_app');
    });

    it('should not show notes when absent', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('calculate');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      const notesField = embed.fields.find((f) => f.name === 'Notes');
      expect(notesField).toBeUndefined();
    });

    it('should handle unknown topic gracefully', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('nonexistent');
      await handleHelpCommand(interaction);

      const embed = repliedEmbeds[0]!;
      expect(embed.title).toBe('Unknown Topic');
      expect(embed.description).toContain('nonexistent');
    });
  });
});
