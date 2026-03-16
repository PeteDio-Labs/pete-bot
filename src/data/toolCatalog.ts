// Tool help metadata catalog — drives /tools and /help displays
// When adding a new tool (*.tool.ts), add a matching entry here and
// a choice to both /tools and /help command definitions.

export interface ActionEntry {
  name: string;
  description: string;
  requiredParams: string[];
  optionalParams: string[];
}

export interface ToolCatalogEntry {
  summary: string;
  type: 'action-based' | 'simple';
  actions?: ActionEntry[];
  parameters?: string[];
  examples: string[];
  notes?: string;
}

export const toolCatalog: Record<string, ToolCatalogEntry> = {
  mission_control: {
    summary: 'Infrastructure, ArgoCD, Proxmox, events, availability',
    type: 'action-based',
    actions: [
      { name: 'inventory_summary', description: 'Overall hosts and workloads', requiredParams: [], optionalParams: [] },
      { name: 'workload_status', description: 'Workloads, optionally by namespace', requiredParams: [], optionalParams: ['namespace'] },
      { name: 'list_apps', description: 'All ArgoCD applications', requiredParams: [], optionalParams: [] },
      { name: 'app_status', description: 'Single ArgoCD app details', requiredParams: ['app'], optionalParams: [] },
      { name: 'sync_app', description: 'Trigger an ArgoCD app sync', requiredParams: ['app'], optionalParams: [] },
      { name: 'node_status', description: 'Proxmox node health', requiredParams: [], optionalParams: [] },
      { name: 'recent_events', description: 'Recent infrastructure events', requiredParams: [], optionalParams: ['limit'] },
      { name: 'availability', description: 'Whether Mission Control is reachable', requiredParams: [], optionalParams: [] },
    ],
    examples: [
      'show me all argocd apps',
      'what is the status of blog-dev',
      'show proxmox node status',
      'show recent mission control events',
      'show workloads in namespace blog',
    ],
    notes: 'sync_app is state-changing; all other actions are read-only',
  },
  qbittorrent: {
    summary: 'Torrent status, speeds, and transfer info',
    type: 'action-based',
    actions: [
      { name: 'list', description: 'List torrents with optional filter', requiredParams: [], optionalParams: ['filter'] },
      { name: 'details', description: 'Details for a specific torrent', requiredParams: ['hash'], optionalParams: [] },
      { name: 'speeds', description: 'Current download/upload speeds', requiredParams: [], optionalParams: [] },
      { name: 'transfer_info', description: 'Overall transfer statistics', requiredParams: [], optionalParams: [] },
    ],
    examples: [
      'show my downloads',
      'what is downloading right now',
      'show qbit speeds',
      'show details for torrent abc123',
    ],
    notes: 'Read-only access to torrent information',
  },
  infrastructure: {
    summary: 'Kubernetes hosts, pods, Proxmox nodes, workload status',
    type: 'action-based',
    actions: [
      { name: 'inventory_summary', description: 'All hosts and workloads', requiredParams: [], optionalParams: [] },
      { name: 'node_status', description: 'Proxmox nodes with CPU/memory', requiredParams: [], optionalParams: [] },
      { name: 'workload_status', description: 'Workloads, optionally by namespace', requiredParams: [], optionalParams: ['namespace'] },
    ],
    examples: [
      'what is running in my homelab',
      'show proxmox node health',
      'show workloads in blog namespace',
    ],
    notes: 'Read-only',
  },
  argocd: {
    summary: 'ArgoCD app sync and health status',
    type: 'action-based',
    actions: [
      { name: 'list_apps', description: 'All apps with sync/health', requiredParams: [], optionalParams: [] },
      { name: 'app_status', description: 'Single app details', requiredParams: ['app'], optionalParams: [] },
      { name: 'sync_app', description: 'Trigger a sync', requiredParams: ['app'], optionalParams: [] },
    ],
    examples: [
      'list all argocd apps',
      'is blog-dev synced',
      'sync mission-control-dev',
    ],
    notes: 'sync_app is state-changing',
  },
  alerts: {
    summary: 'Recent infrastructure alerts and events',
    type: 'action-based',
    actions: [
      { name: 'recent_events', description: 'Recent events from notification service', requiredParams: [], optionalParams: ['limit'] },
    ],
    examples: [
      'show recent alerts',
      'are there any recent events',
    ],
    notes: 'Read-only',
  },
  calculate: {
    summary: 'Evaluate math expressions',
    type: 'simple',
    parameters: ['expression'],
    examples: [
      'what is 2 + 2',
      'calculate sqrt(16)',
      'what is pow(2, 8)',
    ],
  },
  get_current_time: {
    summary: 'Get current date and time',
    type: 'simple',
    parameters: ['timezone (optional)'],
    examples: [
      'what time is it',
      'what time is it in Tokyo',
    ],
  },
};
