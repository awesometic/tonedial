// Activate a profile and compile. Schema-1 presets retain the current separate settings.

import type { CommandResult, Ctx } from "../cli.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { riskyAxes } from "../core/anchors.ts";

import { ConfigError, PresetNotFound, serializeConfig } from "../core/config.ts";
import { exportAliasesState, projectTonePath } from "../core/paths.ts";
import { check as checkCombos } from "../core/combos.ts";
import { withPreset, presetSettings, assertPresetSelection, inspectPresetLibrary, resolvePreset } from "../core/presets.ts";
import { applyPlanned, contextCapWarnings, planArtifact, planConfig, unsavedEdits } from "./compile.ts";
import { activationStep } from "./test.ts";
import { planChange, rawReadCheck } from "../wiring/apply.ts";
import { artifactSize, combination, humanText, nextStep, offNotice, riskNotice } from "../ui/format.ts";
import { truncate, wrap } from "../ui/width.ts";

/** The example `USAGE` gives for setting a safeword. */
const SAFEWORD_EXAMPLE = 'tonedial set "safeword=plain answer please"';

/**
 * How much of a preset's name this screen shows. `list` and `show` already truncate; this line
 * did not, so a name from a file written before the cap existed pushed the row past the budget
 * and, with the artifact's own size at the end of it, off the screen.
 */
export async function runUse(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const [slug] = args;
  if (!slug) throw new ConfigError(ctx.t.preset.needsSlugArg);
  const library = inspectPresetLibrary(ctx.paths.presets, ctx.t);
  const known = library.entries.map((entry) => entry.preset.slug);
  const selected = resolvePreset(ctx.paths.presets, slug, ctx.t, library);
  if (selected === null) throw new PresetNotFound(ctx.t, slug, known);
  assertPresetSelection(selected, ctx.t);
  const preset = selected.preset;
  // The resolver's exact source and precedence reads remain bound through publication.
  const presetReads = selected.selectionReads.map((capture) => rawReadCheck(capture, ctx.t));

  const { change: configChange, config } = planConfig(ctx);
  const replaced = unsavedEdits(ctx, config, library, configChange.before);
  const applied = withPreset(config, preset);
  const settingsChanged = !isDeepStrictEqual(
    { axes: config.axes, ...presetSettings(config) },
    { axes: applied.axes, ...presetSettings(applied) },
  );
  Object.assign(config, applied);

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
  // The human receipt names the command that sets a safeword when none is set; the JSON notice
  // keeps its plain "no safeword". The label and the command are separate lines, so the command
  // stays whole and copyable.
  const safeword = config.safeword
    ? wrap(humanText(notice.safeword), ui.width - 2).map((line) => `  ${line}`)
    : [`  ${ctx.t.settings.noSafewordSet}`, ...nextStep(SAFEWORD_EXAMPLE, ui).slice(1)];

  const lines = [
    ...wrap(ctx.t.preset.active(truncate(humanText(preset.displayName), ui.width - 12)), ui.width - 2)
      .map((line) => `  ${ui.success(ui.bold(line))}`),
    `  ${ctx.t.artifact.generated}`,
    ...(ctx.flags.verbose ? [`  ${ui.dim(artifactSize(size, ctx.t))}`] : []),
    ...(replaced.needsSave && settingsChanged ? ["",
      ...wrap(ctx.t.preset.replacedUnsaved(replaced.name === null ? null : humanText(replaced.name)), ui.width - 2).map((line) => `  ${ui.warn(line)}`),
      ...wrap(ctx.t.preset.saveFirst, ui.width - 2).map((line) => `  ${line}`),
      ...nextStep(replaced.saveCommand, ui).slice(1)] : []),
    // Folded here rather than at the printer: `lines` are laid out by the command that built
    // them, and a printer that reflowed them would break every column in the gauge block.
    "",
    ...safeword,
    ...(notice.riskAxes ? wrap(humanText(notice.riskAxes), ui.width - 2).map((folded) => `  ${riskNotice(folded, ui)}`) : []),
    ...project,
    ...(config.enabled ? nextStep(activationStep(ctx, config) ?? "tonedial show", ui) : offNotice(false, ctx.t, ui)),
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
      ...checkCombos(config.axes).map((w) => combination(w, ctx.t)),
      ...contextCapWarnings(config, size.chars, ctx.t),
    ],
  };
}
