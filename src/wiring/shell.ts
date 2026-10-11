// Approved native setup may add the curl command's PATH line. Disconnect preserves it.

import type { AgentPaths } from "../core/paths.ts";
import { KNOWN_SHELLS, shellProfile } from "../core/paths.ts";
import { SHELL, find, upsert } from "./region.ts";

/**
 * The PATH line, spelled for the shell whose rc it is going into.
 *
 * One line for every shell was wrong in a way the region mechanism hid perfectly: `# tonedial:`
 * is a valid fish comment, so an `export PATH=…` payload round-tripped and idempotently updated
 * while erroring on every new fish shell with PATH still unset.
 */
export function pathLine(bin: string, shell?: string): string {
  return shellProfile(shell).line(bin);
}

/**
 * Where the line goes for this shell, and what the file should become.
 *
 * `$SHELL` is read rather than the parent process, because the installer runs under `sh` from
 * a pipe and the rc file that matters is the one the user's *interactive* shell reads.
 */
export function rcPath(agent: AgentPaths, env: NodeJS.ProcessEnv = process.env): string {
  return agent.rc(env.SHELL);
}

export function withPathLine(before: string | null, bin: string, shell?: string): string {
  return upsert(before ?? "", pathLine(bin, shell), SHELL);
}

/** Whether the rc file already carries our line, and whether it still points where it should. */
export function pathLineState(
  text: string | null,
  bin: string,
  shell?: string,
): "absent" | "current" | "stale" {
  if (text === null) return "absent";
  const found = find(text, SHELL);
  if (!found) return "absent";
  return found.content === pathLine(bin, shell) ? "current" : "stale";
}

/** Doctor inspects prior shell profiles after the user changes shells. */
export function candidateRcPaths(agent: AgentPaths, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = [agent.rc(env.SHELL), ...KNOWN_SHELLS.map((shell) => agent.rc(shell))];
  return [...new Set(paths)];
}
