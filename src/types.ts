// Shapes used by why-no-reply. Raw API fields follow docs.agentmail.to api-reference pages (2026-11-16).

export type Listing<T> =
  | { ok: true; items: T[] }
  | { ok: false; status: number; code?: string };

/** A webhook or polling webhook, with the secret and URL path dropped (never printed). */
export interface Subscriber {
  kind: "webhook" | "polling";
  webhook_id: string;
  /** Polling webhooks have no enabled field; they queue events, so they count as enabled. */
  enabled: boolean;
  event_types: string[];
  inbox_ids: string[];
  pod_ids: string[];
  inbox_id?: string;
  pod_id?: string;
  created_at: string;
  updated_at: string;
  /** Host of the webhook URL only (query strings can carry tokens). */
  host?: string;
}

export interface Message {
  inbox_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  created_at?: string;
  subject?: string;
  from?: string;
}

export type SelfKey =
  | { status: "found"; api_key_id: string; permissions: Record<string, boolean> | null }
  | { status: "unknown"; why: string };

export interface SubscriberSource {
  /** e.g. "GET /webhooks" */
  source: string;
  listing: Listing<Subscriber>;
}

export interface Snapshot {
  inbox: { inbox_id: string; pod_id?: string; created_at?: string };
  window: { since: string; until: string };
  subscribers: SubscriberSource[];
  /** List without include_* flags (what skill.md teaches). */
  messagesDefault: Listing<Message>;
  /** List with include_spam/blocked/unauthenticated=true. */
  messagesInclude: Listing<Message>;
  /** Sum of message.received* metric counts in the window; null when unavailable. */
  metricsReceived: number | null;
  selfKey: SelfKey;
  /** Set in --message mode. */
  target?: { message_id: string; found: boolean; status?: number; code?: string };
  truncated: boolean;
}

export type VerdictKind = "delivered" | "missed" | "held" | "no-subscriber" | "unknown" | "cant-see";

export interface Verdict {
  message_id: string;
  subject?: string;
  received_at: string;
  labels: string[];
  /** Event types this message fires (from its labels). */
  events: string[];
  verdict: VerdictKind;
  /** Short cause id: delivered, webhook-disabled, subscription-gap, held-by-agent-armor, no-subscriber, permission-gap. */
  cause: string;
  detail: string;
  /** Evidence ids / doc pages the verdict rests on. */
  refs: string[];
}

export interface PermissionFindings {
  lines: string[];
  /** Received messages counted by metrics but not visible to this key. */
  hidden: number;
}

export interface Report {
  inbox: string;
  window: { since: string; until: string };
  verdicts: Verdict[];
  setup: string[];
  permissions: PermissionFindings;
  catchUp: string | null;
  exit: 0 | 1;
}
