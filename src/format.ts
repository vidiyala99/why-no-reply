// Text and JSON rendering of a Report. Inputs are already stripped of secrets (see api.ts toSubscriber).
import type { Report } from "./types.ts";

const TAG: Record<string, string> = {
  delivered: "DELIVERED",
  missed: "MISSED",
  held: "HELD",
  "no-subscriber": "NO-SUBSCRIBER",
  unknown: "UNKNOWN",
  "cant-see": "CANT-SEE",
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderText(r: Report): string {
  const out: string[] = [];
  const counts = new Map<string, number>();
  for (const v of r.verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  const summary = [...counts].map(([k, n]) => `${TAG[k].toLowerCase()}=${n}`).join(" ");
  out.push(`${r.exit === 0 ? "OK" : "NOT-OK"}  why-no-reply  inbox=${r.inbox}  window=${r.window.since}..${r.window.until}  messages=${r.verdicts.length}${summary ? `  ${summary}` : ""}${r.permissions.hidden ? `  hidden=${r.permissions.hidden}` : ""}`);
  for (const v of r.verdicts) {
    const labels = v.labels.filter((l) => l !== "received" && l !== "unread" && l !== "read");
    out.push([
      TAG[v.verdict],
      v.received_at || "-",
      v.subject !== undefined ? JSON.stringify(oneLine(v.subject)) : v.message_id,
      labels.length ? `labels=${labels.join(",")}` : "",
      oneLine(v.detail),
      v.refs.length ? `[${v.refs.join(", ")}]` : "",
    ].filter(Boolean).join("  "));
  }
  out.push("");
  out.push("setup:");
  for (const l of r.setup) out.push(`  ${l}`);
  for (const l of r.permissions.lines) out.push(`  can't see: ${l}`);
  if (r.catchUp) out.push(`  catch up: ${r.catchUp}`);
  return out.join("\n") + "\n";
}

export function renderJson(r: Report): string {
  return JSON.stringify(r, null, 2) + "\n";
}
