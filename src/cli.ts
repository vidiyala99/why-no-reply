#!/usr/bin/env node
// why-no-reply: why did my agent never answer this email?
//   node --env-file=.env src/cli.ts --inbox <inbox_id> [--since <ISO>] [--message <message_id>] [--json]
// Exit 0 = every message reached a subscriber, 1 = at least one did not (or can't be seen), 2 = usage/auth error.
// Read-only: GET requests only. AGENTMAIL_API_KEY is read from the environment and never printed.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { gather, DEFAULT_BASE } from "./api.ts";
import { diagnose } from "./diagnose.ts";
import { renderText, renderJson } from "./format.ts";

const USAGE = "usage: why-no-reply --inbox <inbox_id> [--since <ISO>] [--message <message_id>] [--json]\n" +
  "  reads AGENTMAIL_API_KEY from the environment (node --env-file=.env); AGENTMAIL_BASE_URL may be https://api.agentmail.eu/v0\n";

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  now: () => Date;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  let values: { inbox?: string; since?: string; message?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        inbox: { type: "string" },
        since: { type: "string" },
        message: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    deps.stderr(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) { deps.stdout(USAGE); return 0; }
  if (!values.inbox) { deps.stderr(USAGE); return 2; }

  const key = deps.env.AGENTMAIL_API_KEY;
  if (!key) { deps.stderr(`AGENTMAIL_API_KEY is not set (run with node --env-file=.env)\n${USAGE}`); return 2; }

  const now = deps.now();
  let since: string;
  if (values.since) {
    const t = new Date(values.since);
    if (Number.isNaN(t.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(values.since)) { deps.stderr(`--since must be an ISO date/time, got ${values.since}\n${USAGE}`); return 2; }
    if (t.getTime() > now.getTime()) { deps.stderr(`--since is in the future\n`); return 2; }
    since = t.toISOString();
  } else {
    since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  }

  let result;
  try {
    result = await gather({
      key, fetch: deps.fetch, inbox: values.inbox, since, until: now.toISOString(),
      messageId: values.message, base: deps.env.AGENTMAIL_BASE_URL || DEFAULT_BASE,
    });
  } catch (e) {
    // Network errors: report the type only; never the request (it carries the key in a header, not the message).
    deps.stderr(`request failed: ${(e as Error).name}: ${String((e as Error).message).split(key).join("<key>")}\n`);
    return 2;
  }
  if ("error" in result) { deps.stderr(result.error.message + "\n"); return 2; }

  const report = diagnose(result);
  const text = values.json ? renderJson(report) : renderText(report);
  deps.stdout(text.split(key).join("<key>"));
  return report.exit;
}

const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2), {
    env: process.env,
    fetch: (i, init) => fetch(i, init),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    now: () => new Date(),
  }).then((code) => { process.exitCode = code; });
}
