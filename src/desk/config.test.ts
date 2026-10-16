/** The merge desk's settings (PET-645): a bad one turns the desk off, never on. */
import { describe, it, expect } from 'bun:test';
import { loadDeskSettings, type DeskEnv } from './config.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';
const good: DeskEnv = {
  DESK_MODE: 'on',
  DESK_REPOS: 'petedio-workspace, petedio-vault',
  DESK_AUTHORS: 'petedillo',
  DESK_APP_ID: '12345',
  DESK_INSTALLATION_ID: '67890',
  DESK_APP_KEY_PATH: '/etc/pete-bot/desk-app.pem',
  DESK_STATE_PATH: '/var/lib/pete-bot/desk.sqlite',
  DESK_CODEX_SSH_TARGET: 'codex@192.168.50.248',
  DESK_CODEX_SSH_KEY: '/etc/pete-bot/codex_ed25519',
  DESK_CODEX_KNOWN_HOSTS: '/etc/pete-bot/codex_known_hosts',
};
const load = (env: DeskEnv, key = PEM) => loadDeskSettings(env, () => key);

describe('loadDeskSettings', () => {
  it('is off when DESK_MODE is empty or off', () => {
    expect(load({}).state).toBe('off');
    expect(load({ ...good, DESK_MODE: 'off' }).state).toBe('off');
  });

  it('reads a complete set', () => {
    const s = load(good);
    expect(s.state).toBe('ready');
    if (s.state !== 'ready') return;
    expect(s.settings.repos).toEqual(['petedio-workspace', 'petedio-vault']);
    expect(s.settings.mode).toBe('on');
    expect(s.settings.classifierRepo).toBe('petedio-iac');
    expect(s.settings.pollMs).toBe(180_000);
  });

  it.each([
    ['an unknown mode', { DESK_MODE: 'yes' }, 'DESK_MODE'],
    ['no repos', { DESK_REPOS: '' }, 'DESK_REPOS'],
    ['a repo with an owner', { DESK_REPOS: 'PeteDio-Labs/x' }, 'DESK_REPOS'],
    ['no authors', { DESK_AUTHORS: ' , ' }, 'DESK_AUTHORS'],
    ['a non-numeric App id', { DESK_APP_ID: 'abc' }, 'DESK_APP_ID'],
    ['no state path', { DESK_STATE_PATH: '' }, 'DESK_STATE_PATH'],
    ['a bad ssh target', { DESK_CODEX_SSH_TARGET: '192.168.50.248' }, 'DESK_CODEX_SSH_TARGET'],
    ['no known_hosts', { DESK_CODEX_KNOWN_HOSTS: '' }, 'DESK_CODEX_KNOWN_HOSTS'],
    ['a fast poll', { DESK_POLL_MS: '1000' }, 'DESK_POLL_MS'],
  ])('is misconfigured with %s', (_n, over, field) => {
    const s = load({ ...good, ...over });
    expect(s.state).toBe('misconfigured');
    if (s.state === 'misconfigured') expect(s.reason).toContain(field);
  });

  it('is misconfigured when the key cannot be read or is not a key', () => {
    const missing = loadDeskSettings(good, () => {
      throw new Error('ENOENT');
    });
    expect(missing).toMatchObject({ state: 'misconfigured' });
    expect(load(good, 'not a key')).toMatchObject({ state: 'misconfigured' });
  });
});
