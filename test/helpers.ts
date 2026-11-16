// Test helpers: build Snapshots and a fake fetch from recorded fixtures.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toSubscriber, toMessage } from "../src/api.ts";
import type { Snapshot, Subscriber, Message } from "../src/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const fixture = (p: string): any => JSON.parse(readFileSync(join(FIX, p), "utf8"));

export const INBOX = "why-no-reply-test@agentmail.to";
export const POD = "pod_default_0001";
export const TEST_KEY = "am_us_testkey_0123456789";
export const SPAM_ID = "<010001a1e5e5ee07-975c0fab-c326-49b9-94df-3c51316c141c-000000@email.amazonses.com>";
export const BLOCKED_ID = "<010001a1e5e64103-203a154d-9e10-4703-9eea-284b1446501e-000000@email.amazonses.com>";
export const NORMAL_ID = "<010001a1e5e59d4e-d51a0807-30e3-44d7-9c94-3fc9b15ba48f-000000@email.amazonses.com>";

export const webhook = (name: string): Subscriber => toSubscriber(fixture("webhooks.json")[name], "webhook");
export const polling = (name: string): Subscriber => toSubscriber(fixture("polling.json")[name], "polling");

export const liveMessages = (which: "default" | "include"): Message[] =>
  fixture(`live/messages_${which}.json`).body.messages.map(toMessage);

export const heldMessage = (extraLabels: string[] = []): Message => ({
  inbox_id: INBOX,
  message_id: "<held-1@example.test>",
  labels: ["received", "unread", "agent-armor-held", ...extraLabels],
  timestamp: "2026-11-16T19:50:00.000Z",
  created_at: "2026-11-16T19:50:01.000Z",
  subject: "held test",
});

/** The live 19:46Z state: 3 received messages, no webhooks, metrics count 3, key has all permissions. */
export function liveSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    inbox: { inbox_id: INBOX, pod_id: POD, created_at: "2026-11-16T19:46:31.641Z" },
    window: { since: "2026-11-16T19:40:00.000Z", until: "2026-11-16T21:00:00.000Z" },
    subscribers: [
      { source: "GET /webhooks", listing: { ok: true, items: [] } },
      { source: "GET /webhooks/polling", listing: { ok: true, items: [] } },
    ],
    messagesDefault: { ok: true, items: liveMessages("default") },
    messagesInclude: { ok: true, items: liveMessages("include") },
    metricsReceived: 3,
    selfKey: { status: "found", api_key_id: "key_self", permissions: null },
    truncated: false,
    ...over,
  };
}

export const withSubs = (subs: Subscriber[], over: Partial<Snapshot> = {}): Snapshot =>
  liveSnapshot({
    subscribers: [{ source: "GET /webhooks", listing: { ok: true, items: subs } }],
    ...over,
  });

export interface FakeCall { method: string; url: string; auth: string | null }

/** Fake fetch: routes by path (without /v0 prefix, query ignored unless the route key has one). */
export function fakeFetch(routes: Record<string, { status: number; body: unknown }>, calls: FakeCall[] = []) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url: url.toString(), auth: headers.get("authorization") });
    const path = decodeURIComponent(url.pathname.replace(/^\/v0/, ""));
    const flags = url.searchParams.get("include_spam") === "true" ? "?include" : "";
    const hit = routes[path + flags] ?? routes[path];
    if (!hit) return new Response(JSON.stringify({ name: "NotFoundError", code: "not_found", message: "no route " + path }), { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
  };
}

/** Routes reproducing the live org (no webhooks), shaped on recorded responses. */
export function liveRoutes(): Record<string, { status: number; body: unknown }> {
  const empty = fixture("live/org_webhooks.json");
  const emptyPoll = fixture("live/org_polling.json");
  return {
    [`/inboxes/${INBOX}`]: fixture("live/inbox.json"),
    "/webhooks": empty,
    "/webhooks/polling": emptyPoll,
    [`/pods/${POD}/webhooks`]: empty,
    [`/pods/${POD}/webhooks/polling`]: emptyPoll,
    [`/inboxes/${INBOX}/webhooks`]: empty,
    [`/inboxes/${INBOX}/webhooks/polling`]: emptyPoll,
    [`/inboxes/${INBOX}/messages`]: fixture("live/messages_default.json"),
    [`/inboxes/${INBOX}/messages?include`]: fixture("live/messages_include.json"),
    [`/inboxes/${INBOX}/metrics/events`]: fixture("live/metrics_events.json"),
    "/api-keys": fixture("api_keys.json").all_granted,
  };
}
