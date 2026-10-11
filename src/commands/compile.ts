// Recompile the artifact from the current state, or report its size without writing.

import type { CommandResult, Ctx } from "../cli.ts";
import { lstatSync } from "node:fs";
import { compile, measure, type SizeReport } from "../core/compile.ts";
import { ConfigError, defaultConfig, parseConfig, type Config } from "../core/config.ts";
import { toCompileInput } from "../core/resolve.ts";
import { contextArtifactTargets } from "../core/seeds.ts";
import type { Messages } from "../core/i18n.ts";
import { budget, humanText, num } from "../ui/format.ts";
import { wrap } from "../ui/width.ts";
import { captureRawEntry, gate, planChange, rawReadChange, type Change } from "../wiring/apply.ts";

type ArtifactChange = Change & { contextCompanions?: Change[] };

function artifactChange(ctx: Ctx, target: ReturnType<typeof contextArtifactTargets>[number], artifact: string): Change {
  if (target.capture?.type === "symlink") throw new ConfigError(ctx.t.errors.staleTarget(target.path));
  return target.capture === null
    ? planChange(target.path, () => artifact, ctx.t, undefined, ctx.paths.root)
    : { ...rawReadChange(target.capture, ctx.t), after: artifact };
}

/** Capture the config before any command reads or transforms it. */
export function planConfig(ctx: Ctx): { change: Change; config: Config } {
  const change = planChange(ctx.paths.config, (before) => before, ctx.t, undefined, ctx.paths.root);
  const config = change.before === null ? defaultConfig() : parseConfig(change.before, ctx.t);
  return { change, config };
}

/** Compile a candidate config and plan the artifact without writing either resource. */
export function planArtifact(ctx: Ctx, config: Config): { change: Change; artifact: string; size: SizeReport } {
  const artifact = compile(toCompileInput(config));
  const size = measure(artifact);
  const targets = contextArtifactTargets(ctx.paths, ctx.t);
  const change: ArtifactChange = { ...artifactChange(ctx, targets[0]!, artifact),
    contextCompanions: targets.slice(1).map((target) => artifactChange(ctx, target, artifact)) };
  return { change, artifact, size };
}

/** Shared direct-command gate settings: no prompt or diff is emitted by the command itself. */
export async function applyPlanned(
  ctx: Ctx,
  changes: Change[],
  finalChanges: Change[] = [],
): Promise<Awaited<ReturnType<typeof gate>>> {
  const artifact = changes.find((change) => (change as ArtifactChange).contextCompanions !== undefined) as ArtifactChange | undefined;
  const synchronized = [...changes];
  if (artifact?.after !== null && artifact?.after !== undefined) {
    for (const companion of artifact.contextCompanions!) {
      if (!synchronized.some((change) => change.path === companion.path)) synchronized.push(companion);
    }
  }
  return gate([...(ctx.contextChecks ?? []), ...synchronized], {
    paths: ctx.paths,
    finalChanges,
    interactive: () => ctx.canPrompt,
    out: () => {},
    dryRun: ctx.flags.dryRun,
    t: ctx.t,
    auto: true,
    ui: ctx.ui,
  });
}

export function sizeWarning(size: SizeReport, t: Messages): string[] {
  // It warns and never fails: a user is entitled to switch every axis on, and a budget that
  // refuses to compile is a different product.
  if (size.overCap) return [t.artifact.overCap(num(size.chars), num(size.cap))];
  if (size.overTarget) return [t.artifact.overTarget(num(size.chars), num(size.target))];
  return [];
}

export async function runCompile(ctx: Ctx): Promise<CommandResult> {
  const check = ctx.flags.check;
  const { change: configChange, config } = planConfig(ctx);
  let size: SizeReport;
  let status = ctx.t.artifact.wouldWrite;
  let current = false;
  if (check) {
    const expected = compile(toCompileInput(config));
    size = measure(expected);
    // JSON check retains its size/path-only contract. Human comparison is bounded and
    // lexical: links are never followed, and an unavailable comparison is never "current".
    if (!ctx.asJson) {
      try {
        const root = lstatSync(ctx.paths.root, { throwIfNoEntry: false });
        const actual = root === undefined ? null : captureRawEntry(ctx.paths.tone, ctx.t, {
          within: ctx.paths.root, allowLink: true, allowDirectory: true,
        });
        current = actual?.type === "regular" && actual.bytes!.equals(Buffer.from(expected));
        status = current ? ctx.t.artifact.current : actual === null || actual.type === "missing"
          ? ctx.t.artifact.missing : actual.type === "regular" ? ctx.t.artifact.stale : ctx.t.artifact.uninspected;
      } catch (cause) {
        if (!(cause instanceof ConfigError) && !(cause as NodeJS.ErrnoException).code) throw cause;
        status = ctx.t.artifact.uninspected;
      }
    }
  } else {
    const planned = planArtifact(ctx, config);
    size = planned.size;
    current = planned.change.before === planned.change.after;
    status = current ? ctx.t.artifact.current : ctx.t.artifact.generated;
    // `compile --check` is explicitly read-only; the regular form still uses the same
    // operation owner as every other direct state mutation.
    await applyPlanned(ctx, [configChange, planned.change]);
  }

  return {
    // The path goes on a line of its own and is never folded. A filesystem path is a single
    // unbreakable token a user copies, and a hard wrap in the middle of one makes it useless —
    // so this is the one line left to the terminal's own soft wrap rather than to the budget.
    lines: [
      ...wrap(status, ctx.ui.width - 2).map(line => `  ${ctx.ui.bold((!check || current ? ctx.ui.success : ctx.ui.warn)(line))}`),
      `  ${humanText(ctx.paths.tone)}`,
      `  ${size.overCap ? ctx.ui.error(budget(size, ctx.t)) : ctx.ui.dim(budget(size, ctx.t))}`,
      `  ${ctx.ui.accent(check && !current ? "tonedial compile" : "tonedial show")}`,
    ],
    json: { path: ctx.paths.tone, agentsPath: ctx.paths.agents, written: !check, ...size },
    warnings: sizeWarning(size, ctx.t),
  };
}
