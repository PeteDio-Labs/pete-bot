import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { OllamaClient } from '../../ai/OllamaClient.js';
import type { ToolExecutionRecord } from '../../ai/types.js';

// Must be declared before vi.mock so the hoisted factory can close over it
const mockProcessMessage = vi.fn();

vi.mock('../../ai/ToolExecutor.js', () => ({
  ToolExecutor: class {
    processMessage = mockProcessMessage;
  },
}));

// Mock utils
vi.mock('../../utils/index.js', () => ({
  isUserAuthorized: vi.fn().mockReturnValue(true),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleAskCommand, buildToolSummary } from './ask.js';
import { isUserAuthorized } from '../../utils/index.js';

// --- Mock Factory ---

function createMockAskInteraction(options: {
  question?: string;
  userId?: string;
  userTag?: string;
  dmCreateFails?: boolean;
  dmSendFails?: boolean;
} = {}) {
  const dmSentMessages: unknown[] = [];
  const followUpArgs: unknown[] = [];
  const editReplyArgs: unknown[] = [];

  const dmChannel = {
    send: options.dmSendFails
      ? vi.fn().mockRejectedValue(new Error('Cannot send DM'))
      : vi.fn().mockImplementation((msg: unknown) => {
          dmSentMessages.push(msg);
          return Promise.resolve();
        }),
  };

  const interaction = {
    user: {
      id: options.userId ?? 'user-123',
      tag: options.userTag ?? 'TestUser#0001',
      createDM: options.dmCreateFails
        ? vi.fn().mockRejectedValue(new Error('Cannot create DM'))
        : vi.fn().mockResolvedValue(dmChannel),
    },
    options: {
      getString: vi.fn().mockReturnValue(options.question ?? 'What is Kubernetes?'),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockImplementation((args: unknown) => {
      editReplyArgs.push(args);
      return Promise.resolve();
    }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockImplementation((args: unknown) => {
      followUpArgs.push(args);
      return Promise.resolve();
    }),
  } as unknown as ChatInputCommandInteraction;

  return { interaction, dmChannel, dmSentMessages, editReplyArgs, followUpArgs };
}

function createMockOllamaClient(available = true) {
  return {
    isAvailable: vi.fn().mockResolvedValue(available),
  } as unknown as OllamaClient;
}

const allowedUsers = ['user-123'];

// --- Tests ---

describe('buildToolSummary', () => {
  function makeRecord(name: string): ToolExecutionRecord {
    return { name, args: {}, result: { success: true } };
  }

  it('should return null for empty tools', () => {
    expect(buildToolSummary([])).toBeNull();
  });

  it('should show single tool without multiplier', () => {
    const result = buildToolSummary([makeRecord('calculate')]);
    expect(result).toBe('`calculate`');
  });

  it('should compress repeated tool names with multiplier', () => {
    const records = Array.from({ length: 4 }, () => makeRecord('mission_control'));
    expect(buildToolSummary(records)).toBe('`mission_control` ×4');
  });

  it('should handle mixed tools with and without multiplier', () => {
    const records = [
      makeRecord('mission_control'),
      makeRecord('mission_control'),
      makeRecord('mission_control'),
      makeRecord('alerts'),
    ];
    expect(buildToolSummary(records)).toBe('`mission_control` ×3, `alerts`');
  });

  it('should handle multiple different tools each used once', () => {
    const records = [makeRecord('calculate'), makeRecord('get_current_time')];
    expect(buildToolSummary(records)).toBe('`calculate`, `get_current_time`');
  });

  it('should preserve insertion order', () => {
    const records = [
      makeRecord('alerts'),
      makeRecord('mission_control'),
      makeRecord('alerts'),
    ];
    expect(buildToolSummary(records)).toBe('`alerts` ×2, `mission_control`');
  });
});

describe('handleAskCommand - DM response behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isUserAuthorized as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('should always send full response embed to DMs', async () => {
    const { interaction, dmChannel, dmSentMessages } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: 'Short answer',
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    expect(interaction.user.createDM).toHaveBeenCalled();
    expect(dmChannel.send).toHaveBeenCalled();
    // Should contain an embed
    const firstDm = dmSentMessages[0] as { embeds?: unknown[] };
    expect(firstDm.embeds).toBeDefined();
    expect(firstDm.embeds!.length).toBeGreaterThan(0);
  });

  it('should not truncate the answer in the DM embed', async () => {
    const longAnswer = 'A'.repeat(2000);
    const { interaction, dmSentMessages } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: longAnswer,
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    const firstDm = dmSentMessages[0] as { embeds?: { data: { description?: string; fields?: { name: string; value: string }[] } }[] };
    const embed = firstDm.embeds?.[0];
    expect(embed).toBeDefined();
    // The full answer should appear somewhere in the embed (description or field)
    const answerInDescription = embed!.data.description === longAnswer;
    const answerInField = embed!.data.fields?.some((f: { value: string }) => f.value === longAnswer);
    expect(answerInDescription || answerInField).toBe(true);
  });

  it('should send overflow as follow-up messages when response exceeds 4096 chars', async () => {
    const hugeAnswer = 'B'.repeat(5000);
    const { interaction, dmChannel, dmSentMessages } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: hugeAnswer,
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    // Should have sent more than one message to DM (embed + overflow chunks)
    expect(dmChannel.send).toHaveBeenCalledTimes(2); // 1 embed + 1 overflow chunk
    // First message is an embed
    const firstDm = dmSentMessages[0] as { embeds?: unknown[] };
    expect(firstDm.embeds).toBeDefined();
    // Second message is plain text overflow
    const secondDm = dmSentMessages[1] as { content?: string };
    expect(secondDm.content).toBeDefined();
  });

  it('should include tools used in the DM embed', async () => {
    const { interaction, dmSentMessages } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: 'Tool result here',
      toolsUsed: [{ name: 'mission_control', args: {}, result: { success: true } }],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    const firstDm = dmSentMessages[0] as { embeds?: { data: { fields?: { name: string; value: string }[] } }[] };
    const embed = firstDm.embeds?.[0];
    expect(embed).toBeDefined();
    const toolsField = embed!.data.fields?.find((f: { name: string }) => f.name === 'Tools Used');
    expect(toolsField).toBeDefined();
    expect(toolsField!.value).toContain('mission_control');
  });

  it('should include question in the DM embed', async () => {
    const { interaction, dmSentMessages } = createMockAskInteraction({ question: 'What is ArgoCD?' });
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: 'ArgoCD is a GitOps tool',
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    const firstDm = dmSentMessages[0] as { embeds?: { data: { fields?: { name: string; value: string }[] } }[] };
    const embed = firstDm.embeds?.[0];
    expect(embed).toBeDefined();
    const questionField = embed!.data.fields?.find((f: { name: string }) => f.name === 'Question');
    expect(questionField).toBeDefined();
    expect(questionField!.value).toBe('What is ArgoCD?');
  });
});

describe('handleAskCommand - channel response deleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isUserAuthorized as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('should delete the deferred reply after sending DM', async () => {
    const { interaction } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: 'Some answer',
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    expect(interaction.deleteReply).toHaveBeenCalled();
  });

  it('should not send any embed to the channel via editReply', async () => {
    const { interaction, editReplyArgs } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: 'Some answer',
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    // editReply should NOT be called with embeds for the normal success path
    const embedReplies = editReplyArgs.filter(
      (args: unknown) => typeof args === 'object' && args !== null && 'embeds' in (args as Record<string, unknown>)
    );
    expect(embedReplies.length).toBe(0);
  });
});

