// Save the current axis values, including unsaved changes, as a preset.

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_DEFAULT, AXIS_ORDER, type Axes, type Level } from "../core/anchors.ts";
import { ConfigError, serializeConfig } from "../core/config.ts";
import { BUNDLED, PRESET_SCHEMA, SLUG_PATTERN, preparePresetWrite, presetSettings, resolvePreset, slugify, type Preset, type PresetEntry } from "../core/presets.ts";
import { artifactSize, humanText, nextStep } from "../ui/format.ts";
import { cells, truncate, wrap } from "../ui/width.ts";
import { PERSONA_DESCRIPTION_MAX } from "../core/combos.ts";
import { applyPlanned, planArtifact, planConfig } from "./compile.ts";
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
  const state = planConfig(ctx);
  const selected = ctx.flags.slug ?? state.config.preset;
  const existing = !displayName && selected ? resolvePreset(ctx.paths.presets, selected, ctx.t) : null;
  return savePreset(ctx, displayName || existing?.preset.displayName || "", state,
    existing ? { slug: existing.preset.slug, existing } : {});
}

/** Save and create share one preset/config/artifact transaction. */
export async function savePreset(
  ctx: Ctx,
  displayName: string,
  state: ReturnType<typeof planConfig>,
  options: { slug?: string; create?: boolean; existing?: PresetEntry } = {},
): Promise<CommandResult> {
  if (!displayName) throw new ConfigError(ctx.t.preset.needsDisplayName);

  const slug = options.slug ?? ctx.flags.slug ?? slugify(displayName, ctx.t);
  if (!SLUG_PATTERN.test(slug)) throw new ConfigError(ctx.t.preset.noSlug(slug));
  if (BUNDLED.some((p) => p.slug === slug)) {
    throw new ConfigError(ctx.t.preset.bundledSlug(slug));
  }

  const { change: configChange, config } = state;
  const values = movedValues(config.axes);
  const preset = { schema: PRESET_SCHEMA, slug, displayName, values, settings: presetSettings(config) } satisfies Preset;
  const prepared = preparePresetWrite(ctx.paths.presets, preset, ctx.t, options.existing ? { existing: options.existing } : {});
  const presetBaseline = prepared.capture === null
    ? planChange(prepared.path, (before) => before, ctx.t, undefined, ctx.paths.root)
    : rawReadChange(prepared.capture, ctx.t);
  const presetChange = { ...presetBaseline, after: prepared.contents };
  const selectionReads = prepared.selectionReads.filter((capture) => capture.path !== prepared.path)
    .map((capture) => rawReadCheck(capture, ctx.t));
  const replaced = presetChange.before !== null;
  if (options.create && replaced) throw new ConfigError(ctx.t.create.exists(slug));

  config.preset = slug;
  config.unsaved = false;
  // The slug rides in the generation comment, so saving changes the artifact. Without this
  // the config named a preset that `tone.md` still called `unsaved`.
  const { change: toneChange, size } = planArtifact(ctx, config);
  const finalConfig = { ...configChange, after: serializeConfig(config, ctx.t) };
  const review: string[] = [];
  if (options.create && !ctx.asJson) {
    const address = config.persona.address;
    const details = [
      `${ctx.t.create.reviewHeading} · ${humanText(displayName)} (${slug})`,
      [address?.self_ref ? ctx.t.persona.callsItself(humanText(address.self_ref)) : "",
        address?.user_ref ? ctx.t.persona.callsYou(humanText(address.user_ref)) : ""].filter(Boolean).join(" · "),
      ...(["user", "agent"] as const).map((field) =>
        `${ctx.t.persona.descriptionFull(field, humanText(config.persona[field] ?? ""))} (${ctx.t.create.descriptionCount([...(config.persona[field] ?? "")].length, PERSONA_DESCRIPTION_MAX)})`),
      `${(config.safeword ? ctx.t.settings.safewordSet(humanText(config.safeword)) : ctx.t.settings.noSafeword).split(" — ")[0]} · ${ctx.t.settings.register(config.speech_level)}`,
    ];
    for (const detail of details.filter(Boolean)) review.push(...wrap(detail, ctx.ui.width - 2).map((line) => `  ${line}`));
  }
  const result = await applyPlanned(ctx, [...selectionReads, presetChange, toneChange], [finalConfig], options.create === true, review);

  if (options.create && !result.applied) return {
    lines: [...result.lines, `  ${ctx.t.create.notCreated}`],
    json: { slug, displayName, created: false, reason: result.reason, diff: result.diff },
  };

  const count = Object.keys(values).length;
  const countLabel = ctx.t.preset.nonDefault(count);
  return {
    // Truncated, not folded. A display name has no length cap, and folding one across two lines
    // makes the slug beside it harder to read than losing the tail does.
    lines: [
      ...(options.create ? result.lines : []),
      ...wrap(replaced ? ctx.t.preset.replaced(slug) : ctx.t.preset.savedTarget(slug), ctx.ui.width - 2)
        .map((line) => `  ${ctx.ui.success(ctx.ui.bold(line))}`),
      `  ${truncate(
        humanText(displayName),
        Math.max(1, ctx.ui.width - cells(`    ${countLabel}`)),
      )}  ${ctx.ui.dim(countLabel)}`,
      `  ${ctx.t.artifact.generated}`,
      ...(ctx.flags.verbose ? [`  ${ctx.ui.dim(artifactSize(size, ctx.t))}`] : []),
      ...nextStep("tonedial list", ctx.ui),
    ],
    json: { slug, displayName, values, settings: preset.settings, nonDefaultAxes: count, replaced, chars: size.chars,
      ...(options.create ? { created: true, diff: result.diff, operationId: result.operationId } : {}) },
  };
}
