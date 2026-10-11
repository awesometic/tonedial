// Observe only the exact managed hook's recorded switch.
// The indexed table shape was measured on Codex 0.154.0; unsupported or ambiguous
// records stay unknown. A stored hash is never proof of trust for the current definition.
import { readFileSync } from "node:fs";
import { ConfigError } from "../core/config.ts";
import type { Messages } from "../core/i18n.ts";
import { ownedHookLocations, type HookSpec } from "./hooks.ts";

export type CodexTrust = "disabled" | "unknown";

export function codexHookTrust(
  configPath: string,
  hooksPath: string,
  document: string | null,
  selector: HookSpec | null,
  t: Messages,
): CodexTrust {
  if (selector === null || /["\\\p{Cc}]/u.test(hooksPath)) return "unknown";
  let locations: readonly (readonly [number, number])[];
  try {
    locations = ownedHookLocations(document, selector, hooksPath, t);
  } catch (cause) {
    if (cause instanceof ConfigError) return "unknown";
    throw cause;
  }
  if (locations.length !== 1) return "unknown";
  let text: string;
  try { text = readFileSync(configPath, "utf8"); } catch { return "unknown"; }
  // This narrow observer does not parse TOML string state. Examples inside multiline
  // strings must never become a real switch; an actual TOML reader would justify expansion.
  if (text.includes('"""') || text.includes("'''")) return "unknown";
  const [matcher, handler] = locations[0]!;
  const header = "[hooks.state." + JSON.stringify(hooksPath + ":session_start:" + matcher + ":" + handler) + "]";
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) => line.trim() === header ? [index] : []);
  if (starts.length !== 1) return "unknown";
  const tail = lines.slice(starts[0]! + 1);
  const end = tail.findIndex(line => line.trimStart().startsWith("["));
  const block = end === -1 ? tail : tail.slice(0, end);
  const switches = block.filter(line => /^\s*enabled\s*=/.test(line));
  if (switches.length !== 1) return "unknown";
  return /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(switches[0]!) ? "disabled" : "unknown";
}
