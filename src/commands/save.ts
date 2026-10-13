// Save the current axis values, including unsaved changes, as a preset.

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, AXIS_ORDER, type Axes, type Level } from "../core/anchors.ts";
import { ConfigError, serializeConfig } from "../core/config.ts";
import { BUNDLED, SLUG_PATTERN, preparePresetWrite, slugify, type Preset } from "../core/presets.ts";
import { budget, humanText, nextStep } from "../ui/format.ts";
import { cells, truncate } from "../ui/width.ts";
import { applyPlanned, planArtifact, planConfig, sizeWarning } from "./compile.ts";
import { planChange, rawReadChange, rawReadCheck } from "../wiring/apply.ts";

/** Only the axes that moved. Every axis is still emitted; sparsity is storage, not compilation. */
function movedValues(axes: Axes): Preset["values"] {
  const values: Preset["values"] = {};
  for (const axis of AXIS_ORDER) {
    if (axes[axis] !== AXIS_DEFAULT[axis]) values[axis] = axes[axis] as Level;
  }
  return values;
}

export async function runSave(ctx: Ctx, args: string[]): Promise<CommandResult> {
  const displayName = args.join(" ").trim();
  if (!displayName) throw new ConfigError(ctx.t.preset.needsDisplayName);

  const slug = slugify(displayName, ctx.t);
  if (!SLUG_PATTERN.test(slug)) throw new ConfigError(ctx.t.preset.invalidSlugFor(displayName));
  if (BUNDLED.some((p) => p.slug === slug)) {
    throw new ConfigError(ctx.t.preset.bundledSlug(slug));
  }

  const { change: configChange, config } = planConfig(ctx);
  const values = movedValues(config.axes);
  const preset = { schema: 1, slug, displayName, values } satisfies Preset;
  const prepared = preparePresetWrite(ctx.paths.presets, preset, ctx.t);
  const presetBaseline = prepared.capture === null
    ? planChange(prepared.path, (before) => before, ctx.t, undefined, ctx.paths.root)
    : rawReadChange(prepared.capture, ctx.t);
  const presetChange = { ...presetBaseline, after: prepared.contents };
  const selectionReads = prepared.selectionReads.filter((capture) => capture.path !== prepared.path)
    .map((capture) => rawReadCheck(capture, ctx.t));
  const replaced = presetChange.before !== null;

  config.preset = slug;
  config.unsaved = false;
  // The slug rides in the generation comment, so saving changes the artifact. Without this
  // the config named a preset that `tone.md` still called `unsaved`.
  const { change: toneChange, size } = planArtifact(ctx, config);
  const finalConfig = { ...configChange, after: serializeConfig(config, ctx.t) };
  await applyPlanned(ctx, [...selectionReads, presetChange, toneChange], [finalConfig]);

  const count = Object.keys(values).length;
  const countLabel = ctx.t.preset.nonDefault(count);
  const warnings: string[] = [...sizeWarning(size, ctx.t)];
  if (replaced) warnings.push(ctx.t.preset.replaced(slug));
  // Sparsity survives on one reason after the omit-defaults rule fell: fewer extremes mean
  // fewer internal collisions. It is guidance, so it warns and never blocks.
  if (count < 3 || count > 7) {
    warnings.push(ctx.t.preset.sparsity(slug, count));
  }
  warnings.push(ctx.t.preset.userLevelNotCaptured);

  return {
    // Truncated, not folded. A display name has no length cap, and folding one across two lines
    // makes the slug beside it harder to read than losing the tail does.
    lines: [
      `  ${ctx.ui.success(ctx.ui.bold(ctx.t.preset.savedTarget(slug)))}`,
      `  ${truncate(
        humanText(displayName),
        Math.max(1, ctx.ui.width - cells(`    ${countLabel}`)),
      )}  ${ctx.ui.dim(countLabel)}`,
      `  ${ctx.t.artifact.generated}`,
      ...(ctx.flags.verbose ? [`  ${ctx.ui.dim(budget(size, ctx.t))}`] : []),
      ...nextStep("tonedial list", ctx.ui),
    ],
    json: { slug, displayName, values, nonDefaultAxes: count, replaced, chars: size.chars },
    warnings,
  };
}
