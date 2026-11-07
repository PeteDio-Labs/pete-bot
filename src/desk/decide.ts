/**
 * What the merge desk does with one PR, decided from facts alone (PET-645).
 *
 * ⚠ DETERMINISTIC CODE DECIDES EVERY MERGE. No model output reaches this function except
 * Codex's verdict word, and that word can only hold a merge back or send it to Pedro. It
 * never widens what merges: the tier comes from the classifier on the default branch, and
 * every other gate is a fact GitHub reports.
 *
 * The order is the order a person would check:
 *
 *   1. Is it ours to touch?   A draft, a fork, a stranger's PR, a PR against another
 *                             branch, or one labelled merge-desk/hold is skipped.
 *   2. Did Codex review it?   The review must be of the head SHA. None yet: queue one.
 *                             After two blocking rounds the desk stops and tells Pedro.
 *   3. Can it merge?          No conflict, every check passed, no open review thread.
 *                             A skipped required check, or no check at all in a repo not on
 *                             DESK_NO_CI_REPOS, goes to Pedro instead of merging.
 *   4. Who merges?            Tiers 0 and 1 with "No blocking findings" merge here.
 *                             Tier 2, or a Codex "Escalate to Pedro", waits for his tap.
 */
import type { CheckSummary, PullDetail } from './github.js';
import type { Classification } from './classify.js';
import { effortFor, type CodexReview, type Effort } from './codex.js';

export const HOLD_LABEL = 'merge-desk/hold';
/** Two blocking Codex rounds, then a person looks (the codex-review skill's stop rule). */
export const MAX_ROUNDS = 2;

export interface PrMemory {
  /** The head SHA the desk last queued a Codex review for. */
  queuedSha?: string;
  /** True while that ssh call runs. */
  queueRunning?: boolean;
  /** The head SHA whose queue attempt failed; reported once, not retried on every poll. */
  queueFailedSha?: string;
  /** Rounds Pedro granted past MAX_ROUNDS with the "Review again" button. */
  extraRounds?: number;
  /** The head Pedro asked Codex to review again, and when. Reviews of it before then don't count. */
  requeueSha?: string;
  requeuedAt?: string;
  /** When the queue call for queueFailedSha failed (ISO). The automatic retry timer starts here. */
  queueFailedAt?: string;
  /** Queue calls made for queuedSha, so a broken queue is retried a few times and not forever. */
  queueTries?: number;
  /** When the desk queued Codex for queuedSha (ISO). The fallback timer starts here. */
  queuedAt?: string;
  /** The local Qwen pass on one head (PET-751). Reset by any push, because it names its SHA. */
  qwen?: { sha: string; verdict: QwenVerdict | 'running'; at: string; tries?: number };
}

/** `clean` is the only verdict that lets a PR through. Every other value holds it. */
/** A failed Codex queue call is retried after this long, up to QUEUE_MAX_TRIES calls per head. */
export const QUEUE_RETRY_MS = 15 * 60_000;
export const QUEUE_MAX_TRIES = 3;
export const FAILED_GRACE_MS = 30 * 60_000;
/** Qwen passes the desk will run on one head after an unreadable answer. */
export const QWEN_MAX_TRIES = 3;

export type QwenVerdict = 'clean' | 'block' | 'unreadable' | 'too-large';

/** How long a `running` Qwen pass counts before the desk assumes pete-bot restarted and runs it again. */
export const QWEN_STALE_MS = 10 * 60_000;

/** The Codex-out fallback (PET-751). Absent or `enabled: false` keeps the Codex-only gate. */
export interface Fallback {
  enabled: boolean;
  /** Minutes of silence from a queued Codex review before the fallback starts. */
  afterMs: number;
}

export interface Facts {
  repoFullName: string;
  defaultBranch: string;
  authors: ReadonlySet<string>;
  /** True when the repo is on DESK_NO_CI_REPOS: it runs no PR validation, by decision. */
  noCi: boolean;
  pull: PullDetail;
  classification: Classification;
  codex: CodexReview[];
  checks: CheckSummary;
  /** Branch-protection required checks on the base branch; null or absent when unreadable. */
  requiredChecks?: string[] | null;
  unresolvedThreads: number;
  memory: PrMemory;
  fallback?: Fallback;
  /** Epoch ms; tests set it. */
  now?: number;
}

