import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diagnose, eventsFor, covers, checkPermissions, catchUp } from "../src/diagnose.ts";
import {
  liveSnapshot, withSubs, webhook, polling, heldMessage, liveMessages, fixture,
  INBOX, POD, SPAM_ID, BLOCKED_ID, NORMAL_ID,
} from "./helpers.ts";
import { toSelfKey } from "../src/api.ts";
import type { Report } from "../src/types.ts";

const byId = (r: Report, id: string) => {
  const v = r.verdicts.find((x) => x.message_id === id);
  assert.ok(v, `no verdict for ${id}`);
  return v;
};

describe("eventsFor (which event a message fires, from its labels)", () => {
  test("plain received mail fires message.received", () => {
    assert.deepEqual(eventsFor(["received", "unread"]), ["message.received"]);
  });
  test("spam, blocked and unauthenticated fire only their variant (docs-received-variants, live-events-1)", () => {
    assert.deepEqual(eventsFor(["received", "unread", "spam"]), ["message.received.spam"]);
    assert.deepEqual(eventsFor(["received", "blocked"]), ["message.received.blocked"]);
    assert.deepEqual(eventsFor(["received", "unauthenticated"]), ["message.received.unauthenticated"]);
  });
  test("held mail fires message.security.review, not message.received (agent-armor Hold mode)", () => {
    assert.deepEqual(eventsFor(["received", "agent-armor-held"]), ["message.security.review"]);
  });
  test("held spam fires no review event (review is not sent for spam/blocked/unauthenticated)", () => {
    assert.deepEqual(eventsFor(["received", "agent-armor-held", "spam"]), []);
  });
});

describe("covers (webhook scope)", () => {
  test("an organization webhook with no pod_ids/inbox_ids covers every inbox", () => {
    assert.equal(covers(webhook("received_only"), INBOX, POD), true);
  });
  test("inbox_ids naming another inbox does not cover this one", () => {
    assert.equal(covers(webhook("other_inbox"), INBOX, POD), false);
  });
  test("pod_ids naming another pod does not cover this one", () => {
    assert.equal(covers(webhook("other_pod"), INBOX, POD), false);
  });
  test("a pod-scoped webhook with no inbox_ids covers its whole pod", () => {
    assert.equal(covers(webhook("pod_scoped"), INBOX, POD), true);
  });
  test("an inbox-scoped webhook covers its inbox, case-insensitively", () => {
    assert.equal(covers(webhook("all_variants_inbox"), INBOX.toUpperCase(), POD), true);
  });
});

describe("cause 1: webhook disabled", () => {
  const r = diagnose(withSubs([webhook("all_variants_disabled")]));
  test("a message after the disable time is missed while disabled", () => {
    const v = byId(r, BLOCKED_ID);
    assert.equal(v.verdict, "missed");
    assert.equal(v.cause, "webhook-disabled");
    assert.match(v.detail, /arrived while/);
    assert.match(v.detail, /not redelivered/);
    assert.ok(v.refs.includes("docs-webhook-autodisable"));
  });
  test("a message before the last update is reported as possibly missed, not certain", () => {
    const v = byId(r, SPAM_ID);
    assert.equal(v.cause, "webhook-disabled");
    assert.match(v.detail, /may already have been disabled/);
  });
  test("the setup report flags the disabled webhook and says AgentMail does not notify", () => {
    const s = r.setup.join("\n");
    assert.match(s, /wh_all_disabled.*DISABLED/);
    assert.match(s, /does not notify/);
  });
  test("an enabled webhook for the same event still delivers; the disabled one only matters for the rest", () => {
    const r2 = diagnose(withSubs([webhook("all_variants_disabled"), webhook("received_only")]));
    assert.equal(byId(r2, NORMAL_ID).verdict, "delivered");
    assert.equal(byId(r2, SPAM_ID).cause, "webhook-disabled");
  });
  test("exit is 1", () => assert.equal(r.exit, 1));
});

