/**
 * A wire-contract test. These flags are the difference between an app Pedro installs to
 * his own account and a bot that must live in a server — and Discord reports the mistake
 * as a command that simply is not there, never as an error. PET-89's lesson: assert the
 * emitted shape, not the builder that produced it.
 */
import { describe, it, expect } from 'vitest';
import { allCommands } from './index.js';

const USER_INSTALL = 1;
const CONTEXT_PRIVATE_CHANNEL = 2;

describe('command definitions', () => {
  it('registers /ask and /status', () => {
    expect(allCommands.map((c) => c.name).sort()).toEqual(['ask', 'status']);
  });

  it.each(['ask', 'status'])('declares %s as user-installed', (name) => {
    const command = allCommands.find((c) => c.name === name)!;
    expect(command.integration_types).toEqual([USER_INSTALL]);
  });

  it.each(['ask', 'status'])('lets %s run in a private channel', (name) => {
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
});
