/**
 * The dashboard API for AWS: one Lambda behind an API Gateway HTTP API, one DynamoDB table.
 *
 *   GET  /api/dashboard       the DashboardData the SPA reads (Cognito JWT, checked by the gateway)
 *   GET  /api/health          public, for the Route 53 health check. Reads one item and returns no data.
 *   POST /api/switch          writes a switch request and answers 202. It dispatches nothing.
 *   POST /api/ingest/status   one watchdog record (IAM, checked by the gateway)
 *   POST /api/ingest/section  one report section: needs, alerts, cve, plane, history, triage, services (IAM)
 *
 * ⚠ THIS FUNCTION NEVER STAMPS A CHECK TIME. `checkedAt` is what the watchdog wrote. The SPA decides
 * "stale" from it, so a dead watchdog ages into `unknown` instead of being refreshed to look healthy here.
 * An ingest that dates a record more than FUTURE_MS ahead is refused: a future date would stay "fresh" for good.
 *
 * ⚠ A SWITCH REQUEST IS A ROW, NOT A SWITCH. Moving traffic waits for Pedro's lab-write tap elsewhere.
 * This route refuses a pinned service and an unknown one, and records the rest with status `requested`.
 *
 * Table `dash`, keys pk and sk (strings), TTL attribute `expires` (epoch seconds):
 *   status   pk "<service>#<side>"   sk "status"   ok, checkedAt, detail, lagS, expires
 *   section  pk "section#<name>"     sk "latest"   body (JSON text), at
 *   switch   pk "switch#<service>"   sk <ISO time> to, status, expires
 */
export interface Db {
  get(pk: string, sk: string): Promise<Record<string, unknown> | null>;
  put(item: Record<string, unknown>): Promise<void>;
}

export interface Req {
  method: string;
  path: string;
  body: string | null;
}
export interface Res {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const SECTIONS = ['needs', 'alerts', 'cve', 'plane', 'history', 'triage', 'services'] as const;
const SIDES = ['lab', 'cloud'] as const;
export const FUTURE_MS = 5 * 60_000;
const MAX_BODY = 200_000;
const SWITCH_TTL_S = 7 * 24 * 3600;
/** A status row for a removed service expires after 30 days. A live watchdog rewrites its row long before. */
const STATUS_TTL_S = 30 * 24 * 3600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const reply = (statusCode: number, body: unknown): Res => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: JSON.stringify(body),
});

function json(body: string | null): unknown {
  if (body === null || body.length > MAX_BODY) throw new Error('body missing or too large');
  return JSON.parse(body);
}

async function section(db: Db, name: string): Promise<unknown> {
  const item = await db.get(`section#${name}`, 'latest');
  if (!item || typeof item.body !== 'string') return null;
  try {
    return JSON.parse(item.body);
  } catch {
    return null;
  }
}

export async function handle(req: Req, db: Db, now: () => number = Date.now): Promise<Res> {
  try {
    if (req.method === 'GET' && req.path === '/api/health') {
      // A read that throws is a 500 below, so the check goes red when the table cannot be read. It returns no data.
      await db.get('health#probe', 'ok');
      return reply(200, { ok: true });
    }
    if (req.method === 'GET' && req.path === '/api/dashboard') return await dashboard(db, now);
    if (req.method === 'POST' && req.path === '/api/ingest/status') return await ingestStatus(req, db, now);
    if (req.method === 'POST' && req.path === '/api/ingest/section') return await ingestSection(req, db, now);
    if (req.method === 'POST' && req.path === '/api/switch') return await requestSwitch(req, db, now);
    return reply(404, { error: 'not found' });
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message === 'body missing or too large')) return reply(400, { error: 'bad body' });
    // The message may carry table names or ARNs, so it goes to the log, not the caller.
    console.error(`dashboard api: ${err instanceof Error ? err.message : String(err)}`);
    return reply(500, { error: 'server error' });
  }
}

async function dashboard(db: Db, now: () => number): Promise<Res> {
  const out: Record<string, unknown> = { generatedAt: new Date(now()).toISOString(), source: 'aws' };
  for (const name of SECTIONS) if (name !== 'services') out[name] = await section(db, name);
  const registry = await section(db, 'services');
  const services: unknown[] = [];
  if (Array.isArray(registry)) {
    for (const r of registry) {
      if (!isObj(r) || typeof r.name !== 'string' || !NAME.test(r.name)) continue;
      const row: Record<string, unknown> = { ...r };
      const reads = await Promise.all(SIDES.map((side) => db.get(`${r.name}#${side}`, 'status')));
      SIDES.forEach((side, i) => {
        const s = reads[i];
        // A missing item stays null, and the SPA shows it as unknown.
        row[side] = s ? { ok: s.ok === true, checkedAt: s.checkedAt, detail: s.detail ?? '', lagS: typeof s.lagS === 'number' ? s.lagS : null } : null;
      });
      services.push(row);
    }
  }
  out.services = services;
  return reply(200, out);
}