export type Decision =
  | { kind: 'skip'; reason: string }
  | { kind: 'queue'; sha: string; effort: Effort }
  | { kind: 'wait'; reason: string }
  | { kind: 'stop'; sha: string; rounds: CodexReview[] }
  | { kind: 'qwen'; sha: string }
  | { kind: 'merge'; sha: string; review: CodexReview | null; by: ReviewedBy }
  | { kind: 'ask'; sha: string; review: CodexReview | null; by: ReviewedBy; why: string };

/** Who cleared the head: Codex, the local Qwen pass (tier 1), or CI alone (tier 0, Codex out). */
export type ReviewedBy = 'codex' | 'qwen' | 'ci';

/** Distinct commits Codex blocked, oldest first. */
export function blockingRounds(codex: CodexReview[]): CodexReview[] {
  const seen = new Set<string>();
  return codex
    .filter((r) => r.verdict === 'changes-requested')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .filter((r) => (seen.has(r.commitId) ? false : (seen.add(r.commitId), true)));
}

/**
 * Splits skipped checks into those that block and those that skip by workflow condition.
 * With a readable required list, a skipped check blocks only if it is required, and a
 * required check that did not pass and did not report at all blocks too. Without one,
 * every skip blocks (the old, stricter rule).
 */
export function checkGate(f: Facts): { blocking: string[]; ignored: string[]; examined: string[] } {
  const required = f.requiredChecks;
  if (!required?.length) return { blocking: f.checks.skipped, ignored: [], examined: [] };
  const base = (s: string) => s.replace(/ \((skipped|neutral)\)$/, '');
  const passed = new Set(f.checks.passedNames ?? []);
  const skippedNames = new Set(f.checks.skipped.map(base));
  const blocking = [
    ...f.checks.skipped.filter((s) => required.includes(base(s))),
    ...required.filter((r) => !passed.has(r) && !skippedNames.has(r) && !f.checks.pending.includes(r)).map((r) => `${r} (not reported)`),
  ];
  const ignored = f.checks.skipped.filter((s) => !required.includes(base(s)));
  return { blocking, ignored, examined: required };
}

