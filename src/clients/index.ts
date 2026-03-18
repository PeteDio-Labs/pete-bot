import { MissionControlClient } from './MissionControlClient.js';
import { WebSearchClient } from './WebSearchClient.js';
import { config } from '../config.js';

// Create singleton instances
export const missionControlClient = new MissionControlClient(
  config.missionControl.url,
  config.notificationService.url
);
export const webSearchClient = new WebSearchClient(config.webSearchService.url);

export { MissionControlClient };
export { WebSearchClient };
export type {
  InventoryResponse,
  HostInfo,
  WorkloadInfo,
  ArgoAppStatus,
  SyncResult,
  ProxmoxNode,
  InfraEvent,
  TorrentInfo,
  TorrentProperties,
  TransferInfo,
  MetricResult,
  HealthMetrics,
  OperationResult,
} from './MissionControlClient.js';
export type { WebSearchResult, WebSearchResponse, WebSearchProviderInfo } from './WebSearchClient.js';
