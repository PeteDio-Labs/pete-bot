import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleToolsCommand } from './tools.js';
import { registry } from '../../ai/ToolRegistry.js';
import { toolCatalog } from '../../data/toolCatalog.js';
import type { ChatInputCommandInteraction } from 'discord.js';

// Track embed data from reply calls
function createMockInteraction(toolOption: string | null = null) {
  const repliedEmbeds: Array<{ title: string; description: string; fields: Array<{ name: string; value: string }> }> = [];

  const interaction = {
    options: {
      getString: vi.fn().mockReturnValue(toolOption),
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

describe('handleToolsCommand', () => {
  beforeEach(() => {
    // Ensure registry has at least one tool for list view
    if (registry.size() === 0) {
      registry.register({
        name: 'mission_control',
        schema: {
          name: 'mission_control',
          description: 'Test tool',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        execute: vi.fn().mockResolvedValue({ success: true }),
      });
    }
  });

  describe('list-all view (no tool argument)', () => {
    it('should show all tools with type labels', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction(null);
      await handleToolsCommand(interaction);

      expect(interaction.reply).toHaveBeenCalled();
      const embed = repliedEmbeds[0];
      expect(embed.title).toBe('Available AI Tools');
      expect(embed.description).toContain('/tools tool:<name>');
    });

    it('should label action-based tools', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction(null);
      await handleToolsCommand(interaction);

      const embed = repliedEmbeds[0];
      const mcField = embed.fields.find((f) => f.name.includes('mission_control'));
      expect(mcField?.name).toContain('[action-based]');
    });
  });

  describe('detail view (with tool argument)', () => {
    it('should show actions for action-based tool', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('mission_control');
      await handleToolsCommand(interaction);

      const embed = repliedEmbeds[0];
      expect(embed.title).toBe('Tool: mission_control');
      expect(embed.description).toBe(toolCatalog.mission_control.summary);

      const actionsField = embed.fields.find((f) => f.name === 'Actions');
      expect(actionsField).toBeDefined();
      expect(actionsField!.value).toContain('inventory_summary');
      expect(actionsField!.value).toContain('app_status');
    });

    it('should show examples for a tool', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('qbittorrent');
      await handleToolsCommand(interaction);

      const embed = repliedEmbeds[0];
      const examplesField = embed.fields.find((f) => f.name === 'Examples');
      expect(examplesField).toBeDefined();
      expect(examplesField!.value).toContain('show my downloads');
    });

    it('should show parameters for simple tools', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('calculate');
      await handleToolsCommand(interaction);

      const embed = repliedEmbeds[0];
      const paramsField = embed.fields.find((f) => f.name === 'Parameters');
      expect(paramsField).toBeDefined();
      expect(paramsField!.value).toContain('expression');
    });

    it('should show required params with bold formatting', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('mission_control');
      await handleToolsCommand(interaction);

      const embed = repliedEmbeds[0];
      const actionsField = embed.fields.find((f) => f.name === 'Actions');
      expect(actionsField!.value).toContain('**app** (required)');
    });

    it('should handle unknown tool gracefully', async () => {
      const { interaction, repliedEmbeds } = createMockInteraction('nonexistent');
      await handleToolsCommand(interaction);

      const embed = repliedEmbeds[0];
      expect(embed.title).toBe('Unknown Tool');
      expect(embed.description).toContain('nonexistent');
    });
  });
});
