#!/usr/bin/env node
// Runs both real-engine canary arms — UI and MCP — and reports a combined
// result. Unlike `canary:ui && canary:mcp`, a failure in the first arm does NOT
// skip the second: both arms always run, so one red arm can never silently hide
// the other's status. Exits non-zero if EITHER arm fails.
//
// The arms run sequentially (not in parallel) because each boots its own engine
// host; running them at once would contend for ports.
import { spawnSync } from "node:child_process";

const arms = [
  { name: "UI", script: "canary:ui" },
  { name: "MCP", script: "canary:mcp" },
];

const results = [];
for (const arm of arms) {
  console.log(`\n=== canary: ${arm.name} arm (pnpm ${arm.script}) ===`);
  const { status } = spawnSync("pnpm", [arm.script], {
    stdio: "inherit",
    shell: true,
  });
  results.push({ name: arm.name, status: status ?? 1, ok: status === 0 });
}

console.log("\n=== canary summary ===");
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} arm (exit ${r.status})`);
}

process.exit(results.some((r) => !r.ok) ? 1 : 0);
