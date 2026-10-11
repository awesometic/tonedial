import { mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { compile } from "../../src/core/compile.ts";
import { defaultConfig, serializeConfig, type ConfigV2 } from "../../src/core/config.ts";
import { toCompileInput } from "../../src/core/resolve.ts";
import { LEGACY_CONTEXT_ARTIFACT_FILENAME, canonicalDestination, resolveAgentPaths, resolvePaths, type AgentTool, type Paths } from "../../src/core/paths.ts";
import { seedFiles, seedRecord, SEED_VERSION } from "../../src/core/seeds.ts";
import { SKILL_NAME } from "../../src/core/skill.ts";
import { catalogue, type Messages } from "../../src/core/i18n.ts";
import { gate, planChange, type Change, type PlannedOperationAction } from "../../src/wiring/apply.ts";
import { contentHash, recordFileChange } from "../../src/wiring/ownership.ts";
import { planSelectedSkills } from "../../src/wiring/skill.ts";
import { TARGETS, wiredAt, type WiredAt } from "../../src/wiring/targets.ts";
import { hookCommand, withHook } from "../../src/wiring/hooks.ts";
import { upsert } from "../../src/wiring/region.ts";
import { palette } from "../../src/ui/style.ts";

export type LegacyRoute = {
  tool: AgentTool;
  root: string;
  scope?: "global" | "project";
};

export type LegacySkillRoute = {
  tools: readonly AgentTool[];
  root: string;
  scope?: "global" | "project";
};

export type LegacyFixtureOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Omit the old artifact when the legacy evidence is the config-only layout. */
  includeArtifact?: boolean;
  /** Reuse the recorded ownership graph when a legacy operation is intentionally repeated. */
  priorConfig?: ConfigV2;
  routes?: readonly LegacyRoute[];
  skills?: readonly LegacySkillRoute[];
};

export type LegacyFixture = {
  paths: Paths;
  config: ConfigV2;
};

function selectedAgent(
  route: { root: string; scope?: "global" | "project" },
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  const scope = route.scope ?? "project";
  if (scope === "global") return resolveAgentPaths({ global: true, project: null }, env, cwd);
  mkdirSync(route.root, { recursive: true });
  return resolveAgentPaths({ global: false, project: route.root }, env, cwd);
}

/** Current native setup never emits this format; the retained fingerprint owner defines it. */
export function legacyDelivery(tool: AgentTool, before: string | null, where: WiredAt, path: string, t: Messages): string {
  return tool === "codex"
    ? withHook(before, hookCommand(where.toneAbsolute, where.home), path, t)
    : upsert(before ?? "", `@${where.tonePath}`);
}

/** Build old-format state and delivery evidence using explicit historical fixture data. */
export async function createLegacyFixture(options: LegacyFixtureOptions): Promise<LegacyFixture> {
  const t = catalogue("en").cli;
  const paths = resolvePaths(options.env);
  mkdirSync(paths.root, { recursive: true });

  const config = options.priorConfig
    ? structuredClone(options.priorConfig)
    : defaultConfig() as ConfigV2;
  const artifactPath = join(paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME);
  const artifact = compile(toCompileInput(config));
  const changes: Change[] = options.includeArtifact === false
    ? []
    : [planChange(artifactPath, () => artifact, t, undefined, paths.root)];
  const shownPath = wiredAt(artifactPath, options.env);

  for (const route of options.routes ?? []) {
    const agent = selectedAgent(route, options.env, options.cwd);
    const scope = route.scope ?? "project";
    const destination = canonicalDestination(agent.root);
    const path = agent.wiredFile(route.tool);
    const change = planChange(
      path,
      (before) => legacyDelivery(route.tool, before, shownPath, path, t),
      t,
    );
    config.wiring = recordFileChange(config.wiring, {
      target: route.tool,
      scope,
      destination,
    }, change, "hook", {
      version: 1,
      handlerSha256: contentHash(legacyDelivery(route.tool, null, shownPath, path, t)),
      ...(TARGETS[route.tool].delivery === "hook" ? { event: "SessionStart" } : { regionId: "tonedial" }),
    }, t);
    changes.push(change);
  }

  const skillRoutes = options.skills ?? [];
  const operationActions: PlannedOperationAction[] = [];
  if (skillRoutes.length > 0) {
    const seeds = seedFiles(paths, { native: true }).filter((seed) => seed.id.startsWith("skill/"));
    const source = join(paths.skill, SKILL_NAME);
    const files: Record<string, string> = {};
    for (const seed of seeds) {
      mkdirSync(dirname(seed.path), { recursive: true });
      files[relative(source, seed.path)] = seed.contents;
      config.managedSeeds[seed.id] = seedRecord(seed);
      changes.push(planChange(seed.path, () => seed.contents, t, undefined, paths.root));
    }
    config.seedVersion = SEED_VERSION;

    const actionIds = new Set<string>();
    for (const route of skillRoutes) {
      const agent = selectedAgent(route, options.env, options.cwd);
      const plan = planSelectedSkills(agent, route.tools, source, config.wiring, files, t);
      config.wiring = plan.wiring;
      for (const action of plan.actions) {
        if (actionIds.has(action.action.id)) continue;
        actionIds.add(action.action.id);
        operationActions.push(action);
      }
    }
  }

  const configChange = planChange(paths.config, (before) => before, t, undefined, paths.root);
  const result = await gate(changes, {
    paths,
    operationActions,
    finalChanges: [{ ...configChange, after: serializeConfig(config) }],
    auto: true,
    dryRun: false,
    t,
    ui: palette("never", {}, false),
    out: () => {},
  });
  if (!result.applied && result.reason !== "nothing") {
    throw new Error(`legacy fixture setup did not apply: ${result.reason}`);
  }
  return { paths, config };
}
