// Activate a profile and compile. Schema-1 presets retain the current separate settings.

import type { CommandResult, Ctx } from "../cli.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { riskyAxes } from "../core/anchors.ts";

import { ConfigError, serializeConfig } from "../core/config.ts";
import { exportAliasesState, projectTonePath } from "../core/paths.ts";
import { check as checkCombos } from "../core/combos.ts";
import { withPreset, assertPresetSelection, inspectPresetLibrary, resolvePreset } from "../core/presets.ts";
import { applyPlanned, planArtifact, planConfig, sizeWarning } from "./compile.ts";
import { planChange, rawReadCheck } from "../wiring/apply.ts";
import { budget, combination, humanText, nextStep } from "../ui/format.ts";
import { truncate, wrap } from "../ui/width.ts";

/**
 * How much of a preset's name this screen shows. `list` and `show` already truncate; this line
 * did not, so a name from a file written before the cap existed pushed the row past the budget
 * and, with the artifact's own size at the end of it, off the screen.
 */
export async function runUse(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const [slug] = args;
  const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
  const known = library.entries.map((entry) => entry.preset.slug);
  const selected = slug ? resolvePreset(ctx.paths.presets, slug, ctx.t, library) : null;
  if (selected === null) throw new ConfigError(ctx.t.preset.unknown(slug ?? "", known));
  assertPresetSelection(selected, ctx.t);
  const preset = selected.preset;
  // The resolver's exact source and precedence reads remain bound through publication.
  const presetReads = selected.selectionReads.map((capture) => rawReadCheck(capture, ctx.t));

  const { change: configChange, config } = planConfig(ctx);
  Object.assign(config, withPreset(config, preset));

  const { change: toneChange, size } = planArtifact(ctx, config);
  const changes = [toneChange];
  // A user preset is part of the read set even though this command does not modify it. The
  // shared gate rechecks it while holding the operation owner, so an editor cannot replace the
  // preset between selection and the config/artifact commit.
  changes.unshift(...presetReads);

  const ui = ctx.ui;

  // The project layer: one artifact in the project directory and nothing else. It has to work
  // for someone without tonedial installed, so it is the compiled file itself rather than a
  // link to a home this repository's other collaborators do not have.
  const project: string[] = [];
  const projectPath = ctx.flags.project === null ? null : projectTonePath(ctx.agent.root);
  if (projectPath !== null) {
    // The same destination axis every other command reads, so `--project ../sibling` means here
    // what it means to `init` — one resolution in `paths.ts` rather than a second one per command.
    if (exportAliasesState(ctx.paths, ctx.agent.root)) {
      throw new ConfigError(ctx.t.errors.stateOverlap(projectPath));
    }
    changes.push(planChange(projectPath, () => toneChange.after, ctx.t));
    project.push(`  ${ui.success(ctx.t.artifact.wrote)}`, `  ${humanText(projectPath)}`);
    // This check is only advisory and never creates the project or its metadata.
    if (existsSync(join(ctx.agent.root, ".git"))) {
      // Suggested rather than done. `.git/info/exclude` is the repository's file and this one
      // is not ours to edit — and a project artifact is often exactly what a team wants shared.
      project.push(
        ...wrap(ctx.t.wiring.projectExclude, ui.width - 2).map((line) => `  ${line}`),
        `  ${ui.accent("echo .tonedial/ >> .git/info/exclude")}`,
      );
    }
  }

  const finalConfig = { ...configChange, after: serializeConfig(config, ctx.t) };
  await applyPlanned(ctx, changes, [finalConfig]);

  // Keyed disclosure keeps machine fields stable while the advisory axis notice is optional.
  const risks = riskyAxes(config.axes);
  const notice = {
    safeword: config.safeword ? ctx.t.settings.safewordSet(config.safeword) : ctx.t.settings.noSafeword,
    riskAxes: risks.length ? ctx.t.notice.riskAxes(risks) : null,
    risk: ctx.t.notice.risk,
    roleplay: config.axes.playfulness >= 4 ? ctx.t.notice.roleplay : null,
  };
  const notices = [notice.safeword, ...(notice.riskAxes ? [notice.riskAxes] : []), notice.risk];

  const lines = [
    ...wrap(ctx.t.preset.active(truncate(humanText(preset.displayName), ui.width - 12)), ui.width - 2)
      .map((line) => `  ${ui.success(ui.bold(line))}`),
    `  ${ctx.t.artifact.generated}`,
    ...(ctx.flags.verbose ? [`  ${ui.dim(budget(size, ctx.t))}`] : []),
    // Folded here rather than at the printer: `lines` are laid out by the command that built
    // them, and a printer that reflowed them would break every column in the gauge block.
    "",
    ...notices.flatMap((n) => wrap(humanText(n), ui.width - 2).map((folded) => `  ${n === notice.riskAxes ? ui.risk(folded) : n === notice.risk ? ui.warn(folded) : folded}`)),
    ...project,
    ...nextStep("tonedial show", ui),
  ];

  return {
    lines,
    // The notice is disclosure the product owes on every `use`, and a skill drives this path
    // rather than the human one — so it travels as fields, not only as prose.
    json: {
      preset: preset.slug,
      displayName: preset.displayName,
      axes: config.axes,
      chars: size.chars,
      riskAxes: risks,
      safeword: config.safeword,
      notice,
      project: projectPath,
    },
    warnings: [
      ...(notice.roleplay ? [notice.roleplay] : []),
      ...checkCombos(config.axes, config.persona, config.speech_level).map((w) => combination(w, ctx.t)),
      ...sizeWarning(size, ctx.t),
    ],
  };
}
