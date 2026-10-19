/**
 * lab-agent's settings (PET-669), checked once at startup.
 *
 * ⚠ A BAD SETTING STOPS lab-agent, AND ONLY lab-agent. Unlike the gateway, which must not
 * take Uptime Kuma's alerts down with it, this process has one job. Starting it with a
 * missing token or clone would answer every /lab with an error that looks like a lab fault,
 * so it refuses to start and systemd shows why.
 *
 * The deploy writes these to /etc/lab-agent/lab-agent.env, 0400 lab-agent (PET-670).
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** 32 base64 characters carry 192 bits. Anything shorter was not minted by the seed script. */
const TOKEN = z.string().min(32, 'must be at least 32 characters').regex(/^\S+$/, 'must not contain whitespace');

const EnvSchema = z.object({
  LAB_PORT: z.coerce.number().int().min(1024).max(65535).default(3016),
  LAB_ASK_TOKEN: TOKEN,
  LAB_GATEWAY_URL: z.string().url().default('http://127.0.0.1:3015/v1/llm'),
  LAB_GATEWAY_TOKEN: TOKEN,
  LAB_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  LAB_PVE_URL: z.string().regex(/^https:\/\//, 'must be https://'),
  LAB_PVE_TOKEN_ID: z.string().regex(/^[^@\s]+@[^!\s]+![^\s=]+$/, 'must look like user@realm!name'),
  LAB_PVE_TOKEN_SECRET: z.string().min(8),
  LAB_PVE_CA_FILE: z.string().min(1).default('/etc/lab-agent/pve-root-ca.pem'),
  LAB_KUMA_URL: z.string().url().default('http://192.168.50.4:3001'),
  LAB_KUMA_SLUG: z.string().min(1).default('fault-study'),
  LAB_VAULT_CLONE: z.string().min(1),
  LAB_IAC_CLONE: z.string().min(1),
  LAB_MEDIA_IAC_CLONE: z.string().min(1),
});

export interface LabConfig {
  port: number;
  askToken: string;
  gateway: { url: string; token: string; model: string };
  proxmox: { baseUrl: string; tokenId: string; tokenSecret: string; caPem: string };
  kuma: { baseUrl: string; slug: string };
  clones: { vault: string; iac: string; mediaIac: string };
}

export function loadLabConfig(env: Record<string, string | undefined>, readFile = (p: string) => readFileSync(p, 'utf8')): LabConfig {
  // An empty variable means unset, so a template that renders "" still hits the default or the error.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith('LAB_') && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Names and rules only, never values: a token can be one of the failing fields.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`lab-agent settings are invalid: ${issues}`);
  }
  const e = parsed.data;
  if (e.LAB_ASK_TOKEN === e.LAB_GATEWAY_TOKEN) throw new Error('lab-agent settings are invalid: LAB_ASK_TOKEN must differ from LAB_GATEWAY_TOKEN');
  let caPem: string;
  try {
    caPem = readFile(e.LAB_PVE_CA_FILE);
  } catch (err) {
    throw new Error(`lab-agent cannot read LAB_PVE_CA_FILE ${e.LAB_PVE_CA_FILE}: ${(err as Error).message}`);
  }
  return {
    port: e.LAB_PORT,
    askToken: e.LAB_ASK_TOKEN,
    gateway: { url: e.LAB_GATEWAY_URL.replace(/\/$/, ''), token: e.LAB_GATEWAY_TOKEN, model: e.LAB_MODEL },
    proxmox: { baseUrl: e.LAB_PVE_URL, tokenId: e.LAB_PVE_TOKEN_ID, tokenSecret: e.LAB_PVE_TOKEN_SECRET, caPem },
    kuma: { baseUrl: e.LAB_KUMA_URL, slug: e.LAB_KUMA_SLUG },
    clones: { vault: e.LAB_VAULT_CLONE, iac: e.LAB_IAC_CLONE, mediaIac: e.LAB_MEDIA_IAC_CLONE },
  };
}
