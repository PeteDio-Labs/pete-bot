/**
 * The failover registry: which services can move between the lab and AWS, and where each lab side
 * answers. This list is the only place that says so.
 *
 * ⚠ A SERVICE WITH NO `labUrl` HAS NO LAB READING. The dashboard shows its lab side as unknown,
 * never as healthy. Add a `labUrl` only after you have confirmed the URL answers without a login.
 * The cloud side has no watchdog yet (it needs the AWS apply), so every cloud side reads unknown.
 */
export type DataClass = 'stateless' | 'replicated' | 'snapshot';

export interface RegistryEntry {
  name: string;
  hostname: string;
  dataClass: DataClass;
  /** True for a service that stays on-prem: it never gets an enabled switch. */
  pinned: boolean;
  /** An unauthenticated health URL for the lab side. Absent, the lab side is unknown. */
  labUrl?: string;
}

export const REGISTRY: readonly RegistryEntry[] = [
  { name: 'dashboard-api', hostname: 'reports.pdlab.dev', dataClass: 'stateless', pinned: false, labUrl: 'https://reports.pdlab.dev/health' },
  { name: 'authentik', hostname: 'auth.pdlab.dev', dataClass: 'replicated', pinned: false, labUrl: 'https://auth.pdlab.dev/-/health/live/' },
  { name: 'tracerr', hostname: 'tracerr (237)', dataClass: 'snapshot', pinned: false },
  { name: 'plex', hostname: 'plex (CT 236, CT 244)', dataClass: 'snapshot', pinned: true },
  { name: 'arr stack', hostname: 'sonarr, radarr, prowlarr, bazarr', dataClass: 'snapshot', pinned: true },
  { name: 'qbittorrent-vpn', hostname: 'qbittorrent-vpn (CT 110)', dataClass: 'snapshot', pinned: true },
];
