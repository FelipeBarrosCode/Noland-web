#!/usr/bin/env node
import { readFileSync } from "node:fs";

const backend = readFileSync(new URL("../src/lib/backend.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("../src/web/commands.ts", import.meta.url), "utf8");
const nativeMain = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const commandPattern = /invokeSafe(?:<[^;]*?>)?\(\s*["']([^"']+)/gsu;
const casePattern = /case ["']([^"']+)/gu;
const commands = new Set([...backend.matchAll(commandPattern)].map((match) => match[1]));
const covered = new Set([...router.matchAll(casePattern)].map((match) => match[1]));
const missingHelperCommands = [...commands].filter((command) => !nativeMain.includes(command));
if (missingHelperCommands.length > 0) {
  console.error(`Commands missing from the native helper bridge:\n${missingHelperCommands.join("\n")}`);
  process.exit(1);
}
const startupCritical = [
  "get_app_state",
  "get_provisioning_logs",
  "get_setup_status_command",
  "system_health_check",
  "get_cloudflare_turn_settings",
  "get_rented_instances",
  "get_vast_wallet_summary",
  "get_instance_mic_config",
  "get_instance_mic_status",
  "list_microphones",
];
const missingCritical = startupCritical.filter((command) => !covered.has(command));
if (missingCritical.length > 0) {
  console.error(`Missing startup-critical browser commands:\n${missingCritical.join("\n")}`);
  process.exit(1);
}
const implemented = [...commands].filter((command) => covered.has(command)).length;
const percent = Math.round((implemented / commands.size) * 100);
console.log(`Browser command coverage: ${implemented}/${commands.size} (${percent}%)`);
console.log(`Noland Helper command coverage: ${commands.size}/${commands.size} (100%)`);
