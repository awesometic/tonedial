// What is connected where. One owner for the scope rules that `show`, `wire`, `unwire` and
// `doctor` read, so each command answers "which connection" from the same records.

import { homedir } from "node:os";

import { isConfigV2, type Config, type ConfigV2, type WiringScope } from "../core/config.ts";
import { AGENT_TOOLS, canonicalDestination, resolveAgentPaths, type AgentPaths, type AgentTool } from "../core/paths.ts";
import { registrationKey } from "./ownership.ts";

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

/** The path a registration reaches its recorded hook through, or null when it records none. */
function hookAccess(config: ConfigV2, id: string): string | null {
  const hook = config.wiring.registrations[id]?.resourceIds.map((key) => config.wiring.resources[key])
    .find((resource) => resource?.kind === "hook");
  return hook ? hook.accessPaths?.[id]?.path ?? hook.path : null;
}

/** This home's global destination, whatever `TONEDIAL_AGENT_HOME` redirects. */
function globalAgent(env: NodeJS.ProcessEnv, cwd: string): AgentPaths {
  return resolveAgentPaths({ global: true, project: null }, { ...env, TONEDIAL_AGENT_HOME: undefined }, cwd);
}

/**
 * The global hook file that already delivers `tool` in a project folder, or null.
 *
 * Hosts load their global hooks in every folder, so a project connection beside a global one
 * would add nothing of its own. Before 0.1.14 it was recorded anyway, on the global hook, and
 * that record kept the hook alive after the global connection was removed. A project recorded
 * that way is still covered; a project with a hook file of its own is a separate connection.
 */
export function globalCover(config: Config, agent: AgentPaths, tool: AgentTool, env: NodeJS.ProcessEnv): string | null {
  if (agent.live || !isConfigV2(config)) return null;
  const global = globalAgent(env, agent.root);
  const own = hookAccess(config, registrationKey(tool, "project", canonicalDestination(agent.root)));
  if (own === global.hookFile(tool)) return own;
  const cover = hookAccess(config, registrationKey(tool, "global", canonicalDestination(global.root)));
  return own === null ? cover : null;
}

/** Project connections recorded on this home's global hook file of `tool`, as before 0.1.14. */
export function riders(config: Config, tool: AgentTool, env: NodeJS.ProcessEnv, cwd: string): Connection[] {
  if (!isConfigV2(config)) return [];
  const hookFile = globalAgent(env, cwd).hookFile(tool);
  return connections(config).filter((connection) => connection.target === tool && connection.scope === "project" &&
    hookAccess(config, registrationKey(tool, "project", connection.destination!)) === hookFile);
}
