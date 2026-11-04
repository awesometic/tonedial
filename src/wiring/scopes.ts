// What is connected where. One owner for the scope rules that `show`, `wire`, `unwire` and
// `doctor` read, so each command answers "which connection" from the same records.

import { homedir } from "node:os";

import { isConfigV2, type Config, type WiringScope } from "../core/config.ts";
import { AGENT_TOOLS, canonicalDestination, type AgentPaths } from "../core/paths.ts";

/** A legacy record names its target only; its scope and directory stay unknown. */
export type Connection = { target: string; scope: WiringScope | null; destination: string | null };

/** Every recorded connection: global first, then projects by directory, then target. */
export function connections(config: Config): Connection[] {
  if (!isConfigV2(config)) return Object.keys(config.wiring).map((target) => ({ target, scope: null, destination: null }));
  return Object.values(config.wiring.registrations)
    .map(({ target, scope, destination }) => ({ target, scope, destination }))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "global" ? -1 : 1) ||
      a.destination.localeCompare(b.destination) || a.target.localeCompare(b.target));
}

/** Connections recorded for one scope at one directory. */
export function connectionsAt(config: Config, scope: WiringScope, directory: string): Connection[] {
  const destination = canonicalDestination(directory);
  return connections(config).filter((connection) => connection.scope === scope && connection.destination === destination);
}

/**
 * The agent connections a folder has of its own, of `tools` when named. This is what makes an
 * unscoped disconnect ambiguous there and what `doctor` points to with `--here`.
 */
export function folderConnections(config: Config, folder: string, tools: readonly string[] = AGENT_TOOLS): Connection[] {
  return connectionsAt(config, "project", folder).filter(({ target }) => tools.includes(target));
}

/** The connections the selected scope of this invocation owns. */
export function connectionsInScope(config: Config, agent: AgentPaths): Connection[] {
  return connectionsAt(config, agent.live ? "global" : "project", agent.root);
}

/** A project scope in the home directory names the files the global scope already owns. */
export function projectIsHome(agent: AgentPaths, env: NodeJS.ProcessEnv): boolean {
  if (agent.live || env.TONEDIAL_AGENT_HOME?.trim()) return false;
  return canonicalDestination(agent.root) === canonicalDestination(env.HOME?.trim() || homedir());
}
