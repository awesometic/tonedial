// Shared terminal receipts and warnings.

import type { SizeReport } from "../core/compile.ts";
import type { Warning } from "../core/combos.ts";
import type { Messages } from "../core/i18n.ts";
import type { Palette } from "./style.ts";
import { riskyAxes, type Axes } from "../core/anchors.ts";

/** One blank row separates groups; headings carry no decorative prefix. */
export function section(title: string, ui: Palette): string[] {
  return ["", ...wrap(title, ui.width - 2).map(line => `  ${ui.bold(line)}`)];
}

/** Keep the next action separate and intact for copying into the shell. */
export function nextStep(command: string, ui: Palette): string[] {
  return ["", `  ${ui.accent(humanText(command))}`];
}

/** One advisory notice from the shared axis metadata, without changing selected levels. */
export function riskWarnings(axes: Axes, t: Messages): string[] {
  const risks = riskyAxes(axes);
  return risks.length ? [t.notice.riskAxes(risks)] : [];
}

/** Two retained phases restore their shared config in reverse order, with copyable IDs. */
export function recoveryRollbackLines(t: Messages, appId: unknown, nativeId: unknown): string[] {
  const ids = [nativeId, appId].filter((id): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id));
  if (ids.length === 2) return [
    `  ${t.recovery.rollbackOrder}`,
    ...ids.map(id => `  tonedial doctor --fix --rollback ${id}`),
  ];
  return ids.length === 1 ? t.recovery.rollback(ids[0]!).split("\n").map(line => `  ${line}`) : [];
}
import type { AgentTool } from "../core/paths.ts";
import { isAbsolute } from "node:path";
import { wrap } from "./width.ts";

/** Display values cannot add terminal commands or rows; storage and JSON retain the original. */
export function humanText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, character =>
    character === "\u200c" || character === "\u200d"
      ? character : `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

/** Prose reflows; an explicitly separate path or command remains byte-for-byte copyable. */
export function receiptLines(text: string, width: number): string[] {
  return text.split("\n").flatMap((line, index) =>
    isAbsolute(line) || (index > 0 && /^(?:tonedial|npm) /.test(line)) ? [line] : wrap(line, width));
}

/** Configuration receipts never claim that a host has activated the installed hook. */
export function nativeSetup(
  t: Messages,
  routes: readonly {
    tool: AgentTool;
    path: string;
    inherited: boolean;
    duplicates?: readonly { destination: string; state: "duplicate" | "stale-duplicate" }[];
  }[],
  global: boolean,
): string[] {
  if (!routes.length) return [];
  const lines = routes.map(({ tool, path, inherited }) => inherited
    ? t.wiring.hookInherited(tool, humanText(path)) : t.wiring.hookConfigured(tool, humanText(path)));
  // A project wired earlier keeps delivering after this one. Reported next to the route it
  // doubles, with the scope that owns it, because clearing it is that scope's decision.
  for (const { tool, duplicates } of routes) {
    for (const { destination, state } of duplicates ?? []) {
      lines.push(t.wiring.hookDuplicate(tool, humanText(destination), state === "stale-duplicate"));
    }
  }
  const codex = routes.find(({ tool }) => tool === "codex");
  if (codex) lines.push(t.wiring.codexTrust(global || codex.inherited));
  return lines;
}

/**
 * Thousands separators, written out rather than delegated to `toLocaleString`. Grouping is what
 * makes four digits readable at a glance, and doing it here keeps the output identical whatever
 * locale the process happens to start in.
 */
export function num(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The one shape the artifact's size is reported in, by every command that recompiles. */
export function budget(size: SizeReport, t: Messages): string {
  return t.artifact.budget(num(size.chars), num(size.cap));
}

/** Render combination warnings with the same layer distinction in every command. */
export function combination(w: Warning, t: Messages): string {
  const sentence = t.combos[w.id];
  return w.layer === "forbidden"
    ? `${t.combos.contradiction(w.rule)} ${sentence} ${t.combos.nothingBlocked}`
    : `${t.combos.reads(w.rule)} ${sentence}`;
}