describe("cause 2: subscription gap", () => {
  const r = diagnose(withSubs([webhook("received_only")]));
  test("plain mail reaches a message.received webhook", () => {
    const v = byId(r, NORMAL_ID);
    assert.equal(v.verdict, "delivered");
    assert.match(v.detail, /wh_received_only/);
  });
  test("spam is missed by a message.received-only webhook (reproduced live)", () => {
    const v = byId(r, SPAM_ID);
    assert.equal(v.verdict, "missed");
    assert.equal(v.cause, "subscription-gap");
    assert.match(v.detail, /message\.received\.spam/);
    assert.match(v.detail, /wh_received_only/);
    assert.ok(v.refs.includes("live-events-1"));
  });
  test("blocked mail is missed the same way", () => {
    const v = byId(r, BLOCKED_ID);
    assert.equal(v.cause, "subscription-gap");
    assert.match(v.detail, /message\.received\.blocked/);
  });
  test("a polling webhook counts as a subscriber and has the same gap", () => {
    const r2 = diagnose(withSubs([polling("received_only")]));
    assert.equal(byId(r2, NORMAL_ID).verdict, "delivered");
    assert.equal(byId(r2, SPAM_ID).cause, "subscription-gap");
  });
  test("adding a subscriber for the variants closes the gap", () => {
    const r2 = diagnose(withSubs([webhook("received_only"), polling("spam_and_blocked")]));
    assert.deepEqual(r2.verdicts.map((v) => v.verdict), ["delivered", "delivered", "delivered"]);
    assert.equal(r2.exit, 0);
  });
  test("a subscriber for the variants only misses plain mail", () => {
    const r2 = diagnose(withSubs([polling("spam_and_blocked")]));
    const v = byId(r2, NORMAL_ID);
    assert.equal(v.cause, "subscription-gap");
    assert.match(v.detail, /message\.received\b/);
  });
  test("spam left out of the default list is called out (include_spam)", () => {
    assert.match(byId(r, SPAM_ID).detail, /include_spam/);
    assert.doesNotMatch(byId(r, NORMAL_ID).detail, /include_spam/);
  });
});

