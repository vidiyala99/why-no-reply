# why-no-reply

A read-only CLI that tells an agent (or its developer) why the agent never answered an email that
reached its AgentMail inbox. It walks every documented silent path in one run and prints a verdict per
message.

TypeScript run with Node's built-in type stripping (Node >= 22.18). No npm dependencies or devDependencies; it uses global `fetch`.

## Use

```
node --env-file=.env src/cli.ts --inbox <inbox_id> [--since <ISO>] [--message <message_id>] [--json]
```

- `AGENTMAIL_API_KEY` comes from the environment. It is sent only in the `Authorization` header and never
  printed, logged or written. Any output that would contain it is masked as well.
- Read-only: every request is a `GET`. Requests go only to `https://api.agentmail.to` or
  `https://api.agentmail.eu` (set `AGENTMAIL_BASE_URL=https://api.agentmail.eu/v0` for EU). Any other
  base URL is refused before a request is made.
- `--since` defaults to 24 hours ago. `--message` checks one message by id.
- Exit 0 = every message in the window reached a subscriber. 1 = at least one did not, is held, or can't be
  seen. 2 = usage or auth error.

Output: a summary line, one verdict line per received message, then a setup report:

```
NOT-OK  why-no-reply  inbox=why-no-reply-test@agentmail.to  window=...  messages=3  no-subscriber=3
NO-SUBSCRIBER  2026-11-16T19:46:53Z  "[194630] spam-gtube"  labels=spam  Fires message.received.spam. ... Labeled spam: it never fires message.received, so a message.received-only setup (webhook, polling webhook or WebSocket) misses it ...
setup:
  no webhook, polling webhook or WebSocket subscriber found. WebSocket subscriptions are not visible through the API, ...
  catch up: GET /v0/inboxes/.../messages?after=...&ascending=true&include_spam=true&include_blocked=true&include_unauthenticated=true ...; skip messages already handled by matching inbox_id + message_id ...
```

The full live run is in `examples/live-run-2026-11-16.txt` (pod id redacted).

## What it calls (all GET)

`/inboxes/{inbox}` (pod id), webhooks and polling webhooks at org, pod and inbox scope (6 listings, deduped
by id), `/api-keys` (finds this key by its public prefix, compared locally, to read its permissions),
`/inboxes/{inbox}/messages` twice (default, and with `include_spam/blocked/unauthenticated=true`),
`/inboxes/{inbox}/metrics/events` (received count for the window), or `/inboxes/{inbox}/messages/{id}` with `--message`.

## Verdicts and causes

Each cause is one guard function in `src/diagnose.ts`. They run in order and the first that applies wins.
If none applies, the verdict is DELIVERED.

| verdict | cause | rule | grounded in |
|---|---|---|---|
| HELD | held-by-agent-armor | label `agent-armor-held`: `message.received` is not sent until release (needs opt-in `agent_armor_release`). Names the subscriber that got `message.security.review`, or says none did. For spam/blocked/unauthenticated mail it says no review event is sent at all. | agent-armor.md (Hold mode) |
| UNKNOWN | permission-gap | a webhook listing answered 403 and no visible subscriber delivered: "can't see", never "nobody listens" | errors.md `missing_permission` |
| MISSED | webhook-disabled | the only subscribers for the message's event are webhooks with `enabled: false`. "Arrived while disabled" when the message is newer than the webhook's `updated_at`; "may already have been disabled" when older, because the disable time isn't exposed. Says events are not redelivered and that AgentMail does not notify you. | docs-webhook-autodisable |
| MISSED | subscription-gap | subscribers cover the inbox but none subscribes to the event the message fires (spam/blocked/unauthenticated fire only their variant) | docs-received-variants, live-events-1 |
| NO-SUBSCRIBER | no-subscriber | no webhook or polling webhook covered the inbox when the message arrived. Subscribers created later are named. Spam/blocked/unauthenticated get the note "a message.received-only setup misses it". | webhooks-overview.md, websockets.md |
| CANT-SEE | permission-gap | `--message` id answers `not_found`: wrong id, out of scope, or a hidden label. The API doesn't say which, so neither does the tool. | permissions.md, mcp-include-flags |
| DELIVERED | delivered | an enabled webhook or polling webhook covering the inbox subscribes to the event. Whether the endpoint answered 2xx is only in the console logs. | docs-events-feed |

