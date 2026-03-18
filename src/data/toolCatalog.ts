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
    summary: 'Unified infrastructure tool: ArgoCD, Proxmox, Prometheus, qBittorrent, K8s, events',
    type: 'action-based',
    actions: [
      // Inventory
      { name: 'inventory_summary', description: 'Overall hosts and workloads', requiredParams: [], optionalParams: [] },
      { name: 'workload_status', description: 'Workloads, optionally by namespace', requiredParams: [], optionalParams: ['namespace'] },
      // ArgoCD
      { name: 'list_apps', description: 'All ArgoCD applications', requiredParams: [], optionalParams: [] },
      { name: 'app_status', description: 'Single ArgoCD app details', requiredParams: ['app'], optionalParams: [] },
      { name: 'sync_app', description: 'Trigger an ArgoCD app sync', requiredParams: ['app'], optionalParams: [] },
      { name: 'app_history', description: 'ArgoCD app deployment history', requiredParams: ['app'], optionalParams: [] },
      { name: 'refresh_app', description: 'Force ArgoCD git re-check', requiredParams: ['app'], optionalParams: [] },
      // Proxmox
      { name: 'node_status', description: 'Proxmox node health (CPU, memory, disk)', requiredParams: [], optionalParams: [] },
      { name: 'start_vm', description: 'Start a Proxmox VM', requiredParams: ['node', 'vmid'], optionalParams: [] },
      { name: 'stop_vm', description: 'Stop a Proxmox VM', requiredParams: ['node', 'vmid'], optionalParams: [] },
      { name: 'start_lxc', description: 'Start a Proxmox LXC container', requiredParams: ['node', 'vmid'], optionalParams: [] },
      { name: 'stop_lxc', description: 'Stop a Proxmox LXC container', requiredParams: ['node', 'vmid'], optionalParams: [] },
      // Events
      { name: 'recent_events', description: 'Recent infrastructure events', requiredParams: [], optionalParams: ['limit'] },
      // Prometheus
      { name: 'cluster_health', description: 'K8s cluster health summary', requiredParams: [], optionalParams: [] },
      { name: 'node_cpu', description: 'Node CPU usage from Prometheus', requiredParams: [], optionalParams: [] },
      { name: 'node_memory', description: 'Node memory usage from Prometheus', requiredParams: [], optionalParams: [] },
      { name: 'pv_usage', description: 'Persistent volume usage', requiredParams: [], optionalParams: [] },
      // qBittorrent
      { name: 'torrent_list', description: 'List torrents with optional filter', requiredParams: [], optionalParams: ['filter'] },
      { name: 'torrent_details', description: 'Details for a specific torrent', requiredParams: ['hash'], optionalParams: [] },
      { name: 'transfer_speeds', description: 'Current download/upload speeds', requiredParams: [], optionalParams: [] },
      // K8s
      { name: 'restart_deployment', description: 'Rolling restart a K8s deployment', requiredParams: ['namespace', 'name'], optionalParams: [] },
      { name: 'pod_logs', description: 'Get pod logs', requiredParams: ['namespace', 'name'], optionalParams: ['lines'] },
      // Meta
      { name: 'availability', description: 'Whether Mission Control is reachable', requiredParams: [], optionalParams: [] },
    ],
    examples: [
      'show me all argocd apps',
      'what is the status of blog-dev',
      'show proxmox node status',
      'show recent events',
      'show workloads in namespace blog',
      'show my downloads',
      'what is downloading right now',
      'show cluster health',
      'show node CPU usage',
      'restart deployment blog-api in blog namespace',
    ],
    notes: 'sync_app, start_vm, stop_vm, start_lxc, stop_lxc, restart_deployment are state-changing; all other actions are read-only',
  },
  web_search: {
    summary: 'Search the web for information',
    type: 'action-based',
    actions: [
      { name: 'search', description: 'Search the web', requiredParams: ['query'], optionalParams: ['max_results'] },
      { name: 'providers', description: 'List available search providers', requiredParams: [], optionalParams: [] },
    ],
    examples: [
      'search for kubernetes best practices',
      'what search providers are available',
    ],
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
