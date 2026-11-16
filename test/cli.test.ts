import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { fakeFetch, liveRoutes, fixture, INBOX, POD, TEST_KEY, type FakeCall } from "./helpers.ts";

async function run(argv: string[], opts: { env?: Record<string, string | undefined>; routes?: any; calls?: FakeCall[] } = {}) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    env: opts.env ?? { AGENTMAIL_API_KEY: TEST_KEY },
    fetch: fakeFetch(opts.routes ?? liveRoutes(), opts.calls) as any,
    stdout: (s: string) => { out += s; },
    stderr: (s: string) => { err += s; },
    now: () => new Date("2026-11-16T21:00:00.000Z"),
  });
  return { code, out, err };
}
const ARGS = ["--inbox", INBOX, "--since", "2026-11-16T19:40:00Z"];

describe("usage errors exit 2", () => {
  test("missing --inbox", async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.match(r.err, /usage: why-no-reply --inbox/);
  });
  test("missing AGENTMAIL_API_KEY", async () => {
    const r = await run(ARGS, { env: {} });
    assert.equal(r.code, 2);
    assert.match(r.err, /AGENTMAIL_API_KEY/);
  });
  test("bad --since", async () => {
    assert.equal((await run(["--inbox", INBOX, "--since", "yesterday-ish"])).code, 2);
  });
  test("unknown flag", async () => {
    assert.equal((await run([...ARGS, "--send"])).code, 2);
  });
  test("401 exits 2 without printing the key", async () => {
    const routes = liveRoutes();
    routes[`/inboxes/${INBOX}`] = fixture("errors.json").unauthorized;
    const r = await run(ARGS, { routes });
    assert.equal(r.code, 2);
    assert.ok(!(r.out + r.err).includes(TEST_KEY));
  });
});

describe("live org replay (no webhooks, 3 test emails)", () => {
  test("text: one verdict line per message, spam/blocked flagged, setup report, exit 1", async () => {
    const r = await run(ARGS);
    assert.equal(r.code, 1);
    const lines = r.out.split("\n");
    assert.equal(lines.filter((l) => l.startsWith("NO-SUBSCRIBER")).length, 3);
    assert.ok(lines.some((l) => l.includes("[194630] spam-gtube") && l.includes("message.received.spam")));
    assert.ok(lines.some((l) => l.includes("[194630] blocked-sender") && l.includes("message.received.blocked")));
    assert.match(r.out, /no webhook, polling webhook or WebSocket subscriber found/);
    assert.match(r.out, /catch up:/);
    assert.ok(!(r.out + r.err).includes(TEST_KEY));
  });
  test("--json is machine-readable with the same verdicts and exit", async () => {
    const r = await run([...ARGS, "--json"]);
    const j = JSON.parse(r.out);
    assert.equal(r.code, 1);
    assert.equal(j.exit, 1);
    assert.equal(j.verdicts.length, 3);
    assert.deepEqual(j.verdicts.map((v: any) => v.verdict), ["no-subscriber", "no-subscriber", "no-subscriber"]);
  });
  test("defaults --since to 24 hours before now", async () => {
    const calls: FakeCall[] = [];
    await run(["--inbox", INBOX], { calls });
    const u = new URL(calls.find((c) => c.url.includes("include_spam=true"))!.url);
    assert.equal(u.searchParams.get("after"), "2026-11-15T21:00:00.000Z");
  });
  test("every request is a GET", async () => {
    const calls: FakeCall[] = [];
    await run(ARGS, { calls });
    assert.ok(calls.every((c) => c.method === "GET"));
  });
});

describe("secrets never printed", () => {
  test("webhook secret and URL token stay out of text and JSON output", async () => {
    const routes = liveRoutes();
    const wh = fixture("webhooks.json");
    routes["/webhooks"] = { status: 200, body: { count: 2, webhooks: [wh.received_only, wh.all_variants_disabled] } };
    for (const flag of [[], ["--json"]]) {
      const r = await run([...ARGS, ...flag], { routes });
      const all = r.out + r.err;
      assert.ok(!all.includes("CANARY"), "secret or url token leaked");
      assert.ok(!all.includes(TEST_KEY));
      assert.match(all, /wh_received_only/);
    }
  });
  test("a webhook listed by both org and inbox routes is counted once", async () => {
    const routes = liveRoutes();
    const wh = fixture("webhooks.json").all_variants_inbox;
    routes["/webhooks"] = { status: 200, body: { count: 1, webhooks: [wh] } };
    routes[`/inboxes/${INBOX}/webhooks`] = { status: 200, body: { count: 1, webhooks: [wh] } };
    const r = await run([...ARGS, "--json"], { routes });
    const j = JSON.parse(r.out);
    assert.equal(r.code, 0);
    assert.equal(j.setup.filter((l: string) => l.includes("wh_inbox_all")).length, 1);
  });
});

describe("exit 0 when everything reached a subscriber", () => {
  test("an inbox webhook for every variant: all delivered", async () => {
    const routes = liveRoutes();
    routes[`/pods/${POD}/webhooks`] = { status: 200, body: { count: 1, webhooks: [fixture("webhooks.json").all_variants_inbox] } };
    const r = await run(ARGS, { routes });
    assert.equal(r.code, 0);
    assert.equal(r.out.split("\n").filter((l) => l.startsWith("DELIVERED")).length, 3);
    assert.doesNotMatch(r.out, /catch up:/);
  });
});
