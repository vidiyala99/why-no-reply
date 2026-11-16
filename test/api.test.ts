import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gather, toSubscriber, toSelfKey, sumReceived } from "../src/api.ts";
import { fakeFetch, liveRoutes, fixture, INBOX, POD, TEST_KEY, type FakeCall } from "./helpers.ts";
import type { Snapshot } from "../src/types.ts";

const opts = (fetchImpl: any, extra: object = {}) => ({
  key: TEST_KEY, fetch: fetchImpl, inbox: INBOX,
  since: "2026-11-16T19:40:00.000Z", until: "2026-11-16T21:00:00.000Z", ...extra,
});

describe("gather (read-only API calls)", () => {
  test("only GET requests, bearer auth, to api.agentmail.to", async () => {
    const calls: FakeCall[] = [];
    await gather(opts(fakeFetch(liveRoutes(), calls)));
    assert.ok(calls.length >= 10);
    for (const c of calls) {
      assert.equal(c.method, "GET");
      assert.equal(c.auth, `Bearer ${TEST_KEY}`);
      assert.match(c.url, /^https:\/\/api\.agentmail\.to\/v0\//);
    }
  });
  test("builds the live snapshot: 6 subscriber sources, 1 default vs 3 included messages, metrics 3, key found", async () => {
    const s = (await gather(opts(fakeFetch(liveRoutes())))) as Snapshot;
    assert.deepEqual(s.subscribers.map((x) => x.source), [
      "GET /webhooks", "GET /webhooks/polling",
      `GET /pods/${POD}/webhooks`, `GET /pods/${POD}/webhooks/polling`,
      `GET /inboxes/${INBOX}/webhooks`, `GET /inboxes/${INBOX}/webhooks/polling`,
    ]);
    assert.ok(s.messagesDefault.ok && s.messagesDefault.items.length === 1);
    assert.ok(s.messagesInclude.ok && s.messagesInclude.items.length === 3);
    assert.equal(s.metricsReceived, 3);
    assert.deepEqual(s.selfKey, { status: "found", api_key_id: "key_self", permissions: null });
    assert.equal(s.inbox.pod_id, POD);
  });
  test("asks the include list with all three include flags and the window bounds", async () => {
    const calls: FakeCall[] = [];
    await gather(opts(fakeFetch(liveRoutes(), calls)));
    const inc = calls.find((c) => c.url.includes("include_spam=true"));
    assert.ok(inc);
    const u = new URL(inc.url);
    assert.equal(u.searchParams.get("include_blocked"), "true");
    assert.equal(u.searchParams.get("include_unauthenticated"), "true");
    assert.equal(u.searchParams.get("after"), "2026-11-16T19:40:00.000Z");
    assert.equal(u.searchParams.get("before"), "2026-11-16T21:00:00.000Z");
  });
  test("a 403 on a webhook listing is kept as a refused listing with its code", async () => {
    const routes = liveRoutes();
    routes["/webhooks"] = fixture("errors.json").missing_permission;
    const s = (await gather(opts(fakeFetch(routes)))) as Snapshot;
    assert.deepEqual(s.subscribers[0].listing, { ok: false, status: 403, code: "missing_permission" });
  });
  test("follows next_page_token on message lists", async () => {
    const routes = liveRoutes();
    const page1 = fixture("live/messages_include.json");
    const msgs = page1.body.messages;
    let n = 0;
    const base = fakeFetch(routes);
    const f = async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.searchParams.get("include_spam") === "true") {
        n++;
        const token = u.searchParams.get("page_token");
        const body = token === "p2"
          ? { count: 2, messages: msgs.slice(1) }
          : { count: 1, messages: msgs.slice(0, 1), next_page_token: "p2" };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return base(input, init);
    };
    const s = (await gather(opts(f))) as Snapshot;
    assert.equal(n, 2);
    assert.ok(s.messagesInclude.ok && s.messagesInclude.items.length === 3);
  });
  test("--message: a 404 is kept as not found (can't see), never as an error exit", async () => {
    const routes = liveRoutes();
    routes[`/inboxes/${INBOX}/messages/<nope@x>`] = fixture("live/message_missing.json");
    const s = (await gather(opts(fakeFetch(routes), { messageId: "<nope@x>" }))) as Snapshot;
    assert.deepEqual(s.target, { message_id: "<nope@x>", found: false, status: 404, code: "not_found" });
  });
  test("--message: a found message becomes the only message", async () => {
    const routes = liveRoutes();
    const one = fixture("live/message_one.json");
    routes[`/inboxes/${INBOX}/messages/${one.body.message_id}`] = one;
    const s = (await gather(opts(fakeFetch(routes), { messageId: one.body.message_id }))) as Snapshot;
    assert.equal(s.target?.found, true);
    assert.ok(s.messagesInclude.ok && s.messagesInclude.items.length === 1);
  });
  test("401 on the inbox is a usage/auth error (exit 2) that never echoes the key", async () => {
    const routes = liveRoutes();
    routes[`/inboxes/${INBOX}`] = fixture("errors.json").unauthorized;
    const r = await gather(opts(fakeFetch(routes)));
    assert.ok("error" in r);
    assert.equal(r.error.exit, 2);
    assert.match(r.error.message, /401/);
    assert.ok(!r.error.message.includes(TEST_KEY));
  });
  test("404 on the inbox is exit 2", async () => {
    const routes = liveRoutes();
    delete routes[`/inboxes/${INBOX}`];
    const r = await gather(opts(fakeFetch(routes)));
    assert.ok("error" in r && r.error.exit === 2);
  });
  test("refuses a base URL outside api.agentmail.to / api.agentmail.eu (the key is never sent elsewhere)", async () => {
    const calls: FakeCall[] = [];
    const r = await gather(opts(fakeFetch(liveRoutes(), calls), { base: "https://evil.example.com/v0" }));
    assert.ok("error" in r && r.error.exit === 2);
    assert.equal(calls.length, 0);
  });
});

describe("normalizers", () => {
  test("toSubscriber drops the secret and the URL path/query, keeps the host", () => {
    const raw = fixture("webhooks.json").received_only;
    const s = toSubscriber(raw, "webhook");
    const j = JSON.stringify(s);
    assert.ok(!j.includes("CANARY"));
    assert.equal(s.host, "agent.example.com");
    assert.equal(s.enabled, true);
  });
  test("a polling webhook (no enabled field) counts as enabled", () => {
    assert.equal(toSubscriber(fixture("polling.json").received_only, "polling").enabled, true);
  });
  test("toSelfKey matches the key by prefix and reads permissions; no match or 403 is unknown", () => {
    const k = fixture("api_keys.json");
    assert.deepEqual(toSelfKey(k.all_granted, TEST_KEY), { status: "found", api_key_id: "key_self", permissions: null });
    const n = toSelfKey(k.no_label_perms, TEST_KEY);
    assert.ok(n.status === "found" && n.permissions?.label_spam_read === false);
    assert.equal(toSelfKey(k.all_granted, "am_us_other_999").status, "unknown");
    const f = toSelfKey(fixture("errors.json").missing_permission, TEST_KEY);
    assert.ok(f.status === "unknown" && /403/.test(f.why));
  });
  test("sumReceived adds every message.received* bucket and ignores other events", () => {
    assert.equal(sumReceived(fixture("live/metrics_events.json").body), 3);
    assert.equal(sumReceived({
      "message.received": [{ timestamp: "t", count: 2 }], "message.received.spam": [{ timestamp: "t", count: 1 }],
      "message.sent": [{ timestamp: "t", count: 9 }],
    }), 3);
  });
});
