/**
 * The merge desk (PET-645): queue Codex, merge tiers 0 and 1, and ask Pedro for one tap on
 * the rest.
 *
 * WHY IT POLLS. pete-bot runs on the LAN with no inbound route, and a webhook would need
 * one. A Codex review takes minutes, so a poll every three minutes costs nothing a
 * webhook would save. Each poll reads every open PR in DESK_REPOS and decides each one
 * from facts (src/desk/decide.ts).
 *
 * WHAT IT SAYS. A failed merge, a failed Codex queue and the two-round stop each post one
 * comment on the PR and one DM, because each needs Pedro to act. A merge posts the PR
 * comment only: a DM that needs no action is noise (PET-704). Each is saved before it is
 * sent and retried until it lands. A PR that is waiting on CI, Codex or a thread is
 * logged and nothing else: those states are visible on the PR already.
 *
 * ⚠ A FAILURE IS NEVER SILENT, AND NEVER A MERGE. Any error reading a PR stops that PR's
 * evaluation for this poll. The desk merges only when every fact was read on this poll.
 *
 * ⚠ THE MERGE IS PINNED TO THE REVIEWED HEAD. GitHub refuses a merge whose `sha` is not
 * the head, so a push after the review can never ride along with it.
 */
import type { CodexQueue, QueueResult } from './codex.js';
import { codexReviews } from './codex.js';
import type { ClassifierSource, RunPython } from './classify.js';
import { classify } from './classify.js';
import { decide, blockingRounds, MAX_ROUNDS, type Decision, type Facts } from './decide.js';
import type { DeskSettings } from './config.js';
import type { GitHubApp } from './github.js';
import type { DeskStore, Outgoing } from './store.js';

export interface Button {
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
}

export interface Notifier {
  /** One DM to the owner. */
  dm(content: string, buttons?: Button[]): Promise<void>;
}

export interface DeskLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface DeskDeps {
  settings: DeskSettings;
  github: GitHubApp;
  codex: CodexQueue;
  store: DeskStore;
  notifier: Notifier;
  log: DeskLog;
  runPython?: RunPython;
}

export interface DeskStatus {
  mode: DeskSettings['mode'];
  repos: string[];
  lastPollAt: string | null;
  lastPollError: string | null;
  /** PRs read on the last poll, so "nothing to merge" and "read nothing" differ. */
  lastPollPrs: number;
  merged: number;
}

export const BUTTON_PREFIX = 'desk';

export function buttonId(action: 'merge' | 'again', repo: string, n: number, sha: string): string {
  return `${BUTTON_PREFIX}:${action}:${repo}:${n}:${sha}`;
}

