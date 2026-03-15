import { BaseTool } from './BaseTool.js';
import { missionControlClient } from '../clients/index.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

export interface AlertsToolArgs {
  action: 'recent_events';
  limit?: number;
}

class AlertsTool extends BaseTool<AlertsToolArgs> {
  readonly name = 'alerts';

  readonly schema: ToolSchema = {
    name: 'alerts',
    description:
      'Check recent infrastructure alerts and events from the notification service.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['recent_events'],
        },
        limit: {
          type: 'number',
          description: 'Number of recent events to retrieve (default: 10)',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: AlertsToolArgs): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'recent_events':
          return await this.handleRecentEvents(args.limit);
        default:
          return { success: false, error: `Unknown action: ${args.action}` };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Alerts tool error: ${msg}` };
    }
  }

  private async handleRecentEvents(limit = 10): Promise<ToolResult> {
    const response = await missionControlClient.getRecentEvents(limit);
    const events = response.data;

    if (!Array.isArray(events) || events.length === 0) {
      return {
        success: true,
        action: 'recent_events',
        count: 0,
        events: [],
        message: 'No recent events found',
      };
    }

    return {
      success: true,
      action: 'recent_events',
      count: events.length,
      events: events.map((e) => ({
        source: e.source,
        type: e.type,
        severity: e.severity,
        message: e.message,
        timestamp: e.timestamp,
      })),
    };
  }
}

export default new AlertsTool();
