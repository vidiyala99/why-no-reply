// Read-only AgentMail client: GET requests only, to api.agentmail.to or api.agentmail.eu only.
// The API key is sent in the Authorization header and is never logged, echoed or written.
import type { Subscriber, Message, SelfKey, Snapshot, Listing, SubscriberSource } from "./types.ts";

export const DEFAULT_BASE = "https://api.agentmail.to/v0";
const ALLOWED_HOSTS = new Set(["api.agentmail.to", "api.agentmail.eu"]);
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface Res { status: number; body: any }

export interface GatherOptions {
  key: string;
  fetch: FetchLike;
  inbox: string;
  since: string;
  until: string;
  messageId?: string;
  base?: string;
}
export type GatherResult = Snapshot | { error: { exit: 2; message: string } };

export function toSubscriber(raw: any, kind: "webhook" | "polling"): Subscriber {
  let host: string | undefined;
  if (typeof raw.url === "string") {
    try { host = new URL(raw.url).host; } catch { host = undefined; }
  }
  const s: Subscriber = {
    kind,
    webhook_id: String(raw.webhook_id),
    enabled: kind === "polling" ? true : raw.enabled !== false,
    event_types: Array.isArray(raw.event_types) ? raw.event_types : [],
    inbox_ids: Array.isArray(raw.inbox_ids) ? raw.inbox_ids : [],
    pod_ids: Array.isArray(raw.pod_ids) ? raw.pod_ids : [],
    created_at: raw.created_at,
    updated_at: raw.updated_at ?? raw.created_at,
  };
  if (raw.inbox_id) s.inbox_id = raw.inbox_id;
  if (raw.pod_id) s.pod_id = raw.pod_id;
  if (host) s.host = host;
  return s;
}

export function toMessage(raw: any): Message {
  const m: Message = {
    inbox_id: raw.inbox_id,
    message_id: raw.message_id,
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    timestamp: raw.timestamp,
  };
  if (raw.created_at) m.created_at = raw.created_at;
  if (raw.subject !== undefined) m.subject = raw.subject;
  if (raw.from !== undefined) m.from = raw.from;
  return m;
}