Setup report: each covering subscriber (enabled or DISABLED, events, scope, URL host only), WebSocket
honesty line, permission findings and the catch-up recipe:
- Permission findings (cause 3) say "can't see" and never guess. A key whose `permissions` object lacks
  `label_spam_read`, `label_blocked_read` or `label_unauthenticated_read` is reported per permission. So is a key whose permissions can't be read, and so is
  a metrics received count higher than the messages the key can list (`hidden=N`; no made-up verdict lines
  for those). So is any 403 listing.
- The catch-up recipe (cause 5) is the docs' own: list messages `after` the earliest missed message
  (minus 1 s) with `ascending=true` and all include flags, deduped on `inbox_id + message_id`.

Scope rules (`covers`): no `inbox_ids`/`pod_ids` means org-wide, unless the webhook belongs to an inbox
(`inbox_id`) or pod (`pod_id`). Otherwise it matches if `inbox_ids` names the inbox or `pod_ids` names its
pod. A subscriber created after the message doesn't count, because polling webhooks "only hold events from after
[they were] created". Polling webhooks have no `enabled` field, so they count as enabled.

Secrets: webhook `secret` and the URL path and query are dropped on read (`toSubscriber`). A canary secret
in the fixtures is asserted absent from text and JSON output.

## Tests

```
node --test "test/*.test.ts"      # 66 tests, 0 fail
node tools/mutants.ts             # 10 forced-pass mutants, 10 killed, 0 survived
```

Fixtures: `fixtures/live/` holds GET responses recorded from the author's own AgentMail org on 2026-11-16 (the 3 test
emails, 0 webhooks, metrics, a 404). Unsubscribe headers, auth results and the org id were stripped; the org
id was replaced by `pod_default_0001`. The live org has no webhooks, so `fixtures/webhooks.json`,
`polling.json`, `errors.json` and `api_keys.json` are synthetic, shaped on the documented Webhook,
PollingWebhook, error and BearerApiKey types.

TDD: every rule's test was written first and run red against a stub where every guard reported
"delivered". 53 of 65 tests failed. The 12 that passed are positive or control cases (for example
"org webhook covers every inbox", "all granted = no findings"). Test 66 ("can't read this key's permissions")
was added later, also red first.

Forced-pass mutants (`tools/mutants.ts` copies src/test/fixtures to a temp dir; the real source is never
edited). Failing tests per mutant:

| guard forced to "delivered" | cause | failing tests |
|---|---|---|
| checkDisabled | 1 webhook disabled | 4 |
| checkSubscriptionGap | 2 subscription gap | 5 |
| eventsFor -> ["message.received"] | 2 label to variant event | 11 |
| checkPermissions -> no findings | 3 permission gap (key, metrics) | 4 |
| checkUnseenSubscribers | 3 permission gap (refused listing) | 1 |
| checkHeld | 4 held by Agent Armor | 4 |
| checkNoSubscriber | 5 no subscriber | 8 |
| catchUp -> null | 5 catch-up recipe | 2 |
| covers -> true | scope | 3 |
| exitCode -> 0 | exit code | 8 |

## Known limits

- Reproduced live: spam and blocked (live-events-1, why-no-reply-live-1). **Not reproduced live:** unauthenticated
  mail, Agent Armor holds and webhook auto-disable. Those rules rest on the docs and synthetic fixtures only.
- WebSocket subscribers are invisible to the API. The tool says so, and never claims nothing listens.
- DELIVERED means "handed to a subscriber". Delivery attempts and 2xx results are only in the console's Svix
  portal (no public API), so an endpoint that is failing but not yet disabled shows as DELIVERED.
- The disable time of a webhook isn't exposed. `updated_at` is used as an upper bound.
- The hidden-mail check compares metrics with list results. It has not been verified with a restricted key,
  so if metrics are also filtered by label permissions, that check finds nothing. The per-permission check
  from `/api-keys` still applies when the key can read `/api-keys`. When it can't, the report says the
  key's permissions can't be read and label gaps can't be ruled out.
- Metrics are skipped for windows longer than 89 days (the API limit is 90).
- Mail dropped before the inbox (DMARC fail under quarantine/reject, docs-dmarc-drop) never appears in any
  list, so this tool can't report it.
- A message with more than one variant label is treated as firing every matching variant. The docs don't
  say which one fires.
- Lists are capped at 10 pages of 100. The setup report says when the cap truncates a list.
