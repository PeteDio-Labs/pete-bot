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
 *                             A skipped check, or no check at all in a repo not on
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
  unresolvedThreads: number;
  memory: PrMemory;
}

export type Decision =
  | { kind: 'skip'; reason: string }
  | { kind: 'queue'; sha: string; effort: Effort }
  | { kind: 'wait'; reason: string }
  | { kind: 'stop'; sha: string; rounds: CodexReview[] }
  | { kind: 'merge'; sha: string; review: CodexReview }
  | { kind: 'ask'; sha: string; review: CodexReview; why: string };

/** Distinct commits Codex blocked, oldest first. */
export function blockingRounds(codex: CodexReview[]): CodexReview[] {
  const seen = new Set<string>();
  return codex
    .filter((r) => r.verdict === 'changes-requested')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .filter((r) => (seen.has(r.commitId) ? false : (seen.add(r.commitId), true)));
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

  if (!onHead) {
    if (rounds.length >= allowed) return { kind: 'stop', sha, rounds };
    if (f.memory.queuedSha === sha) {
      if (f.memory.queueRunning) return { kind: 'wait', reason: 'Codex is reviewing the head' };
      if (f.memory.queueFailedSha === sha) return { kind: 'wait', reason: 'queueing Codex failed for this head' };
      return { kind: 'wait', reason: 'Codex finished but posted no review of the head yet' };
    }
    return { kind: 'queue', sha, effort: effortFor(f.classification.tier) };
  }

  if (onHead.verdict === 'changes-requested') {
    if (rounds.length >= allowed) return { kind: 'stop', sha, rounds };
    return { kind: 'wait', reason: 'Codex requested changes on the head' };
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
  if (f.checks.skipped.length) {
    return { kind: 'ask', sha, review: onHead, why: `checks did not run: ${f.checks.skipped.join(', ')}` };
  }
  if (f.checks.total === 0 && !f.noCi) {
    return { kind: 'ask', sha, review: onHead, why: 'no check ran on the head' };
  }

  if (onHead.verdict === 'escalate') {
    return { kind: 'ask', sha, review: onHead, why: 'Codex escalated it to you' };
  }
  if (f.classification.tier === 2) return { kind: 'ask', sha, review: onHead, why: 'tier 2' };
  return { kind: 'merge', sha, review: onHead };
}
