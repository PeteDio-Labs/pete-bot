/** Questions and the tool each needs, for scripts/media-routing-eval.ts. */
export const CASES: Array<{ question: string; expect: string[] }> = [
  { question: 'Where is The Body stuck?', expect: ['trace_request'] },
  { question: 'Who requested Blade?', expect: ['trace_request'] },
  { question: 'Do I have Survivor?', expect: ['find_in_library', 'trace_request'] },
  { question: 'What is downloading right now?', expect: ['list_queue'] },
  { question: 'Anything failing in the queue?', expect: ['list_queue_errors'] },
  { question: 'Why are my torrents not moving?', expect: ['diagnose_dead_download', 'check_vpn'] },
  { question: 'Is the VPN up?', expect: ['check_vpn'] },
  { question: 'Does seerr agree with Sonarr?', expect: ['check_seerr_drift'] },
  { question: 'Who is watching Plex?', expect: ['get_now_playing'] },
  { question: 'Are the ZFS pools healthy?', expect: ['check_storage_pools'] },
  { question: 'How much disk space is left?', expect: ['check_disk_space'] },
  { question: 'Are the indexers working?', expect: ['check_indexers'] },
  { question: 'Does anything need an update?', expect: ['check_app_versions'] },
];
