// Pure diagnosis: Snapshot in, Report out. No I/O.
// Each cause is one guard function; a guard returns a Verdict when it applies, or null.
// Grounding (evidence ids from the proof page's evidence list; doc pages on docs.agentmail.to):
//   docs-webhook-autodisable, docs-received-variants, mcp-include-flags, live-events-1,
//   agent-armor.md (Hold mode), permissions.md (label visibility), websockets.md, webhooks-overview.md (recovering missed events).
import type { Snapshot, Subscriber, Message, Verdict, Report, PermissionFindings } from "./types.ts";

const VARIANTS: Record<string, string> = {
  spam: "message.received.spam",
  blocked: "message.received.blocked",
  unauthenticated: "message.received.unauthenticated",
};
const LABEL_PERMS: Record<string, string> = {
  label_spam_read: "spam",
  label_blocked_read: "blocked",
  label_unauthenticated_read: "unauthenticated",
};
const HELD = "agent-armor-held";
const REVIEW = "message.security.review";

export const iso = (t: string): string => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const lc = (s: string) => s.toLowerCase();
const receivedAt = (m: Message) => m.created_at ?? m.timestamp;
const variantLabels = (labels: string[]) => labels.filter((l) => l in VARIANTS);

/** Event types a message fires, from its labels (webhooks-overview: variants "are no longer sent as message.received"). */
export function eventsFor(labels: string[]): string[] {
  const variants = variantLabels(labels);
  if (labels.includes(HELD)) return variants.length ? [] : [REVIEW];
  if (variants.length) return variants.map((l) => VARIANTS[l]);
  return ["message.received"];
}

/** Does this webhook/polling webhook receive events for the inbox? (webhooks-overview: Scoping a webhook to a pod or inbox) */
export function covers(s: Subscriber, inbox: string, pod?: string): boolean {
  const ids = s.inbox_ids.map(lc);
  const pods = s.pod_ids;
  if (ids.length === 0 && pods.length === 0) {
    if (s.inbox_id) return lc(s.inbox_id) === lc(inbox);
    if (s.pod_id) return s.pod_id === pod;
    return true; // organization-wide
  }
  return ids.includes(lc(inbox)) || (pod !== undefined && pods.includes(pod));
}

function allSubscribers(snap: Snapshot): Subscriber[] {
  const seen = new Map<string, Subscriber>();
  for (const src of snap.subscribers) {
    if (!src.listing.ok) continue;
    for (const s of src.listing.items) seen.set(`${s.kind}:${s.webhook_id}`, s);
  }
  return [...seen.values()];
}
const refused = (snap: Snapshot) => snap.subscribers.filter((s) => !s.listing.ok);

interface Ctx {
  msg: Message;
  events: string[];
  /** Subscribers covering this inbox that existed when the message arrived. */
  covering: Subscriber[];
  /** Covering subscribers created after the message arrived. */
  late: Subscriber[];
  /** Covering subscribers whose event_types include one of the message's events. */
  matching: Subscriber[];
  matchingEnabled: Subscriber[];
  refusedSources: string[];
  hiddenByDefault: boolean;
}

const name = (s: Subscriber) => (s.kind === "polling" ? `polling webhook ${s.webhook_id}` : `webhook ${s.webhook_id}`);
const names = (subs: Subscriber[]) => subs.map(name).join(", ");

function variantNote(c: Ctx): string {
  const v = variantLabels(c.msg.labels);
  if (!v.length || c.msg.labels.includes(HELD)) return "";
  return ` Labeled ${v.join("+")}: it never fires message.received, so a message.received-only setup (webhook, polling webhook or WebSocket) misses it (reproduced live 2026-11-16).`;
}
function defaultListNote(c: Ctx): string {
  if (!c.hiddenByDefault) return "";
  const flags = variantLabels(c.msg.labels).map((l) => `include_${l}=true`).join(" / ") || "include_* flags";
  return ` Also left out of the default message list (needs ${flags}).`;
}
const verdict = (c: Ctx, v: Omit<Verdict, "message_id" | "subject" | "received_at" | "labels" | "events">): Verdict => ({
  message_id: c.msg.message_id,
  subject: c.msg.subject,
  received_at: iso(receivedAt(c.msg)),
  labels: c.msg.labels,
  events: c.events,
  ...v,
});

// ---- guards -------------------------------------------------------------------------------

/** Cause 4: Agent Armor Hold mode keeps message.received back until someone releases the message. */
export function checkHeld(c: Ctx): Verdict | null {
  if (!c.msg.labels.includes(HELD)) return null;
  const v = variantLabels(c.msg.labels);
  let review: string;
  if (v.length) review = `message.security.review is not sent for ${v.join("/")} mail either, so only the agent-armor-held label shows it.`;
  else if (c.matchingEnabled.length) review = `${names(c.matchingEnabled)} got message.security.review.`;
  else review = "There is no subscriber for message.security.review.";
  return verdict(c, {
    verdict: "held",
    cause: "held-by-agent-armor",
    detail: `Held by Agent Armor (Hold mode): message.received is not sent until someone releases it (needs the opt-in agent_armor_release permission, or the console). ${review}`,
    refs: ["agent-armor.md#hold-mode"],
  });
}

