/**
 * The failover registry: which services can move between the lab and AWS, and where each lab side
 * answers. This list is the only place that says so.
 *
 * ⚠ A SERVICE WITH NO `labUrl` HAS NO LAB READING. The dashboard shows its lab side as unknown,
 * never as healthy. The dashboard-api URL is the bot's own listener (WEEKLY_DASH_HOST and PORT default); the public hostname sits behind Access and redirects to a login. Add a `labUrl` only after you have confirmed the URL answers without a login.
 * The cloud side has no watchdog yet (it needs the AWS apply), so every cloud side reads unknown.
 */
export type DataClass = 'stateless' | 'replicated' | 'snapshot';

export interface RegistryEntry {
  name: string;
  hostname: string;
  dataClass: DataClass;
  /** True for a service that stays in the Lab: it never gets an enabled switch. */
  pinned: boolean;
  /** An unauthenticated health URL for the lab side. Absent, the lab side is unknown. */
  labUrl?: string;
}

export const REGISTRY: readonly RegistryEntry[] = [
  { name: 'dashboard-api', hostname: 'reports.pdlab.dev', dataClass: 'stateless', pinned: false, labUrl: 'http://127.0.0.1:3018/health' },
  { name: 'authentik', hostname: 'auth.pdlab.dev', dataClass: 'replicated', pinned: false, labUrl: 'https://auth.pdlab.dev/-/health/live/' },
  { name: 'tracerr', hostname: 'tracerr (237)', dataClass: 'snapshot', pinned: false },
  { name: 'plex', hostname: 'plex (CT 236, CT 244)', dataClass: 'snapshot', pinned: true },
  { name: 'arr stack', hostname: 'sonarr, radarr, prowlarr, bazarr', dataClass: 'snapshot', pinned: true },
  { name: 'qbittorrent-vpn', hostname: 'qbittorrent-vpn (CT 110)', dataClass: 'snapshot', pinned: true },
  // Lab-only services: they stay in the Lab and never get a switch. A probe that sits behind a login reads as unknown.
  // Prometheus has no labUrl until its ready URL is confirmed from 237.
  // Vault has no labUrl on purpose: it serves a private CA, which a plain fetch rejects, so a probe here would read down while Vault is up.
  { name: 'vault', hostname: 'vault (CT 223)', dataClass: 'replicated', pinned: true },
  { name: 'plane', hostname: 'plane (CT 235)', dataClass: 'replicated', pinned: true, labUrl: 'http://192.168.50.235:8080/' },
  { name: 'ollama', hostname: 'ollama (CT 246)', dataClass: 'stateless', pinned: true, labUrl: 'http://192.168.50.246:11434/api/tags' },
  { name: 'prometheus', hostname: 'prometheus (CT 240)', dataClass: 'snapshot', pinned: true },
];
