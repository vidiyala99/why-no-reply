// Forced-pass mutants: for each cause guard, copy the build to a temp dir, make that guard report
// "delivered" / nothing found, run the suite, and count failing tests. A mutant that fails 0 tests
// means the guard is untested. The real source is never edited.
//   node tools/mutants.ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GUARDS: { cause: string; file: string; fn: string; body: string }[] = [
  { cause: "1 webhook disabled", file: "diagnose.ts", fn: "checkDisabled", body: "return null;" },
  { cause: "2 subscription gap", file: "diagnose.ts", fn: "checkSubscriptionGap", body: "return null;" },
  { cause: "2 label -> variant event", file: "diagnose.ts", fn: "eventsFor", body: 'return ["message.received"];' },
  { cause: "3 permission gap (key/metrics)", file: "diagnose.ts", fn: "checkPermissions", body: "return { lines: [], hidden: 0 };" },
  { cause: "3 permission gap (refused listing)", file: "diagnose.ts", fn: "checkUnseenSubscribers", body: "return null;" },
  { cause: "4 held by Agent Armor", file: "diagnose.ts", fn: "checkHeld", body: "return null;" },
  { cause: "5 no subscriber", file: "diagnose.ts", fn: "checkNoSubscriber", body: "return null;" },
  { cause: "5 catch-up recipe", file: "diagnose.ts", fn: "catchUp", body: "return null;" },
  { cause: "scope (covers)", file: "diagnose.ts", fn: "covers", body: "return true;" },
  { cause: "exit code", file: "diagnose.ts", fn: "exitCode", body: "return 0;" },
];

function runSuite(dir: string): { pass: number; fail: number } {
  const r = spawnSync(process.execPath, ["--test", "test/*.test.ts"], { cwd: dir, encoding: "utf8" });
  const n = (k: string) => Number(new RegExp(`^# ${k} (\\d+)`, "m").exec(r.stdout)?.[1] ?? NaN);
  return { pass: n("pass"), fail: n("fail") };
}

const base = runSuite(ROOT);
console.log(`baseline: pass ${base.pass}, fail ${base.fail}`);
if (base.fail !== 0 || !(base.pass > 0)) process.exit(1);

let survivors = 0;
for (const g of GUARDS) {
  const dir = mkdtempSync(join(tmpdir(), "wnr-mut-"));
  for (const d of ["src", "test", "fixtures"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  const p = join(dir, "src", g.file);
  const s = readFileSync(p, "utf8");
  const re = new RegExp(`(export function ${g.fn}\\([^)]*\\)[^{]*\\{)`);
  if (!re.test(s)) throw new Error(`guard not found: ${g.file} ${g.fn}`);
  writeFileSync(p, s.replace(re, `$1 ${g.body}`));
  const r = runSuite(dir);
  rmSync(dir, { recursive: true, force: true });
  if (!(r.fail > 0)) survivors++;
  console.log(`${r.fail > 0 ? "killed  " : "SURVIVED"}  ${g.fn.padEnd(24)} ${g.cause.padEnd(36)} failing tests: ${r.fail}`);
}
console.log(`mutants: ${GUARDS.length}, killed: ${GUARDS.length - survivors}, survived: ${survivors}`);
process.exit(survivors ? 1 : 0);