/** Cause 3 (subscriber side): a webhook listing was refused, so "nobody listens" would be a guess. */
export function checkUnseenSubscribers(c: Ctx): Verdict | null {
  if (!c.refusedSources.length || c.matchingEnabled.length) return null;
  return verdict(c, {
    verdict: "unknown",
    cause: "permission-gap",
    detail: `Fires ${c.events.join(", ")}. This key can't see every subscriber (${c.refusedSources.join("; ")}), so it can't tell whether one received this.${defaultListNote(c)}`,
    refs: ["errors.md#missing_permission"],
  });
}

/** Cause 1: the only subscribers for this event are disabled webhooks (auto-disabled after 5 days of failures). */
export function checkDisabled(c: Ctx): Verdict | null {
  if (c.matchingEnabled.length || !c.matching.length) return null;
  const parts = c.matching.map((s) => {
    const at = iso(s.updated_at);
    return new Date(receivedAt(c.msg)).getTime() >= new Date(s.updated_at).getTime()
      ? `${name(s)} is disabled (since ${at} or earlier) and this message arrived while it was disabled`
      : `${name(s)} is disabled now; this message arrived before its last update at ${at}, so it may already have been disabled (the disable time isn't exposed)`;
  });
  return verdict(c, {
    verdict: "missed",
    cause: "webhook-disabled",
    detail: `Fires ${c.events.join(", ")}. ${parts.join("; ")}. Events from while a webhook is disabled are not redelivered, and AgentMail does not notify you.${defaultListNote(c)}`,
    refs: ["docs-webhook-autodisable"],
  });
}

/** Cause 2: subscribers cover the inbox, but none subscribes to the event this message fires. */
export function checkSubscriptionGap(c: Ctx): Verdict | null {
  if (c.matching.length || !c.covering.length) return null;
  const subs = c.covering.map((s) => `${name(s)} [${s.event_types.join(", ")}]`).join("; ");
  return verdict(c, {
    verdict: "missed",
    cause: "subscription-gap",
    detail: `Fires ${c.events.join(", ")}, but no subscriber for this inbox subscribes to it: ${subs}.${variantNote(c)}${defaultListNote(c)}`,
    refs: ["docs-received-variants", "live-events-1"],
  });
}

/** Cause 5: no webhook or polling webhook covered the inbox when the message arrived. */
export function checkNoSubscriber(c: Ctx): Verdict | null {
  if (c.covering.length) return null;
  const late = c.late.length ? ` (${c.late.map((s) => `${s.webhook_id} was created after`).join(", ")} this message)` : "";
  return verdict(c, {
    verdict: "no-subscriber",
    cause: "no-subscriber",
    detail: `Fires ${c.events.join(", ")}. No webhook or polling webhook covered this inbox when it arrived${late}; a WebSocket may have been listening (not visible through the API).${variantNote(c)}${defaultListNote(c)}`,
    refs: ["webhooks-overview.md#recovering-missed-events", "websockets.md"],
  });
}

const GUARDS = [checkHeld, checkUnseenSubscribers, checkDisabled, checkSubscriptionGap, checkNoSubscriber];

function diagnoseMessage(c: Ctx): Verdict {
  for (const g of GUARDS) {
    const v = g(c);
    if (v) return v;
  }
  return verdict(c, {
    verdict: "delivered",
    cause: "delivered",
    detail: `Fires ${c.events.join(", ")}; handed to ${names(c.matchingEnabled)}. Whether the endpoint answered 2xx is only in the console's webhook logs (no API for delivery attempts).`,
    refs: ["docs-events-feed"],
  });
}

/** Cause 3 (message side): what this key cannot see. Reports "can't see", never a guess. */
export function checkPermissions(snap: Snapshot): PermissionFindings {
  const lines: string[] = [];
  for (const r of refused(snap)) lines.push(`${r.source} refused: ${r.listing.ok ? "" : `${r.listing.status} ${r.listing.code ?? ""}`.trim()}.`);
  if (snap.selfKey.status === "unknown") {
    lines.push(`can't read this key's permissions (${snap.selfKey.why}), so missing label_spam_read / label_blocked_read / label_unauthenticated_read can't be ruled out.`);
  } else if (snap.selfKey.permissions) {
    const p = snap.selfKey.permissions;
    for (const [perm, label] of Object.entries(LABEL_PERMS)) {
      if (p[perm] !== true) {
        lines.push(`This key lacks ${perm}: mail labeled ${label} is left out of every list without an error and returns not found, and the key can't subscribe to ${VARIANTS[label]}. This tool can't see that mail.`);
      }
    }
  }
  let hidden = 0;
  if (snap.metricsReceived !== null && snap.messagesInclude.ok && !snap.target) {
    const visible = snap.messagesInclude.items.filter((m) => m.labels.includes("received")).length;
    if (snap.metricsReceived > visible) {
      hidden = snap.metricsReceived - visible;
      lines.push(`Metrics count ${snap.metricsReceived} received messages in this window; this key can list ${visible}. ${hidden} are hidden from it (a label permission or the key's scope): can't see them, so no verdict for those.`);
    }
  }
  return { lines, hidden };
}