async function ingestStatus(req: Req, db: Db, now: () => number): Promise<Res> {
  const b = json(req.body);
  if (!isObj(b)) return reply(400, { error: 'bad body' });
  const { service, side, ok, checkedAt, detail, lagS } = b;
  if (typeof service !== 'string' || !NAME.test(service)) return reply(400, { error: 'service must be a lowercase name' });
  if (side !== 'lab' && side !== 'cloud') return reply(400, { error: 'side must be lab or cloud' });
  if (typeof ok !== 'boolean') return reply(400, { error: 'ok must be a boolean' });
  const at = typeof checkedAt === 'string' ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(at)) return reply(400, { error: 'checkedAt must be an ISO time' });
  if (at > now() + FUTURE_MS) return reply(400, { error: 'checkedAt is in the future' });
  if (lagS !== undefined && lagS !== null && (typeof lagS !== 'number' || !Number.isFinite(lagS) || lagS < 0)) return reply(400, { error: 'lagS must be a number of seconds or null' });
  await db.put({ pk: `${service}#${side}`, sk: 'status', ok, checkedAt: new Date(at).toISOString(), detail: typeof detail === 'string' ? detail.slice(0, 200) : '', lagS: lagS ?? null, expires: Math.floor(now() / 1000) + STATUS_TTL_S });
  return reply(200, { ok: true });
}

async function ingestSection(req: Req, db: Db, now: () => number): Promise<Res> {
  const b = json(req.body);
  if (!isObj(b)) return reply(400, { error: 'bad body' });
  if (typeof b.name !== 'string' || !(SECTIONS as readonly string[]).includes(b.name)) return reply(400, { error: `name must be one of ${SECTIONS.join(', ')}` });
  if (b.body === undefined || b.body === null || typeof b.body !== 'object') return reply(400, { error: 'body must be an object or a list' });
  await db.put({ pk: `section#${b.name}`, sk: 'latest', body: JSON.stringify(b.body), at: new Date(now()).toISOString() });
  return reply(200, { ok: true });
}

async function requestSwitch(req: Req, db: Db, now: () => number): Promise<Res> {
  const b = json(req.body);
  if (!isObj(b) || typeof b.service !== 'string' || !NAME.test(b.service)) return reply(400, { error: 'service must be a lowercase name' });
  if (b.to !== 'lab' && b.to !== 'cloud') return reply(400, { error: 'to must be lab or cloud' });
  const registry = await section(db, 'services');
  const svc = Array.isArray(registry) ? registry.find((r) => isObj(r) && r.name === b.service) : undefined;
  if (!isObj(svc)) return reply(404, { error: 'unknown service', message: 'That service is not in the registry.' });
  if (svc.pinned === true) return reply(409, { error: 'pinned', message: 'That service is pinned on-prem and does not move.' });
  if (svc.active === b.to) return reply(409, { error: 'already active', message: `Already active on ${b.to === 'cloud' ? 'cloud' : 'on-prem'}.` });
  const at = new Date(now()).toISOString();
  await db.put({ pk: `switch#${b.service}`, sk: at, to: b.to, status: 'requested', expires: Math.floor(now() / 1000) + SWITCH_TTL_S });
  return reply(202, { ok: true, message: 'Request recorded. Nothing has moved: the switch waits for the lab-write tap.' });
}

/** The Lambda entry. API Gateway HTTP API payload v2. */
export async function handler(event: { rawPath?: string; body?: string; isBase64Encoded?: boolean; requestContext?: { http?: { method?: string } } }): Promise<Res> {
  const db = await dynamoDb(process.env.TABLE_NAME ?? '');
  const raw = event.body ?? null;
  const body = raw !== null && event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  return handle({ method: event.requestContext?.http?.method ?? '', path: event.rawPath ?? '', body }, db);
}

let cached: Db | null = null;
async function dynamoDb(table: string): Promise<Db> {
  if (!table) throw new Error('TABLE_NAME is not set');
  if (cached) return cached;
  // The AWS SDK v3 ships with the Node 22 Lambda runtime, so the bundle leaves it external.
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  cached = {
    async get(pk, sk) {
      const r = await doc.send(new GetCommand({ TableName: table, Key: { pk, sk } }));
      return (r.Item as Record<string, unknown> | undefined) ?? null;
    },
    async put(item) {
      await doc.send(new PutCommand({ TableName: table, Item: item }));
    },
  };
  return cached;
}
