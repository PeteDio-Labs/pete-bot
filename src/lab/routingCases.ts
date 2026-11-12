/** Questions and the tool each needs, for scripts/media-routing-eval.ts. */
export const CASES: Array<{ question: string; expect: string[] }> = [
  { question: 'Where is The Body stuck?', expect: ['trace_request'] },
  { question: 'Who requested Blade?', expect: ['trace_request'] },
  { question: 'Do I have Survivor?', expect: ['library', 'trace_request'] },
  { question: 'What is downloading right now?', expect: ['list_queue'] },
  { question: 'Anything failing in the queue?', expect: ['queue_errors'] },
  { question: 'Why are my torrents not moving?', expect: ['why_is_it_dead', 'vpn_health'] },
  { question: 'Is the VPN up?', expect: ['vpn_health'] },
  { question: 'Does seerr agree with Sonarr?', expect: ['seerr_drift'] },
  { question: 'Who is watching Plex?', expect: ['now_playing'] },
  { question: 'Are the ZFS pools healthy?', expect: ['pool_health'] },
  { question: 'How much disk space is left?', expect: ['disk_free'] },
  { question: 'Are the indexers working?', expect: ['indexer_health'] },
  { question: 'Does anything need an update?', expect: ['stale_versions'] },
];
