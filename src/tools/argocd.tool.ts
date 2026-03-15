import { BaseTool } from './BaseTool.js';
import { missionControlClient } from '../clients/index.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

export interface ArgoCDToolArgs {
  action: 'list_apps' | 'app_status' | 'sync_app';
  app?: string;
}

class ArgoCDTool extends BaseTool<ArgoCDToolArgs> {
  readonly name = 'argocd';

  readonly schema: ToolSchema = {
    name: 'argocd',
    description:
      'Check ArgoCD application sync and health status, or trigger a sync operation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['list_apps', 'app_status', 'sync_app'],
        },
        app: {
          type: 'string',
          description: 'ArgoCD application name (required for app_status and sync_app)',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: ArgoCDToolArgs): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'list_apps':
          return await this.handleListApps();
        case 'app_status':
          return await this.handleAppStatus(args.app);
        case 'sync_app':
          return await this.handleSyncApp(args.app);
        default:
          return { success: false, error: `Unknown action: ${args.action}` };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `ArgoCD tool error: ${msg}` };
    }
  }

  private async handleListApps(): Promise<ToolResult> {
    const response = await missionControlClient.getArgoApps();
    const apps = response.data;

    return {
      success: true,
      action: 'list_apps',
      count: Array.isArray(apps) ? apps.length : 0,
      apps: (Array.isArray(apps) ? apps : []).map((a) => ({
        name: a.name,
        sync: a.syncStatus,
        health: a.healthStatus,
        revision: a.revision?.substring(0, 8),
      })),
    };
  }

  private async handleAppStatus(app?: string): Promise<ToolResult> {
    if (!app) {
      return { success: false, error: 'Application name is required for app_status action' };
    }

    const response = await missionControlClient.getArgoAppStatus(app);
    const status = response.data;

    return {
      success: true,
      action: 'app_status',
      app: status.name,
      sync: status.syncStatus,
      health: status.healthStatus,
      revision: status.revision,
      message: status.message,
      resources: status.resources?.map((r) => ({
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
        status: r.status,
        health: r.health,
      })),
    };
  }

  private async handleSyncApp(app?: string): Promise<ToolResult> {
    if (!app) {
      return { success: false, error: 'Application name is required for sync_app action' };
    }

    const response = await missionControlClient.syncArgoApp(app);
    const result = response.data;

    if (!result.success) {
      return {
        success: false,
        error: result.error || `Sync failed for ${app}`,
      };
    }

    return {
      success: true,
      action: 'sync_app',
      app,
      message: result.message,
    };
  }
}

export default new ArgoCDTool();