export function parseButtonId(id: string): { action: 'merge' | 'again'; repo: string; n: number; sha: string } | null {
  const m = /^desk:(merge|again):([a-z0-9-]+):([1-9][0-9]{0,5}):([0-9a-f]{40})$/.exec(id);
  if (!m) return null;
  return { action: m[1] as 'merge' | 'again', repo: m[2]!, n: Number(m[3]), sha: m[4]! };
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Paths the classifier on the default branch must grade tier 2 before the desk trusts any
 * lower tier. The desk runs whatever rules are on main, so until the rules that guard the
 * desk itself are there, every PR waits for Pedro. Each canary is a path, not a copy of a
 * rule: the rules keep one home in petedio-iac.
 */
export const TIER2_CANARIES = [
  'scripts/pr-blast-radius.py',
  'scripts/seed-desk-canary.sh',
  'scripts/reseed-desk-canary.sh',
  'scripts/vault-seed.sh',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/hooks/desk-canary.sh',
  '.claude/rules/desk-canary.md',
  'Claude/working-agreement.md',
];

export class MergeDesk {
  private readonly busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly state: DeskStatus;
  private readonly cache = new Map<string, Promise<unknown>>();
  /** The delivery running for each PR, so the next one waits for it. */
  private readonly delivering = new Map<string, Promise<void>>();
  /** Queue calls in flight, so tests and shutdown can wait for them. */
  readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: DeskDeps) {
    this.state = {
      mode: deps.settings.mode,
      repos: deps.settings.repos,
      lastPollAt: null,
      lastPollError: null,
      lastPollPrs: 0,
      merged: 0,
    };
  }

  status(): DeskStatus {
    return { ...this.state };
  }

  start(): void {
    const tick = () => {
      this.poll().catch((err) => this.deps.log.error(`merge desk: poll failed: ${String(err)}`));
    };
    void this.recoverOrphans()
      .catch((err) => this.deps.log.error(`merge desk: recovering interrupted queues: ${String(err)}`))
      .finally(tick);
    this.timer = setInterval(tick, this.deps.settings.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Values read once per poll: default branches, the classifier, each repo's workflows. */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      this.cache.set(key, hit);
      hit.catch(() => this.cache.delete(key));
    }
    return hit;
  }

  private defaultBranch(repo: string): Promise<string> {
    return this.cached(`branch:${repo}`, () => this.deps.github.defaultBranch(repo));
  }

  private classifierSource(): ClassifierSource {
    const { github, settings } = this.deps;
    return {
      classifier: () =>
        this.cached('classifier', async () => {
          const branch = await this.defaultBranch(settings.classifierRepo);
          const text = await github.fileText(settings.classifierRepo, settings.classifierPath, branch);
          if (!text) throw new Error(`${settings.classifierRepo}:${settings.classifierPath} is missing on ${branch}`);
          return text;
        }),
      workflows: (repo) =>
        this.cached(`workflows:${repo}`, async () => {
          const branch = await this.defaultBranch(repo);
          const out: Record<string, string> = {};
          for (const name of await github.listDir(repo, '.github/workflows', branch)) {
            if (!/\.ya?ml$/.test(name)) continue;
            const text = await github.fileText(repo, `.github/workflows/${name}`, branch);
            if (text !== null) out[name] = text;
          }
          return out;
        }),
    };
  }

  /** Null when the rules on main grade every canary tier 2; otherwise the first gap. */
  private rulesGap(): Promise<string | null> {
    const { settings } = this.deps;
    return this.cached('canaries', async () => {
      for (const path of TIER2_CANARIES) {
        const c = await classify(settings.classifierRepo, [{ path }], this.classifierSource(), settings.python, this.deps.runPython);
        if (c.tier !== 2) return `the rules on ${settings.classifierRepo} main grade ${path} tier ${c.tier}, not 2, so the desk treats every PR as tier 2`;
      }
      return null;
    });
  }

  /**
   * A queue call that was running when the last process stopped never reports. Mark each
   * one failed and say so once, with a button to queue it again.
   */
  async recoverOrphans(): Promise<void> {
    const { store, log } = this.deps;
    for (const { repo, n, memory } of store.entries()) {
      if (!memory.queueRunning || !memory.queuedSha) continue;
      store.update(repo, n, { queueRunning: false });
      log.warn(`merge desk: the Codex queue for ${repo}#${n} at ${short(memory.queuedSha)} was running when pete-bot stopped`);
      await this.reportQueueFailure(repo, n, memory.queuedSha, 'pete-bot restarted while it ran', '').catch((err) =>
        log.error(`merge desk: reporting the interrupted queue for ${repo}#${n}: ${String(err)}`),
      );
    }
  }

  /** Saves a report, then tries to send it. A part that fails stays saved for the next poll. */
  private async report(repo: string, n: number, out: Omit<Outgoing, 'id'>): Promise<void> {
    const { store, log } = this.deps;
    const item: Outgoing = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...out };
    store.update(repo, n, { outbox: [...(store.get(repo, n).outbox ?? []), item] });
    await this.deliver(repo, n).catch((err) => log.warn(`merge desk: a report on ${repo}#${n} failed; the next poll retries it: ${String(err)}`));
  }

  /**
   * Sends what the desk still owes one PR. Calls for one PR run one after another, so a
   * queue result and a poll can't both send the same saved report before either clears it.
   */
  private deliver(repo: string, n: number): Promise<void> {
    const key = `${repo}#${n}`;
    const next = (this.delivering.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.drain(repo, n));
    this.delivering.set(key, next);
    next
      .finally(() => {
        if (this.delivering.get(key) === next) this.delivering.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  /** Sends the saved reports, oldest first. Each part is cleared once it lands. */
  private async drain(repo: string, n: number): Promise<void> {
    const { store, github, notifier } = this.deps;
    const clear = (id: string, part: Partial<Outgoing> | null) => {
      const outbox = (store.get(repo, n).outbox ?? []).flatMap((o) =>
        o.id !== id ? [o] : part === null ? [] : [{ ...o, ...part }],
      );
      store.update(repo, n, { outbox: outbox.length ? outbox : undefined });
    };
    for (const item of store.get(repo, n).outbox ?? []) {
      if (item.comment) {
        await github.comment(repo, n, item.comment);
        clear(item.id, { comment: undefined });
      }
      if (item.dm) await notifier.dm(item.dm, item.buttons);
      clear(item.id, null);
    }
  }

  private async deliverPending(errors: string[]): Promise<void> {
    for (const { repo, n, memory } of this.deps.store.entries()) {
      if (!memory.outbox?.length) continue;
      await this.deliver(repo, n).catch((err) => errors.push(`${repo}#${n}: delivering a report: ${String(err)}`));
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.cache.clear();
    let prs = 0;
    const errors: string[] = [];
    try {
      await this.deliverPending(errors);
      for (const repo of this.deps.settings.repos) {
        let pulls;
        try {
          pulls = await this.deps.github.listOpenPulls(repo);
        } catch (err) {
          errors.push(`${repo}: ${String(err)}`);
          continue;
        }
        for (const pull of pulls) {
          prs++;
          try {
            await this.evaluate(repo, pull.number);
          } catch (err) {
            errors.push(`${repo}#${pull.number}: ${String(err)}`);
          }
        }
      }
    } finally {
      this.polling = false;
      this.state.lastPollAt = new Date().toISOString();
      this.state.lastPollPrs = prs;
      this.state.lastPollError = errors.length ? errors.slice(0, 3).join('; ').slice(0, 500) : null;
      for (const e of errors) this.deps.log.warn(`merge desk: ${e}`);
      this.deps.log.info(`merge desk: read ${prs} open PRs in ${this.deps.settings.repos.length} repos, ${errors.length} errors`);
    }
  }

  private async facts(repo: string, n: number): Promise<Facts> {
    const { github, settings, store } = this.deps;
    const pull = await github.getPull(repo, n);
    const [defaultBranch, files, reviews, checks, unresolvedThreads] = await Promise.all([
      this.defaultBranch(repo),
      github.listFiles(repo, n),
      github.listReviews(repo, n),
      github.checks(repo, pull.headSha),
      github.unresolvedThreads(repo, n),
    ]);
    let classification = await classify(repo, files, this.classifierSource(), settings.python, this.deps.runPython);
    if (classification.tier < 2) {
      const gap = await this.rulesGap();
      if (gap) classification = { ...classification, tier: 2, reasons: [gap, ...classification.reasons] };
    }
    return {
      repoFullName: `${settings.org}/${repo}`,
      defaultBranch,
      authors: settings.authors,
      noCi: settings.noCiRepos.has(repo),
      pull,
      classification,
      codex: codexReviews(reviews),
      checks,
      unresolvedThreads,
      memory: store.get(repo, n),
    };
  }

  /** Reads one PR, decides, and acts. Returns the decision so a tap can explain itself. */
  async evaluate(repo: string, n: number): Promise<Decision> {
    const key = `${repo}#${n}`;
    if (this.busy.has(key)) return { kind: 'wait', reason: 'the desk is already acting on this PR' };
    this.busy.add(key);
    try {
      const f = await this.facts(repo, n);
      const d = decide(f);
      await this.act(repo, f, d);
      return d;
    } finally {
      this.busy.delete(key);
    }
  }

  private link(repo: string, f: Facts): string {
    return `[${repo}#${f.pull.number}](${f.pull.htmlUrl})`;
  }

  private async act(repo: string, f: Facts, d: Decision): Promise<void> {
    const { store, notifier, log, settings } = this.deps;
    const n = f.pull.number;
    const mem = store.get(repo, n);
    switch (d.kind) {
      case 'skip':
      case 'wait':
        log.info(`merge desk: ${repo}#${n} at ${short(f.pull.headSha)}: ${d.kind}, ${d.reason}`);
        return;

      case 'queue': {
        store.update(repo, n, { queuedSha: d.sha, queueRunning: true, queueFailedSha: undefined });
        log.info(`merge desk: queueing Codex (${d.effort}) for ${repo}#${n} at ${short(d.sha)}`);
        const run = this.deps.codex
          .enqueue(repo, n, d.effort)
          .then((r) => this.afterQueue(repo, n, d.sha, r))
          .catch(async (err) => {
            // Whatever broke, the head must not wait forever on a review nobody is running.
            log.error(`merge desk: after the Codex queue for ${repo}#${n}: ${String(err)}`);
            // A newer head may have been queued since. Its state is not this job's to touch.
            if (store.get(repo, n).queuedSha !== d.sha) return;
            store.update(repo, n, { queueRunning: false });
            await this.reportQueueFailure(repo, n, d.sha, 'the desk failed while it checked the result', String(err)).catch((e) =>
              log.error(`merge desk: reporting the queue failure for ${repo}#${n}: ${String(e)}`),
            );
          });
        this.inflight.add(run);
        void run.finally(() => this.inflight.delete(run));
        return;
      }

      case 'stop': {
        if (mem.stopReportedSha === d.sha) return;
        const links = d.rounds.map((r, i) => `[round ${i + 1}](${r.url}) at \`${short(r.commitId)}\``).join(', ');
        // Recorded first: the outbox owns the comment and the DM from here, and retries each.
        store.update(repo, n, { stopReportedSha: d.sha });
        await this.report(repo, n, {
          comment: `Merge desk: stopped after ${d.rounds.length} blocking Codex rounds (${links}). A person decides what happens next.`,
          dm: `**Merge desk** · ${this.link(repo, f)} stopped after ${d.rounds.length} blocking Codex rounds: ${links}`,
          buttons: [{ customId: buttonId('again', repo, n, d.sha), label: 'Review again', style: 'secondary' }],
        });
        return;
      }

      case 'ask': {
        if (mem.askedSha === d.sha) return;
        const lines = [
          `**Merge desk** · ${this.link(repo, f)} · ${d.why}`,
          `"${f.pull.title.slice(0, 150)}"`,
          `Codex: [${d.review.verdict}](${d.review.url}) at \`${short(d.sha)}\` · checks: ${f.checks.passed}/${f.checks.total} passed · threads: 0`,
          `tier ${f.classification.tier}, ${f.classification.pathCount} paths: ${f.classification.reasons.slice(0, 3).join('; ').slice(0, 400)}`,
        ];
        await notifier.dm(lines.join('\n'), [
          { customId: buttonId('merge', repo, n, d.sha), label: `Merge ${short(d.sha)}`, style: 'primary' },
        ]);
        store.update(repo, n, { askedSha: d.sha });
        return;
      }

      case 'merge': {
        // GitHub can list a PR as open for a moment after it merged. One merge per PR.
        if (mem.mergedSha) return;
        if (settings.mode === 'dry-run') {
          if (mem.askedSha === d.sha) return;
          await notifier.dm(
            `**Merge desk (dry run)** · would merge ${this.link(repo, f)} at \`${short(d.sha)}\`: tier ${f.classification.tier}, Codex [no blocking findings](${d.review.url}), checks ${f.checks.passed}/${f.checks.total} passed.`,
          );
          store.update(repo, n, { askedSha: d.sha });
          return;
        }
        if (mem.mergeFailedSha === d.sha) {
          // One failed attempt per head. After that the merge waits for a tap, so a
          // refusal GitHub repeats on every poll is reported once, not every three minutes.
          if (mem.askedSha === d.sha) return;
          await notifier.dm(`**Merge desk** · ${this.link(repo, f)}: the automatic merge of \`${short(d.sha)}\` failed once. Tap to try again.`, [
            { customId: buttonId('merge', repo, n, d.sha), label: `Merge ${short(d.sha)}`, style: 'primary' },
          ]);
          store.update(repo, n, { askedSha: d.sha });
          return;
        }
        await this.merge(repo, f, d.sha, `tier ${f.classification.tier}, merged without a tap`);
        return;
      }
    }
  }

  private async afterQueue(repo: string, n: number, sha: string, r: QueueResult): Promise<void> {
    const { store, github, log } = this.deps;
    const mem = store.get(repo, n);
    // A push queued a newer head while this job ran. That job owns the queue state now.
    if (mem.queuedSha !== sha) {
      log.info(`merge desk: the Codex queue for ${repo}#${n} at ${short(sha)} finished after a newer head was queued`);
      return;
    }
    store.update(repo, n, { queueRunning: false });
    if (r.ok) {
      // Codex reviews whatever the head is when it starts. Check it reviewed this one, after
      // any Review again tap, so an old verdict on the same head doesn't count.
      const since = mem.requeueSha === sha ? Date.parse(mem.requeuedAt ?? '') || 0 : 0;
      const reviewed = codexReviews(await github.listReviews(repo, n)).some(
        (x) => x.commitId === sha && Date.parse(x.submittedAt) > since,
      );
      const pull = await github.getPull(repo, n);
      if (reviewed || pull.headSha !== sha) {
        await this.evaluate(repo, n);
        return;
      }
      r = { ok: false, exitCode: 0, tail: `codex-review exited 0, but no Codex review of ${short(sha)} appeared` };
    }
    log.warn(`merge desk: Codex queue for ${repo}#${n} at ${short(sha)} failed: exit ${r.exitCode}`);
    await this.reportQueueFailure(repo, n, sha, `exit ${r.exitCode ?? 'killed'}`, r.tail);
  }

  /** Marks the head's queue failed, then one comment and one DM with a button to queue again. */
  private async reportQueueFailure(repo: string, n: number, sha: string, why: string, tail: string): Promise<void> {
    this.deps.store.update(repo, n, { queueFailedSha: sha });
    const detail = tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : '';
    await this.report(repo, n, {
      comment: `Merge desk: queueing a Codex review of \`${short(sha)}\` failed (${why}). Nothing merges until a review of the head exists.${detail}`,
      dm: `**Merge desk** · Codex queue failed for [${repo}#${n}](https://github.com/${this.deps.settings.org}/${repo}/pull/${n}) at \`${short(sha)}\` (${why}).`,
      buttons: [{ customId: buttonId('again', repo, n, sha), label: 'Review again', style: 'secondary' }],
    });
  }

  private async merge(repo: string, f: Facts, sha: string, how: string): Promise<{ ok: boolean; message: string }> {
    const { github, store } = this.deps;
    const n = f.pull.number;
    const evidence = `tier ${f.classification.tier}; Codex ${f.codex.find((r) => r.commitId === sha)?.verdict ?? 'unknown'} at ${short(sha)}; ${f.checks.passed}/${f.checks.total} checks passed; 0 open threads`;
    // The approval satisfies a required review where one exists, and records the evidence
    // where none does.
    const fail = async (why: string) => {
      const msg = `Merge desk: merging \`${short(sha)}\` failed: ${why}`;
      store.update(repo, n, { mergeFailedSha: sha });
      await this.report(repo, n, { comment: msg, dm: `**Merge desk** · ${this.link(repo, f)}: merge failed: ${why.slice(0, 200)}` });
      return { ok: false, message: msg };
    };
    try {
      await github.approve(repo, n, sha, `Merge desk: ${evidence}.`);
    } catch (err) {
      return fail(`the approval was refused: ${String(err)}`);
    }
    let result: Awaited<ReturnType<GitHubApp['merge']>>;
    try {
      result = await github.merge(repo, n, sha, f.pull.title);
    } catch (err) {
      // A timed-out request may still have merged. Read the PR before calling it failed.
      const after = await github.getPull(repo, n).catch(() => null);
      if (!after?.merged || !after.mergeCommitSha || after.headSha !== sha) {
        return fail(after ? `the merge request failed and the PR is not merged: ${String(err)}` : `the merge request failed, and reading the PR back failed too: ${String(err)}`);
      }
      result = { ok: true, sha: after.mergeCommitSha };
    }
    if (!result.ok) return fail(`HTTP ${result.status} ${result.message}`);
    // MERGED is a fact about the PR. This is the fact about the branch.
    let landed = await github.onBranch(repo, result.sha, f.defaultBranch).catch(() => false);
    if (!landed) {
      await new Promise((r) => setTimeout(r, 3000));
      landed = await github.onBranch(repo, result.sha, f.defaultBranch).catch(() => false);
    }
    const where = landed ? `on \`${f.defaultBranch}\`` : `but I could not confirm it is on \`${f.defaultBranch}\``;
    store.update(repo, n, { mergedSha: result.sha });
    this.state.merged++;
    await this.report(repo, n, {
      comment: `Merge desk: merged as \`${short(result.sha)}\` ${where} (${how}; ${evidence}).`,
    });
    return { ok: true, message: `Merged as ${short(result.sha)} ${where}.` };
  }

  /** Pedro tapped a button. Every fact is read again; the tap approves one SHA and no other. */
  async tap(customId: string): Promise<string> {
    const p = parseButtonId(customId);
    if (!p) return 'That button is not one the merge desk sent.';
    if (!this.deps.settings.repos.includes(p.repo)) return `${p.repo} is not on DESK_REPOS.`;
    const key = `${p.repo}#${p.n}`;
    if (this.busy.has(key)) return 'The desk is acting on this PR right now. Tap again in a minute.';

    if (p.action === 'again') {
      const mem = this.deps.store.get(p.repo, p.n);
      const f = await this.facts(p.repo, p.n);
      if (f.pull.headSha !== p.sha) return `The head moved to \`${short(f.pull.headSha)}\`, so this stop no longer applies.`;
      if (mem.queueRunning && mem.queuedSha === p.sha) return 'Codex is already reviewing this head.';
      // Grant a round only when the stop is what holds it; a failed queue needs none.
      const rounds = blockingRounds(f.codex).length;
      const extraRounds = Math.max(mem.extraRounds ?? 0, rounds - MAX_ROUNDS + 1);
      this.deps.store.update(p.repo, p.n, {
        extraRounds,
        stopReportedSha: undefined,
        queuedSha: undefined,
        queueFailedSha: undefined,
        requeueSha: p.sha,
        requeuedAt: new Date().toISOString(),
      });
      const d = await this.evaluate(p.repo, p.n);
      return d.kind === 'queue' ? 'Queued one more Codex round.' : `Granted one more round; the desk says: ${describe(d)}.`;
    }

    this.busy.add(key);
    try {
      const f = await this.facts(p.repo, p.n);
      if (f.pull.headSha !== p.sha) {
        return `Not merged: the head moved from \`${short(p.sha)}\` to \`${short(f.pull.headSha)}\`. Codex reviews the new head first.`;
      }
      const d = decide(f);
      if ((d.kind !== 'ask' && d.kind !== 'merge') || d.sha !== p.sha) return `Not merged: ${describe(d)}.`;
      if (this.deps.settings.mode === 'dry-run') return `Dry run: every gate passed at \`${short(p.sha)}\`, and nothing was merged.`;
      return (await this.merge(p.repo, f, p.sha, 'merged on your tap')).message;
    } finally {
      this.busy.delete(key);
    }
  }
}

function describe(d: Decision): string {
  switch (d.kind) {
    case 'skip':
    case 'wait':
      return d.reason;
    case 'queue':
      return 'no Codex review of the head yet';
    case 'stop':
      return `stopped after ${d.rounds.length} blocking Codex rounds`;
    case 'merge':
    case 'ask':
      return 'ready';
  }
}

