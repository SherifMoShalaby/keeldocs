#!/usr/bin/env node
// keeldocs CLI - init/check/sync/new + slot-write/approve, all live (v0.1).
// Exit codes (ADR-010): 0 clean | 1 findings | 2 tool/config error | 3 budget-degraded
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const COMMANDS = ["init", "check", "sync", "new", "slot-write", "approve"]; // last two: plumbing (ADR-012)
const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes("--json");

function envelope(ok, code, summary, next = []) {
  // Hard caps per ADR-010: envelope <= 8KB, summary <= 300 chars.
  return JSON.stringify({ v: 1, ok, code, summary: summary.slice(0, 300), data: {}, next });
}

if (cmd === "--version" || cmd === "-v") { console.log(pkg.version); process.exit(0); }

if (!COMMANDS.includes(cmd)) {
  const msg = `usage: keeldocs <init|check|sync|new> [--json] [--ci]  (v${pkg.version})`;
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

if (cmd === "slot-write") {
  const { runSlotWrite } = await import("../src/slots.js");
  process.exit(runSlotWrite({ root: process.cwd(), json, args }));
}

if (cmd === "approve") {
  const { runApprove } = await import("../src/slots.js");
  process.exit(runApprove({ root: process.cwd(), json, args }));
}
