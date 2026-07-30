#!/usr/bin/env node
// keeldocs CLI skeleton - envelope contract + exit codes are REAL, commands are stubs.
// Exit codes (ADR-010): 0 clean | 1 findings | 2 tool/config error | 3 budget-degraded
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
const COMMANDS = ["init", "check", "sync", "new"];
const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes("--json");

function envelope(ok, code, summary, next) {
  // Hard caps per ADR-010: envelope <= 8KB, summary <= 300 chars.
  return JSON.stringify({ v: 1, ok, code, summary: summary.slice(0, 300), data: {}, next }, null, 0);
}

if (cmd === "--version" || cmd === "-v") { console.log(pkg.version); process.exit(0); }

if (!COMMANDS.includes(cmd)) {
  const msg = `usage: keeldocs <init|check|sync|new> [--json]  (v${pkg.version})`;
  if (json) console.log(envelope(false, "USAGE", msg, []));
  else console.error(msg);
  process.exit(2);
}

const msg = `keeldocs ${cmd}: not implemented yet - engine lands per docs/design/07-scope-roadmap.md`;
if (json) console.log(envelope(false, "NOT_IMPLEMENTED", msg, ["see docs/design/02-architecture.md"]));
else console.error(msg);
process.exit(2);