export function decide(f: Facts): Decision {
  const { pull } = f;
  const sha = pull.headSha;

  if (pull.state !== 'open' || pull.merged) return { kind: 'skip', reason: 'not open' };
  if (pull.draft) return { kind: 'skip', reason: 'draft' };
  if (pull.headRepo.toLowerCase() !== f.repoFullName.toLowerCase()) return { kind: 'skip', reason: 'from a fork' };
  if (!f.authors.has(pull.author.toLowerCase())) return { kind: 'skip', reason: `author ${pull.author} is not on DESK_AUTHORS` };
  if (pull.baseRef !== f.defaultBranch) return { kind: 'skip', reason: `targets ${pull.baseRef}, not ${f.defaultBranch}` };
  if (pull.labels.includes(HOLD_LABEL)) return { kind: 'skip', reason: `labelled ${HOLD_LABEL}` };

  const rounds = blockingRounds(f.codex);
  const allowed = MAX_ROUNDS + (f.memory.extraRounds ?? 0);
  // The newest Codex verdict on exactly this head. An older head's review never counts, and
  // after a "Review again" tap, neither does one posted before the tap.
  const since = f.memory.requeueSha === sha ? Date.parse(f.memory.requeuedAt ?? '') || 0 : 0;
  const onHead = f.codex
    .filter((r) => r.commitId === sha && Date.parse(r.submittedAt) > since)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

  let review: CodexReview | null = null;
  let by: ReviewedBy = 'codex';

  if (!onHead) {
    if (rounds.length >= allowed) return { kind: 'stop', sha, rounds };
    const fb = fallbackFor(f, sha);
    if (fb === 'ci') {
      by = 'ci';
    } else if (fb === 'qwen') {
      const q = f.memory.qwen?.sha === sha ? f.memory.qwen : undefined;
      const now = f.now ?? Date.now();
      const age = q ? now - (Date.parse(q.at) || 0) : 0;
      // A pass stuck `running` after a restart, or an unreadable answer (a timeout, a 5xx), runs again.
      const retry = q && age > QWEN_STALE_MS && (q.verdict === 'running' || (q.verdict === 'unreadable' && (q.tries ?? 1) < QWEN_MAX_TRIES));
      if (!q || retry) return { kind: 'qwen', sha };
      if (q.verdict === 'running') return { kind: 'wait', reason: 'the Qwen review is running' };
      if (q.verdict !== 'clean') return { kind: 'wait', reason: `Qwen review: ${q.verdict}; push a fix or ask for a person` };
      by = 'qwen';
    } else {
      if (f.memory.queuedSha === sha) {
        if (f.memory.queueRunning) return { kind: 'wait', reason: 'Codex is reviewing the head' };
        if (f.memory.queueFailedSha === sha) {
          const failedFor = (f.now ?? Date.now()) - (Date.parse(f.memory.queueFailedAt ?? '') || 0);
          if ((f.memory.queueTries ?? 1) < QUEUE_MAX_TRIES && failedFor >= QUEUE_RETRY_MS) {
            return { kind: 'queue', sha, effort: effortFor(f.classification.tier) };
          }
          return { kind: 'wait', reason: 'queueing Codex failed for this head' };
        }
        return { kind: 'wait', reason: 'Codex finished but posted no review of the head yet' };
      }
      return { kind: 'queue', sha, effort: effortFor(f.classification.tier) };
    }
  } else {
    review = onHead;
    if (onHead.verdict === 'changes-requested') {
      if (rounds.length >= allowed) return { kind: 'stop', sha, rounds };
      return { kind: 'wait', reason: 'Codex requested changes on the head' };
    }
  }

  if (pull.mergeable === null) return { kind: 'wait', reason: 'GitHub is still computing mergeability' };
  if (pull.mergeable === false || pull.mergeableState === 'dirty') return { kind: 'wait', reason: 'merge conflict' };

  if (f.checks.failed.length) return { kind: 'wait', reason: `failing: ${f.checks.failed.join(', ')}` };
  if (f.checks.pending.length) return { kind: 'wait', reason: `pending: ${f.checks.pending.join(', ')}` };
  if (f.unresolvedThreads > 0) {
    return { kind: 'wait', reason: `${f.unresolvedThreads} unresolved review thread${f.unresolvedThreads === 1 ? '' : 's'}` };
  }

  // A check that never ran proves nothing. An empty list is fine only where the repo runs no
  // validation by decision; anywhere else it may be CI that never started.
  const gate = checkGate(f);
  if (gate.blocking.length) {
    return { kind: 'ask', sha, review, by, why: `checks did not run: ${gate.blocking.join(', ')}` };
  }
  if (f.checks.total === 0 && !f.noCi) {
    return { kind: 'ask', sha, review, by, why: 'no check ran on the head' };
  }

  if (onHead?.verdict === 'escalate') {
    return { kind: 'ask', sha, review, by, why: 'Codex escalated it to you' };
  }
  if (f.classification.tier === 2) return { kind: 'ask', sha, review, by, why: 'tier 2' };
  return { kind: 'merge', sha, review, by };
}

/**
 * Whether the head may go on without a Codex review (PET-751), and how. Only tiers 0 and 1,
 * and only once Codex is out: its queue failed for this head, or it stayed silent past
 * `afterMs`. Tier 0 then rides on CI. Tier 1 needs a clean Qwen pass, which can hold a PR
 * and never widens what merges. Tier 2 never falls back.
 */
function fallbackFor(f: Facts, sha: string): 'qwen' | 'ci' | null {
  if (!f.fallback?.enabled) return null;
  const tier = f.classification.tier;
  if (tier > 1) return null;
  const m = f.memory;
  const now = f.now ?? Date.now();
  // No queuedAt means no timer: the desk stamps it on the next read, so the clock starts then.
  const waited = m.queuedSha === sha && m.queuedAt ? now - (Date.parse(m.queuedAt) || now) : 0;
  // One failed queue call can be a network blip, so a failure counts only after a short grace.
  const failed = m.queueFailedSha === sha && waited >= FAILED_GRACE_MS;
  const silent = m.queuedSha === sha && waited >= f.fallback.afterMs;
  if (!failed && !silent) return null;
  return tier === 0 ? 'ci' : 'qwen';
}
