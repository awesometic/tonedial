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

/** While delivery is paused, a tone change is saved but reaches no new conversation. */
export function offNotice(enabled: boolean, t: Messages, ui: Palette): string[] {
  if (enabled) return [];
  return ["", ...wrap(t.delivery.offNotice, ui.width - 2).map((line) => `  ${ui.warn(line)}`),
    ...nextStep("tonedial on", ui).slice(1)];
}

/** Claude Code replaces hook context above this many characters with a short preview. */
const CLAUDE_CONTEXT_CAP = 10_000;

/** Advisory notice for hook output that Claude Code measures without its final newline. */
export function claudeContextCap(output: number, t: Messages): string[] {
  const measured = output - 1;
  return measured > CLAUDE_CONTEXT_CAP ? [t.artifact.contextCap(num(CLAUDE_CONTEXT_CAP), num(measured))] : [];
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
import { connectionScopeFlag, type AgentTool } from "../core/paths.ts";
import { isAbsolute } from "node:path";
import { wrap } from "./width.ts";
import { TARGETS, type DeliveryDuplicate } from "../wiring/targets.ts";

/** Display values cannot add terminal commands or rows; storage and JSON retain the original. */
export function humanText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, character =>
    character === "\u200c" || character === "\u200d"
      ? character : `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

/** Prose reflows; an explicitly separate path or command remains byte-for-byte copyable. */
const COPYABLE_COMMAND = /^(?:tonedial\s+(?!(?:is\s+not|no\s+est[aá]|が|不在)\s)\S|curl\s+\S|npm\s+(?:(?:i|install|uninstall|update)(?:\s+-[a-z-]+|\s+tonedial)\b|(?:prefix|root)\s+-)|https?:\/\/\S+$)/;

export function isCopyableLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  if (COPYABLE_COMMAND.test(trimmed)) return true;
  const candidate = trimmed.startsWith("→ ") ? trimmed.slice(2).trimStart() : trimmed;
  if (/^\/hooks\s*→/.test(candidate)) return false;
  return isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("<ROOT>/") || candidate.startsWith("<ROOT>\\");
}

export function receiptLines(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) =>
    isCopyableLine(line) ? [line] : wrap(line, width));
}

/**
 * One notice per agent for the project hooks that repeat its global hook. The command for each
 * project names that folder the way the user can run it from where they are: `--here` in the
 * folder, `--project` elsewhere. `globalHook` is given only where the screen does not already
 * show the file.
 */
export function hookDuplicateNotice(
  t: Messages,
  tool: AgentTool,
  duplicates: readonly DeliveryDuplicate[],
  cwd: string,
  globalHook: string | null = null,
): string | null {
  if (duplicates.length === 0) return null;
  return t.wiring.hookDuplicate(TARGETS[tool].label, duplicates.map(({ destination, path, state }) => ({
    hook: humanText(path),
    stale: state === "stale-duplicate",
    command: humanText(`tonedial unwire ${tool} ${connectionScopeFlag({ live: false, root: destination }, cwd)}`),
  })), globalHook === null ? null : humanText(globalHook));
}

/**
 * Configuration receipts never claim that a host has activated the installed hook.
 *
 * One group per host: its status and file, any duplicate it doubles, then that host's own
 * review step. Groups are separated by an empty message, which callers print as a blank line.
 * `guidance: false` leaves the review steps to a report that follows with its own per-host copy.
 */
export function nativeSetup(
  t: Messages,
  routes: readonly {
    tool: AgentTool;
    path: string;
    duplicates?: readonly DeliveryDuplicate[];
  }[],
  global: boolean,
  cwd: string,
  guidance = true,
): string[] {
  const groups = routes.map(({ tool, path, duplicates }) => {
    const label = TARGETS[tool].label;
    const lines = [t.wiring.hookConfigured(label, humanText(path))];
    // A project wired earlier keeps delivering after this one. Reported next to the route it
    // doubles, with the scope that owns it, because clearing it is that scope's decision.
    const doubled = hookDuplicateNotice(t, tool, duplicates ?? [], cwd);
    if (doubled !== null) lines.push(doubled);
    if (guidance) {
      if (tool === "codex") lines.push(t.wiring.codexTrust(global));
      else if (tool === "claude") lines.push(t.wiring.claudeTrust(global));
      else lines.push(t.doctor.hookGuidance[tool]);
    }
    return lines;
  });
  return groups.flatMap((lines, index) => index === 0 ? lines : ["", ...lines]);
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
export function artifactSize(size: SizeReport, t: Messages): string {
  return t.artifact.size(num(size.chars));
}

/** Contradictions stay advisory and never block the selected values. */
export function combination(w: Warning, t: Messages): string {
  return `${t.combos.contradiction(w.rule)} ${t.combos[w.id]} ${t.combos.nothingBlocked}`;
}