describe("cause 3: permission gap (can't see, never guess)", () => {
  test("a key without label_*_read is reported for each missing permission", () => {
    const self = toSelfKey(fixture("api_keys.json").no_label_perms, "am_us_testkey_0123456789");
    const p = checkPermissions(liveSnapshot({ selfKey: self }));
    const s = p.lines.join("\n");
    for (const perm of ["label_spam_read", "label_blocked_read", "label_unauthenticated_read"]) assert.match(s, new RegExp(perm));
    assert.match(s, /without an error/);
    assert.match(s, /can't see/);
  });
  test("when the key's own permissions can't be read, it says so instead of assuming all granted", () => {
    const p = checkPermissions(liveSnapshot({ selfKey: { status: "unknown", why: "GET /api-keys answered 403 missing_permission" } }));
    assert.match(p.lines.join("\n"), /can't read this key's permissions.*403 missing_permission/);
    assert.equal(p.hidden, 0);
  });
  test("a key with no permissions object (all granted) has no permission findings", () => {
    assert.deepEqual(checkPermissions(liveSnapshot()), { lines: [], hidden: 0 });
  });
  test("metrics counting more received mail than the key can list means hidden mail", () => {
    const snap = liveSnapshot({ messagesInclude: { ok: true, items: liveMessages("default") } });
    const p = checkPermissions(snap);
    assert.equal(p.hidden, 2);
    assert.match(p.lines.join("\n"), /2 .*can't see/);
    const r = diagnose(snap);
    assert.equal(r.verdicts.length, 1, "no made-up verdicts for mail the key cannot see");
    assert.equal(r.exit, 1);
  });
  test("a 403 missing_permission on a webhook listing is reported and verdicts become unknown", () => {
    const snap = liveSnapshot({
      subscribers: [
        { source: "GET /webhooks", listing: { ok: false, status: 403, code: "missing_permission" } },
        { source: "GET /webhooks/polling", listing: { ok: true, items: [] } },
      ],
    });
    const r = diagnose(snap);
    assert.match(r.permissions.lines.join("\n"), /GET \/webhooks.*403 missing_permission/);
    assert.equal(byId(r, NORMAL_ID).verdict, "unknown");
    assert.match(byId(r, NORMAL_ID).detail, /can't see/);
    assert.equal(r.exit, 1);
  });
  test("a visible delivering subscriber still wins over a refused listing", () => {
    const snap = liveSnapshot({
      subscribers: [
        { source: "GET /webhooks", listing: { ok: true, items: [webhook("received_only")] } },
        { source: "GET /webhooks/polling", listing: { ok: false, status: 403, code: "missing_permission" } },
      ],
    });
    assert.equal(byId(diagnose(snap), NORMAL_ID).verdict, "delivered");
  });
  test("--message for an id the key cannot see says can't see, with the three possible reasons", () => {
    const r = diagnose(liveSnapshot({
      messagesDefault: { ok: true, items: [] }, messagesInclude: { ok: true, items: [] }, metricsReceived: null,
      target: { message_id: "<x@y>", found: false, status: 404, code: "not_found" },
    }));
    assert.equal(r.verdicts.length, 1);
    assert.equal(r.verdicts[0].verdict, "cant-see");
    assert.match(r.verdicts[0].detail, /label_\*_read/);
    assert.equal(r.exit, 1);
  });
});

describe("cause 4: held by Agent Armor", () => {
  const held = heldMessage();
  const snap = (subs = [webhook("all_variants_inbox")], m = held) =>
    withSubs(subs, { messagesInclude: { ok: true, items: [m] }, messagesDefault: { ok: true, items: [m] }, metricsReceived: 1 });
  test("a held message is held, waiting for release, even with a message.received subscriber", () => {
    const v = diagnose(snap([webhook("received_only")])).verdicts[0];
    assert.equal(v.verdict, "held");
    assert.equal(v.cause, "held-by-agent-armor");
    assert.match(v.detail, /release/);
    assert.match(v.detail, /no subscriber for message\.security\.review/);
  });
  test("names the subscriber that got message.security.review", () => {
    assert.match(diagnose(snap()).verdicts[0].detail, /wh_inbox_all got message\.security\.review/);
  });
  test("held spam: no review event either", () => {
    const v = diagnose(snap(undefined, heldMessage(["spam"]))).verdicts[0];
    assert.equal(v.verdict, "held");
    assert.match(v.detail, /not sent for spam/);
  });
  test("exit is 1", () => assert.equal(diagnose(snap()).exit, 1));
});

describe("cause 5: no subscriber at all / catch-up", () => {
  const r = diagnose(liveSnapshot());
  test("with no webhooks or polling webhooks every message has no subscriber", () => {
    assert.deepEqual(r.verdicts.map((v) => v.verdict), ["no-subscriber", "no-subscriber", "no-subscriber"]);
  });
  test("spam and blocked are flagged as missed by any message.received-only setup", () => {
    for (const [id, ev] of [[SPAM_ID, "spam"], [BLOCKED_ID, "blocked"]]) {
      const d = byId(r, id).detail;
      assert.match(d, new RegExp(`message\\.received\\.${ev}`));
      assert.match(d, /message\.received-only/);
    }
    assert.doesNotMatch(byId(r, NORMAL_ID).detail, /message\.received-only/);
  });
  test("the setup report is honest about WebSockets", () => {
    const s = r.setup.join("\n");
    assert.match(s, /no webhook, polling webhook or WebSocket subscriber found/);
    assert.match(s, /not visible through the API/);
  });
  test("a webhook for another inbox does not count", () => {
    assert.equal(byId(diagnose(withSubs([webhook("other_inbox")])), NORMAL_ID).verdict, "no-subscriber");
  });
  test("a webhook created after the message does not count, and says so", () => {
    const v = byId(diagnose(withSubs([webhook("late_created")])), SPAM_ID);
    assert.equal(v.verdict, "no-subscriber");
    assert.match(v.detail, /wh_late was created after/);
  });
  test("catch-up recipe: list after the earliest missed message, all include flags, dedupe on inbox_id + message_id", () => {
    const c = catchUp(liveSnapshot(), r.verdicts);
    assert.ok(c);
    assert.match(c, /after=2026-11-16T19:46:32Z/);
    assert.match(c, /ascending=true/);
    assert.match(c, /include_spam=true&include_blocked=true&include_unauthenticated=true/);
    assert.match(c, /inbox_id \+ message_id/);
    assert.equal(r.catchUp, c);
  });
  test("no catch-up recipe when everything was delivered", () => {
    const r2 = diagnose(withSubs([webhook("all_variants_inbox")]));
    assert.equal(r2.catchUp, null);
    assert.equal(r2.exit, 0);
  });
  test("exit 1 when nothing visible could deliver; exit 0 for an empty window", () => {
    assert.equal(r.exit, 1);
    const empty = diagnose(liveSnapshot({ messagesDefault: { ok: true, items: [] }, messagesInclude: { ok: true, items: [] }, metricsReceived: 0 }));
    assert.equal(empty.exit, 0);
    assert.equal(empty.verdicts.length, 0);
  });
});