/** Find this key in GET /api-keys by its public prefix (compared locally; nothing about the key is sent). */
export function toSelfKey(res: Res, key: string): SelfKey {
  if (res.status !== 200) return { status: "unknown", why: `GET /api-keys answered ${res.status}${res.body?.code ? ` ${res.body.code}` : ""}` };
  const keys: any[] = Array.isArray(res.body?.api_keys) ? res.body.api_keys : [];
  const match = keys
    .filter((k) => typeof k.prefix === "string" && k.prefix.length >= 4 && key.startsWith(k.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!match) return { status: "unknown", why: "this key is not in GET /api-keys" };
  return { status: "found", api_key_id: match.api_key_id, permissions: match.permissions ?? null };
}

/** Sum every message.received* bucket of a metrics/events response. */
export function sumReceived(body: any): number {
  let n = 0;
  for (const [type, buckets] of Object.entries(body ?? {})) {
    if (!type.startsWith("message.received") || !Array.isArray(buckets)) continue;
    for (const b of buckets as any[]) n += Number(b?.count) || 0;
  }
  return n;
}

export async function gather(o: GatherOptions): Promise<GatherResult> {
  const base = o.base ?? DEFAULT_BASE;
  let host: string;
  try { host = new URL(base).host; } catch { host = ""; }
  if (!ALLOWED_HOSTS.has(host) || !base.startsWith("https://")) {
    return { error: { exit: 2, message: `refusing base URL ${base}: only https://api.agentmail.to or https://api.agentmail.eu` } };
  }

  const get = async (path: string, query: Record<string, string> = {}): Promise<Res> => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const r = await o.fetch(u.toString(), { method: "GET", headers: { Authorization: `Bearer ${o.key}`, Accept: "application/json" } });
    const text = await r.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body };
  };
  const enc = encodeURIComponent;
  let truncated = false;

  const listAll = async <T>(path: string, field: string, map: (x: any) => T, query: Record<string, string> = {}): Promise<Listing<T>> => {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await get(path, { limit: String(PAGE_LIMIT), ...query, ...(token ? { page_token: token } : {}) });
      if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code };
      for (const x of r.body?.[field] ?? []) items.push(map(x));
      token = r.body?.next_page_token;
      if (!token) return { ok: true, items };
    }
    truncated = true;
    return { ok: true, items };
  };

  const inboxRes = await get(`/inboxes/${enc(o.inbox)}`);
  if (inboxRes.status === 401 || inboxRes.status === 403) {
    return { error: { exit: 2, message: `GET /inboxes/${o.inbox} answered ${inboxRes.status}${inboxRes.body?.code ? ` ${inboxRes.body.code}` : ""}: check AGENTMAIL_API_KEY and its scope` } };
  }
  if (inboxRes.status !== 200) {
    return { error: { exit: 2, message: `GET /inboxes/${o.inbox} answered ${inboxRes.status}: inbox not found or not visible to this key` } };
  }
  const inbox = { inbox_id: inboxRes.body.inbox_id ?? o.inbox, pod_id: inboxRes.body.pod_id, created_at: inboxRes.body.created_at };

  const routes: [string, "webhook" | "polling"][] = [["/webhooks", "webhook"], ["/webhooks/polling", "polling"]];
  if (inbox.pod_id) routes.push([`/pods/${enc(inbox.pod_id)}/webhooks`, "webhook"], [`/pods/${enc(inbox.pod_id)}/webhooks/polling`, "polling"]);
  routes.push([`/inboxes/${enc(inbox.inbox_id)}/webhooks`, "webhook"], [`/inboxes/${enc(inbox.inbox_id)}/webhooks/polling`, "polling"]);
  const subscribers: SubscriberSource[] = [];
  for (const [path, kind] of routes) {
    subscribers.push({
      source: `GET ${decodeURIComponent(path)}`,
      listing: await listAll(path, kind === "polling" ? "polling_webhooks" : "webhooks", (x) => toSubscriber(x, kind)),
    });
  }

  const selfKey = toSelfKey(await get("/api-keys"), o.key);
  const msgPath = `/inboxes/${enc(inbox.inbox_id)}/messages`;
  const snap: Snapshot = {
    inbox,
    window: { since: o.since, until: o.until },
    subscribers,
    messagesDefault: { ok: true, items: [] },
    messagesInclude: { ok: true, items: [] },
    metricsReceived: null,
    selfKey,
    truncated: false,
  };

  if (o.messageId) {
    const r = await get(`${msgPath}/${enc(o.messageId)}`);
    if (r.status === 200) {
      const m = toMessage(r.body);
      snap.messagesDefault = { ok: true, items: [m] };
      snap.messagesInclude = { ok: true, items: [m] };
      snap.target = { message_id: o.messageId, found: true };
    } else {
      snap.target = { message_id: o.messageId, found: false, status: r.status, code: r.body?.code };
    }
    return snap;
  }

  const window = { after: o.since, before: o.until, ascending: "true" };
  snap.messagesDefault = await listAll(msgPath, "messages", toMessage, window);
  snap.messagesInclude = await listAll(msgPath, "messages", toMessage, {
    ...window, include_spam: "true", include_blocked: "true", include_unauthenticated: "true",
  });
  // metrics/events: start must be within the last 90 days (api-reference/inboxes/metrics/query-events).
  if (new Date(o.until).getTime() - new Date(o.since).getTime() <= 89 * 86400_000) {
    const metrics = await get(`/inboxes/${enc(inbox.inbox_id)}/metrics/events`, { start: o.since, end: o.until });
    snap.metricsReceived = metrics.status === 200 ? sumReceived(metrics.body) : null;
  }
  snap.truncated = truncated;
  return snap;
}
