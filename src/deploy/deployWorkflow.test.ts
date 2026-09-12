import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

/**
 * The deploy workflow's secret contract, asserted against the workflow itself.
 *
 * WHY THIS EXISTS. On 2026-09-12 the deploy failed twice in ten minutes on the same
 * missing Vault key, and neither failure was catchable by any test that ran the product.
 * The bug lived in the gap between two layers:
 *
 *   layer 1  the vault-action step that FETCHES a secret
 *   layer 2  the staging script that READS it out of the environment
 *
 * A secret is either required or optional, and both layers have to agree. They did not.
 * `github_updates_token` is documented in README.md as optional — "an empty token leaves
 * /update answering that it is not configured" — and the deploy treated its absence as
 * fatal. The first fix made layer 2 tolerant and left layer 1 fatal. The second split the
 * fetch into a tolerant step, and still failed, because `ignoreNotFound` tolerates a
 * missing PATH and not a missing KEY inside a path that exists.
 *
 * So these tests assert the property, not the mechanism: whatever the workflow does, a
 * secret's optionality must be the same at both layers, and a required secret must be
 * fetched by a step that cannot be skipped.
 */

const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8'),
) as WorkflowFile;

interface VaultStep {
  name: string;
  uses?: string;
  'continue-on-error'?: boolean;
  with: { secrets: string; ignoreNotFound?: boolean };
}
interface RunStep { name: string; run?: string }
type Step = Partial<VaultStep & RunStep>;
interface WorkflowFile { jobs: Record<string, { steps: Step[] }> }

const steps: Step[] = Object.values(workflow.jobs).flatMap((j) => j.steps);
const vaultSteps = steps.filter((s) => String(s.uses ?? '').includes('vault-action')) as VaultStep[];

/** env var name -> the step that fetches it */
const fetchedBy = new Map<string, VaultStep>();
for (const step of vaultSteps) {
  for (const line of step.with.secrets.split(';')) {
    const envVar = line.split('|')[1]?.trim();
    if (envVar) fetchedBy.set(envVar, step);
  }
}

/** A step may fail without failing the job. */
const isTolerant = (s: VaultStep) => s['continue-on-error'] === true;

const stagingRun =
  steps.find((s) => /stage the secrets/i.test(s.name ?? ''))?.run ?? '';

/** Capture group 1 of every match, with the undefined a regex group can yield dropped. */
const captured = (re: RegExp): Set<string> =>
  new Set(
    [...stagingRun.matchAll(re)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined),
  );

/** env vars the staging script reads fatally: os.environ["X"] */
const readRequired = captured(/os\.environ\[["']([A-Z0-9_]+)["']\]/g);
/** env vars it reads with a default: os.environ.get("X", ...) */
const readOptional = captured(/os\.environ\.get\(["']([A-Z0-9_]+)["']/g);

describe('deploy.yml secret contract', () => {
  it('parses, and has at least one vault step and a staging step', () => {
    expect(vaultSteps.length).toBeGreaterThan(0);
    expect(stagingRun).not.toBe('');
    expect(readRequired.size + readOptional.size).toBeGreaterThan(0);
  });

  it('never reads the same variable both fatally and optionally', () => {
    const both = [...readRequired].filter((v) => readOptional.has(v));
    expect(both).toEqual([]);
  });

  it('fetches every secret the staging step reads', () => {
    const missing = [...readRequired, ...readOptional].filter(
      (v) => v !== 'OUT' && v !== 'BIN' && !fetchedBy.has(v),
    );
    expect(missing).toEqual([]);
  });

  // The bug, stated as a property. A variable read with os.environ["X"] aborts the deploy
  // if unset, so the step that fetches it must not be allowed to fail quietly.
  it('fetches every REQUIRED secret in a step that cannot be skipped', () => {
    const offenders = [...readRequired]
      .filter((v) => fetchedBy.has(v))
      .filter((v) => isTolerant(fetchedBy.get(v)!))
      .map((v) => `${v} (fetched by a continue-on-error step but read fatally)`);
    expect(offenders).toEqual([]);
  });

  // The other direction, and the one that actually shipped: a secret the code treats as
  // optional must be fetched by a step whose failure does not stop the deploy.
  it('fetches every OPTIONAL secret in a step that may fail', () => {
    const offenders = [...readOptional]
      .filter((v) => fetchedBy.has(v))
      .filter((v) => !isTolerant(fetchedBy.get(v)!))
      .map((v) => `${v} (read with a default but its fetch step is fatal)`);
    expect(offenders).toEqual([]);
  });

  // Regression lock on the specific case, named so a failure says what broke.
  it('treats github_updates_token as optional at both layers', () => {
    expect(readOptional.has('PB_UPDATES_TOKEN')).toBe(true);
    expect(isTolerant(fetchedBy.get('PB_UPDATES_TOKEN')!)).toBe(true);
  });

  it('keeps discord_token required at both layers', () => {
    expect(readRequired.has('PB_TOKEN')).toBe(true);
    expect(isTolerant(fetchedBy.get('PB_TOKEN')!)).toBe(false);
  });

  // ordering is load-bearing: continue-on-error is only safe on a step that runs AFTER a
  // strict one against the same Vault, or a real outage is swallowed.
  it('runs a strict vault step before any tolerant one', () => {
    const firstTolerant = vaultSteps.findIndex(isTolerant);
    const firstStrict = vaultSteps.findIndex((s) => !isTolerant(s));
    if (firstTolerant !== -1) {
      expect(firstStrict).not.toBe(-1);
      expect(firstStrict).toBeLessThan(firstTolerant);
    }
  });
});
