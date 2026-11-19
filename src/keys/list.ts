/**
 * Reads the log `keys.yml action=list` prints. The line shape is scripts/keys.py `cmd_list` in petedio-iac:
 *   <name>: owner <o>, version <n>, client id <id>, expires <iso>, <N> days left[ (renew soon)]|, EXPIRED; <state>
 *   <name>: no token (sync creates it)
 *   keys list: read <A> agents in callers.yml and <V> Vault entries; <E> expired
 * The client id is dropped on purpose: the screen has no use for it. A line that does not parse is counted, never skipped.
 */
export interface KeyRow {
  name: string;
  owner: string;
  hasToken: boolean;
  version: string | null;
  expires: string | null;
  daysLeft: number | null;
  expired: boolean;
  renewSoon: boolean;
  inCallers: boolean;
}
export interface KeyList {
  rows: KeyRow[];
  /** The script's own last line, so the screen can say what was read. */
  read: string;
  unparsed: number;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const ROW = /^([a-z][a-z0-9-]{1,30}): owner ([^,]*), version ([^,]*), client id [^,]*, expires ([^,]*?)(?:, (\d+) days left( \(renew soon\))?|, (EXPIRED)|, expiry unknown); (in callers\.yml|NOT in callers\.yml.*)$/;
const NO_TOKEN = /^([a-z][a-z0-9-]{1,30}): no token \(sync creates it\)$/;
const SUMMARY = /^keys list: read \d+ agents in callers\.yml and \d+ Vault entries; \d+ expired$/;

export function parseKeyList(log: string): KeyList | undefined {
  const lines = log.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.replace(STAMP, '').trim());
  const sum = lines.findIndex((l) => SUMMARY.test(l));
  if (sum < 0) return undefined;
  const rows: KeyRow[] = [];
  let unparsed = 0;
  // The rows are the lines just before the summary that look like rows. Lines the runner adds around them are not rows.
  for (const l of lines.slice(0, sum)) {
    const none = NO_TOKEN.exec(l);
    if (none) {
      rows.push({ name: none[1]!, owner: '', hasToken: false, version: null, expires: null, daysLeft: null, expired: false, renewSoon: false, inCallers: true });
      continue;
    }
    const m = ROW.exec(l);
    if (m) {
      const exp = m[4]!.trim();
      rows.push({ name: m[1]!, owner: m[2]!.trim(), hasToken: true, version: m[3]!.trim() === '?' ? null : m[3]!.trim(), expires: exp === '?' ? null : exp, daysLeft: m[5] === undefined ? null : Number(m[5]), expired: m[7] !== undefined, renewSoon: m[6] !== undefined, inCallers: m[8] === 'in callers.yml' });
    } else if (/^[a-z][a-z0-9-]{1,30}: /.test(l)) unparsed++;
  }
  return { rows, read: lines[sum]!, unparsed };
}