describe('handleAskCommand - error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isUserAuthorized as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('should fall back to ephemeral follow-ups when DMs fail', async () => {
    const { interaction, followUpArgs } = createMockAskInteraction({ dmCreateFails: true });
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockResolvedValue({
      response: 'Answer that cannot be DMed',
      toolsUsed: [],
    });

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    // Should have sent ephemeral follow-ups
    expect(interaction.followUp).toHaveBeenCalled();
    const ephemeralMsg = followUpArgs.find(
      (args: unknown) => typeof args === 'object' && args !== null && (args as { ephemeral?: boolean }).ephemeral === true
    );
    expect(ephemeralMsg).toBeDefined();
  });

  it('should handle Ollama unavailability', async () => {
    const { interaction } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient(false);

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('unavailable') })
    );
    expect(interaction.user.createDM).not.toHaveBeenCalled();
  });

  it('should handle processing errors gracefully', async () => {
    const { interaction } = createMockAskInteraction();
    const ollamaClient = createMockOllamaClient();
    mockProcessMessage.mockRejectedValue(new Error('LLM crashed'));

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Failed') })
    );
    expect(interaction.user.createDM).not.toHaveBeenCalled();
  });
});

describe('handleAskCommand - authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthorized users with ephemeral message', async () => {
    (isUserAuthorized as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { interaction } = createMockAskInteraction({ userId: 'unauthorized-user' });
    const ollamaClient = createMockOllamaClient();

    await handleAskCommand(interaction, ollamaClient, allowedUsers);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true })
    );
    expect(interaction.user.createDM).not.toHaveBeenCalled();
  });
});
