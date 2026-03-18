import { QBittorrentClient } from './QBittorrentClient.js';
import { MissionControlClient } from './MissionControlClient.js';
import { WebSearchClient } from './WebSearchClient.js';
import { config } from '../config.js';

// Create singleton instances
export const qbittorrentClient = new QBittorrentClient(config.qbittorrent.host);
export const missionControlClient = new MissionControlClient(
  config.missionControl.url,
  config.notificationService.url
);
export const webSearchClient = new WebSearchClient(config.webSearchService.url);

export { QBittorrentClient };
export { MissionControlClient };
export { WebSearchClient };
export type { TorrentInfo, TorrentProperties, TransferInfo } from './QBittorrentClient.js';
export type {
  InventoryResponse,
  HostInfo,
  WorkloadInfo,
  ArgoAppStatus,
  SyncResult,
  ProxmoxNode,
  InfraEvent,
} from './MissionControlClient.js';
export type { WebSearchResult, WebSearchResponse, WebSearchProviderInfo } from './WebSearchClient.js';
