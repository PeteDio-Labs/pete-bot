/**
 * A wire-contract test. These flags are the difference between an app Pedro installs to
 * his own account and a bot that must live in a server — and Discord reports the mistake
 * as a command that simply is not there, never as an error. PET-89's lesson: assert the
 * emitted shape, not the builder that produced it.
 */
import { describe, it, expect } from 'vitest';
import { allCommands } from './index.js';
import { UPDATE_TARGETS } from '../../clients/githubActions.js';

const USER_INSTALL = 1;
const CONTEXT_PRIVATE_CHANNEL = 2;

interface OptionShape {
  name: string;
  required?: boolean;
  choices?: Array<{ value: string }>;
  options?: OptionShape[];
}

describe('command definitions', () => {
  it('registers /ask, /status and /update', () => {
    expect(allCommands.map((c) => c.name).sort()).toEqual(['ask', 'status', 'update']);
  });

  it.each(['ask', 'status', 'update'])('declares %s as user-installed', (name) => {
    const command = allCommands.find((c) => c.name === name)!;
    expect(command.integration_types).toEqual([USER_INSTALL]);
  });

  it.each(['ask', 'status', 'update'])('lets %s run in a private channel', (name) => {
    const command = allCommands.find((c) => c.name === name)!;
    expect(command.contexts).toContain(CONTEXT_PRIVATE_CHANNEL);
  });

  it('keeps the question required on /ask', () => {
    const ask = allCommands.find((c) => c.name === 'ask')!;
    expect(ask.options?.[0]).toMatchObject({ name: 'question', required: true });
  });

  it('takes no options on /status', () => {
    const status = allCommands.find((c) => c.name === 'status')!;
    expect(status.options ?? []).toHaveLength(0);
  });

  // PET-395. An apply one option away from a check is the mistake the split prevents.
  it('splits /update into check and apply, and makes apply name its target', () => {
    const update = allCommands.find((c) => c.name === 'update')!;
    const subs = (update.options ?? []) as unknown as OptionShape[];
    expect(subs.map((s) => s.name)).toEqual(['check', 'apply']);

    const apply = subs.find((s) => s.name === 'apply')!;
    expect(apply.options?.find((o) => o.name === 'target')).toMatchObject({ required: true });
    expect(apply.options?.map((o) => o.name)).toEqual(['target', 'force']);

    const check = subs.find((s) => s.name === 'check')!;
    expect(check.options?.map((o) => o.name)).toEqual(['target']);
  });

  it('offers exactly the targets the workflow accepts', () => {
    const update = allCommands.find((c) => c.name === 'update')!;
    const subs = (update.options ?? []) as unknown as OptionShape[];
    for (const sub of subs) {
      const target = sub.options?.find((o) => o.name === 'target');
      expect(target?.choices?.map((c) => c.value)).toEqual([...UPDATE_TARGETS]);
    }
  });
});
