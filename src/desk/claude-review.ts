/**
 * Claude's review as the desk's required review for tier 0 and tier 1 PRs.
 *
 * Claude's review is the review of record. A thread posts it as a PR review or a PR comment
 * whose FIRST LINE is, exactly:
 *
 *   Claude review: No blocking findings at <sha>
 *   Claude review: Changes requested at <sha>
 *
 * `<sha>` is the head the reviewer read, 7 to 40 hex characters. The desk reads only the
 * author login and that first line, never the rest of the body.
 *
 * ⚠ THIS IS AN ATTESTATION, NOT AUTHENTICATION. A thread posts under whichever identity its
 * GitHub connector holds, so the desk cannot tell a real review from a typed line. What it
 * checks is narrow and mechanical: the login is on DESK_CLAUDE_REVIEWERS, it is not the PR
 * author's login (nobody reviews their own PR), and the SHA is the current head, so any
 * push voids the review. A "Changes requested" on the head holds the merge.
 *
 * Tier 2, and any PR with a Codex second opinion queued, still need Codex (decide.ts).
 */
import type { Review } from './github.js';

export type ClaudeVerdict = 'changes-requested' | 'no-blocking';

export interface ClaudeReview {
  verdict: ClaudeVerdict;
  /** The SHA the first line names, lowercase. */
  sha: string;
  author: string;
  url: string;
  at: string;
}

/** A PR comment, as far as the desk reads it. */
export interface PullComment {
  author: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
}

const HEADER = /^(?:#{1,6}\s+)?Claude review: (Changes requested|No blocking findings) at ([0-9a-f]{7,40})\s*$/i;

export function claudeReviewOf(author: string, body: string, url: string, at: string, allowed: ReadonlySet<string>): ClaudeReview | null {
  if (!allowed.has(author.toLowerCase())) return null;
  const first = body.split('\n', 1)[0]?.trim() ?? '';
  const m = HEADER.exec(first);
  if (!m) return null;
  return { verdict: m[1]!.toLowerCase() === 'changes requested' ? 'changes-requested' : 'no-blocking', sha: m[2]!.toLowerCase(), author, url, at };
}

export function claudeReviews(reviews: Review[], comments: PullComment[], allowed: ReadonlySet<string>): ClaudeReview[] {
  return [
    ...reviews.map((r) => claudeReviewOf(r.author, r.body, r.htmlUrl, r.submittedAt, allowed)),
    ...comments.map((c) => claudeReviewOf(c.author, c.body, c.htmlUrl, c.createdAt, allowed)),
  ].filter((r): r is ClaudeReview => r !== null);
}

/** The newest Claude review of exactly this head, by a login other than the PR author. */
export function claudeOnHead(all: ClaudeReview[], headSha: string, prAuthor: string): ClaudeReview | null {
  const head = headSha.toLowerCase();
  return (
    all
      .filter((r) => head.startsWith(r.sha) && r.author.toLowerCase() !== prAuthor.toLowerCase())
      .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
  );
}