/** Cause 5 recovery: the docs' catch-up recipe, starting just before the earliest message nothing visible delivered. */
export function catchUp(snap: Snapshot, verdicts: Verdict[]): string | null {
  const missed = verdicts.filter((v) => v.verdict === "missed" || v.verdict === "no-subscriber" || v.verdict === "unknown");
  if (!missed.length) return null;
  const first = Math.min(...missed.map((v) => new Date(v.received_at).getTime()));
  const after = iso(new Date(first - 1000).toISOString());
  const inbox = encodeURIComponent(snap.inbox.inbox_id);
  return `GET /v0/inboxes/${inbox}/messages?after=${after}&ascending=true&include_spam=true&include_blocked=true&include_unauthenticated=true (or after= the last event your agent processed, if earlier); skip messages already handled by matching inbox_id + message_id, not message_id alone.`;
}

export function exitCode(verdicts: Verdict[], perms: PermissionFindings): 0 | 1 {
  return verdicts.every((v) => v.verdict === "delivered") && perms.hidden === 0 ? 0 : 1;
}

function setupLines(snap: Snapshot, subs: Subscriber[]): string[] {
  const { inbox_id, pod_id } = snap.inbox;
  const out: string[] = [`inbox ${inbox_id}${pod_id ? ` (pod ${pod_id})` : ""}`];
  const mine = subs.filter((s) => covers(s, inbox_id, pod_id));
  for (const s of mine) {
    const state = s.enabled ? "enabled" : `DISABLED (since ${iso(s.updated_at)} or earlier; AgentMail does not notify and does not redeliver)`;
    const scope = s.inbox_ids.length || s.pod_ids.length ? `inboxes=[${s.inbox_ids.join(", ")}] pods=[${s.pod_ids.join(", ")}]` : s.inbox_id ? "inbox" : s.pod_id ? "pod" : "organization";
    out.push(`${name(s)} ${state} events=[${s.event_types.join(", ")}] scope=${scope}${s.host ? ` host=${s.host}` : ""} created=${iso(s.created_at)}`);
  }
  const others = subs.length - mine.length;
  if (others) out.push(`${others} other subscriber(s) in the org do not cover this inbox.`);
  if (!mine.length && !refused(snap).length) {
    out.push("no webhook, polling webhook or WebSocket subscriber found. WebSocket subscriptions are not visible through the API, so one may still be listening; a WebSocket naming only message.received misses spam, blocked and unauthenticated mail.");
  } else {
    out.push("WebSocket subscriptions are not visible through the API and are not counted here.");
  }
  if (snap.truncated) out.push("Message list truncated at the page limit: narrow --since.");
  return out;
}

export function diagnose(snap: Snapshot): Report {
  const subs = allSubscribers(snap);
  const { inbox_id, pod_id } = snap.inbox;
  const mine = subs.filter((s) => covers(s, inbox_id, pod_id));
  const defaultIds = new Set(snap.messagesDefault.ok ? snap.messagesDefault.items.map((m) => m.message_id) : []);
  const refusedSources = refused(snap).map((r) => `${r.source}: ${r.listing.ok ? "" : `${r.listing.status} ${r.listing.code ?? ""}`.trim()}`);

  const msgs = (snap.messagesInclude.ok ? snap.messagesInclude.items : []).filter((m) => m.labels.includes("received"));
  const verdicts: Verdict[] = msgs.map((msg) => {
    const events = eventsFor(msg.labels);
    const at = new Date(receivedAt(msg)).getTime();
    const covering = mine.filter((s) => new Date(s.created_at).getTime() <= at);
    const late = mine.filter((s) => new Date(s.created_at).getTime() > at);
    const matching = covering.filter((s) => s.event_types.some((e) => events.includes(e)));
    return diagnoseMessage({
      msg, events, covering, late, matching,
      matchingEnabled: matching.filter((s) => s.enabled),
      refusedSources,
      hiddenByDefault: snap.messagesDefault.ok && !snap.target && !defaultIds.has(msg.message_id),
    });
  });

  if (snap.target && !snap.target.found) {
    verdicts.push({
      message_id: snap.target.message_id,
      received_at: "",
      labels: [],
      events: [],
      verdict: "cant-see",
      cause: "permission-gap",
      detail: `Not visible to this key (${snap.target.status ?? "?"} ${snap.target.code ?? ""}`.trim() + "): a wrong id, an inbox outside the key's scope, or a spam/blocked/unauthenticated/trash label without its label_*_read permission. The API answers not_found for all three, so this tool can't tell which.",
      refs: ["permissions.md", "mcp-include-flags"],
    });
  }

  const permissions = checkPermissions(snap);
  return {
    inbox: inbox_id,
    window: snap.window,
    verdicts,
    setup: setupLines(snap, subs),
    permissions,
    catchUp: catchUp(snap, verdicts),
    exit: exitCode(verdicts, permissions),
  };
}
