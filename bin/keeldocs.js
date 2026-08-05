#!/usr/bin/env node
// keeldocs CLI - init/check/sync/new + slot-write/approve, all live (v0.1).
// Exit codes (ADR-010): 0 clean | 1 findings | 2 tool/config error | 3 degraded.
//
// 3 was documented here, in AGENTS.md and in the core skill as "budget-degraded"
// from v0.1 and NOTHING in src/ ever returned it: three agent-facing files
// described an unreachable state, which is the exact failure this project
// exists to refuse. It is now produced by `keeldocs doctor` and means what the
// architecture doc always said degraded means - the run is usable but partial,
// so warn rather than fail. `check` still never returns 3; its budget-degraded
// case is a design intent with no implementation, and saying so is cheaper than
// a code that no caller can ever observe.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const COMMANDS = ["init", "check", "sync", "new", "interview", "doctor", "answer", "mine", "provider", "skills", "slot-write", "approve"]; // answer/mine/provider/slot-write/approve: plumbing (ADR-012)
const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes("--json");

// D1 escape hatch, global rather than per-command: extraction is cached at the
// provider-subprocess boundary, and every command that extracts must be able to
// refuse it. Set as env because it has to reach nine call sites through several
// library entry points, and because the same variable then works in CI.
if (args.includes("--no-cache")) process.env.KEELDOCS_NO_CACHE = "1";

function envelope(ok, code, summary, next = []) {
  // Hard caps per ADR-010: envelope <= 8KB, summary <= 300 chars.
  return JSON.stringify({ v: 1, ok, code, summary: summary.slice(0, 300), data: {}, next });
}

if (cmd === "--version" || cmd === "-v") { console.log(pkg.version); process.exit(0); }

if (!COMMANDS.includes(cmd)) {
  const msg = `usage: keeldocs <init|check|sync|new|interview|doctor|skills> [--json] [--ci] [--no-cache]  (v${pkg.version})`;
  if (json) console.log(envelope(false, "USAGE", msg));
  else console.error(msg);
  process.exit(2);
}

if (cmd === "check") {
  const { runCheck } = await import("../src/check.js");
  const sIdx = args.indexOf("--since");
  const exit = runCheck({ root: process.cwd(), json, ci: args.includes("--ci"),
    live: args.includes("--live"),
    since: sIdx !== -1 ? args[sIdx + 1] ?? null : null });
  process.exit(exit);
}

// The preflight. Separate command, never a phase of `check`: it probes the
// ENVIRONMENT (spawns interpreters, reads PATH), and `check` is a pure function
// of the tree. Exits 0 ready / 1 blocked / 2 doctor itself failed / 3 degraded.
if (cmd === "doctor") {
  const { runDoctor } = await import("../src/doctor.js");
  process.exit(runDoctor({ root: process.cwd(), json }));
}

if (cmd === "init") {
  const { runInit } = await import("../src/init.js");
  const exit = runInit({ root: process.cwd(), json, yes: args.includes("--yes"), live: args.includes("--live") });
  process.exit(exit);
}

if (cmd === "sync") {
  const { runSync } = await import("../src/sync.js");
  const exit = runSync({ root: process.cwd(), json, args });
  if (exit !== null) process.exit(exit); // null = interactive loop owns exit
}

if (cmd === "new") {
  const { runNew } = await import("../src/newcmd.js");
  process.exit(runNew({ root: process.cwd(), json, args }));
}

if (cmd === "interview") {
  const { runInterview } = await import("../src/interview.js");
  process.exit(runInterview({ root: process.cwd(), json }));
}

if (cmd === "answer") {
  const { runAnswer } = await import("../src/interview.js");
  process.exit(runAnswer({ root: process.cwd(), json, args }));
}

if (cmd === "mine") {
  const { runMine } = await import("../src/interview.js");
  process.exit(runMine({ root: process.cwd(), json }));
}

if (cmd === "provider") {
  const { runProviderCmd } = await import("../src/providercmd.js");
  process.exit(runProviderCmd({ root: process.cwd(), json, args }));
}

if (cmd === "skills") {
  const { installSkills, listAgents } = await import("../src/skillscmd.js");
  const sub = args[1];
  if (sub !== "install") {
    const msg = `usage: keeldocs skills install --agent <${listAgents().join("|")}> [--dry-run] [--json]`;
    if (json) console.log(envelope(false, "USAGE", msg));
    else console.error(msg);
    process.exit(2);
  }
  const ai = args.indexOf("--agent");
  // Every command owes an envelope, and this one owed none: a keeldocs install
  // whose skills/ directory is missing threw ENOENT with a Node stack trace on
  // stdout under --json. The caller here is an agent parsing that stream, so a
  // stack trace is the worst possible shape for the failure to take. Surfaced by
  // the tarball smoke gate, which reached the state by packing without skills/.
  let env;
  try {
    env = installSkills({ agent: ai !== -1 ? args[ai + 1] : "claude-code",
      root: process.cwd(), dryRun: args.includes("--dry-run") });
  } catch (err) {
    env = { ok: false, code: "TOOL_ERROR", data: {},
      summary: `skills install failed: ${String(err.message)}` };
  }
  if (json) console.log(JSON.stringify({ v: 1, ok: env.ok, code: env.code, summary: env.summary.slice(0, 300), data: env.data, next: [] }));
  else {
    console.log(`keeldocs skills - ${env.code}\n${env.summary}`);
    for (const w of env.data.written ?? []) console.log(`  ${w}`);
  }
  process.exit(env.ok ? 0 : 2);
}

if (cmd === "slot-write") {
  const { runSlotWrite } = await import("../src/slots.js");
  process.exit(runSlotWrite({ root: process.cwd(), json, args }));
}

if (cmd === "approve") {
  const { runApprove } = await import("../src/slots.js");
  process.exit(runApprove({ root: process.cwd(), json, args }));
}
