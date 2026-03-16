import { describe, it, expect } from 'vitest';
import type { ToolExecutionRecord } from '../../ai/types.js';

// Extract the tool compression logic for unit testing
function compressToolNames(toolsUsed: ToolExecutionRecord[]): string {
  const toolCounts = new Map<string, number>();
  for (const t of toolsUsed) {
    toolCounts.set(t.name, (toolCounts.get(t.name) || 0) + 1);
  }
  return Array.from(toolCounts.entries())
    .map(([name, count]) => count > 1 ? `\`${name}\` ×${count}` : `\`${name}\``)
    .join(', ');
}

function makeRecord(name: string): ToolExecutionRecord {
  return { name, args: {}, result: { success: true } };
}

describe('Tool name compression in /ask response', () => {
  it('should show single tool without multiplier', () => {
    const result = compressToolNames([makeRecord('calculate')]);
    expect(result).toBe('`calculate`');
  });

  it('should compress repeated tool names with multiplier', () => {
    const records = Array.from({ length: 4 }, () => makeRecord('mission_control'));
    const result = compressToolNames(records);
    expect(result).toBe('`mission_control` ×4');
  });

  it('should handle mixed tools with and without multiplier', () => {
    const records = [
      makeRecord('mission_control'),
      makeRecord('mission_control'),
      makeRecord('mission_control'),
      makeRecord('alerts'),
    ];
    const result = compressToolNames(records);
    expect(result).toBe('`mission_control` ×3, `alerts`');
  });

  it('should handle multiple different tools each used once', () => {
    const records = [
      makeRecord('calculate'),
      makeRecord('get_current_time'),
    ];
    const result = compressToolNames(records);
    expect(result).toBe('`calculate`, `get_current_time`');
  });

  it('should handle multiple tools each used multiple times', () => {
    const records = [
      makeRecord('mission_control'),
      makeRecord('mission_control'),
      makeRecord('qbittorrent'),
      makeRecord('qbittorrent'),
      makeRecord('qbittorrent'),
    ];
    const result = compressToolNames(records);
    expect(result).toBe('`mission_control` ×2, `qbittorrent` ×3');
  });

  it('should preserve insertion order', () => {
    const records = [
      makeRecord('alerts'),
      makeRecord('mission_control'),
      makeRecord('alerts'),
    ];
    const result = compressToolNames(records);
    expect(result).toBe('`alerts` ×2, `mission_control`');
  });
});
