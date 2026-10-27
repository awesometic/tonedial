// Shared existing-state preparation for init and doctor. External integrations are a separate
// phase: historical delivery data never grants this application rebuild new native authority.
import { createInterface } from "node:readline/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { CommandResult, Ctx } from "../cli.ts";
import { AXIS_ORDER, riskyAxes } from "../core/anchors.ts";
import {
  ConfigError, defaultConfig, isConfigV2, parseConfig, recoverSettings, requireConfigV2,
  serializeConfig, type ConfigV2, type LegacyOwnershipEvidence, type SettingsRecovery,
} from "../core/config.ts";
import { compile } from "../core/compile.ts";
import { toCompileInput } from "../core/resolve.ts";
import { isLanguage, LANGUAGES, type Messages } from "../core/i18n.ts";
import { recoverLegacyTone } from "../core/legacy-tone.ts";
import { connectionScopeFlag, exportAliasesState, stateOverlapsInstructions } from "../core/paths.ts";
import {
  applyPreset, matchesPreset, assertPresetSelection, BUNDLED, customPresetDir, inspectPresetLibrary, parsePreset, PRESET_MAX_BYTES,
  resolvePreset, serializePreset, SLUG_PATTERN, type PresetEntry, type PresetLibrary,
} from "../core/presets.ts";
import {
  contextArtifactTargets, generatedSeedSelection, planGeneratedSeedRebuild, seedFiles, SEED_VERSION,
} from "../core/seeds.ts";
import {
  inspectOperations, readJournal, retireOperationForAppRebuild, serializeOperationQuarantine, type JsonValue,
  type OperationAction, type OperationJournal, type RecoveryPhase,
} from "../core/operations.ts";
import {
  assertFresh, captureRawEntry, gate, planEntryRebuild, rawReadCheck, validateFileAction,
  type Change, type PlannedOperationAction, type RawEntryCapture,
} from "../wiring/apply.ts";
import { confirm } from "../ui/prompt.ts";
import { wrap } from "../ui/width.ts";
import { parseToolSelection } from "../wiring/targets.ts";
import { riskWarnings } from "../ui/format.ts";

export type AppRebuildResult = CommandResult & ({
  quarantineOnly: true;
  rebuiltConfig: null;
  proposedConfig: null;
  legacy: null;
} | {
  quarantineOnly: false;
  rebuiltConfig: ConfigV2 | null;
  /** Validated proposal for strictly read-only planning of the next phase. Never serialized. */
  proposedConfig: ConfigV2;
  legacy: LegacyOwnershipEvidence | null;
});

const CONFIG_MAX_BYTES = 1024 * 1024;
const scalarFields = ["enabled", "preset", "unsaved", "safeword", "speech_level", "address_frequency", "language"] as const;
const personaFields = ["age", "gender", "note", "user", "agent"] as const;

function capturedText(capture: RawEntryCapture): string | null {
  if (capture.type !== "regular" || capture.bytes === null) return null;
  const text = capture.bytes.toString("utf8");
  return Buffer.from(text).equals(capture.bytes) ? text : null;
}

/** Copy independently validated leaves, so a damaged neighbor cannot reset surviving data. */
function mergeSettings(config: ConfigV2, source: SettingsRecovery, kept: Set<string>): void {
  const valid = new Set(source.recovered.filter((field) => !source.invalid.includes(field)));
  const defaulted = new Set(source.defaulted ?? []);
  for (const field of scalarFields) {
    if (!kept.has(field) && valid.has(field)) {
      Object.assign(config, { [field]: source.config[field] });
      kept.add(field);
    }
  }
  for (const axis of AXIS_ORDER) {
    const field = `axes.${axis}`;
    if (!kept.has(field) && (valid.has(field) || valid.has("axes"))) {
      config.axes[axis] = source.config.axes[axis];
      kept.add(field);
    }
  }
  for (const key of personaFields) {
    const field = `persona.${key}`;
    if (!kept.has(field) && !defaulted.has(field) && (valid.has(field) || valid.has("persona"))) {
      config.persona[key] = source.config.persona[key];
      kept.add(field);
    }
  }
  for (const key of ["self_ref", "user_ref"] as const) {
    const field = `persona.address.${key}`;
    if (!kept.has(field) && !defaulted.has(field) && !defaulted.has("persona.address") &&
      (valid.has(field) || valid.has("persona.address") || valid.has("persona"))) {
      const address = config.persona.address ?? { self_ref: null, user_ref: null };
      address[key] = source.config.persona.address?.[key] ?? null;
      config.persona.address = address.self_ref || address.user_ref ? address : null;
      kept.add(field);
    }
  }
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Read only regular same-boundary data snapshots; journal target paths are never replayed. */
function snapshotText(action: OperationAction, snapshot: JsonValue, path: string, root: string): string | null {
  if (action.path !== path || action.realPath !== path) return null;
  const record = object(snapshot);
  if (record === null || typeof record.bytes !== "string") return null;
  if (typeof record.mode !== "number" || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o7777) return null;
  if (action.kind === "file") {
    try { validateFileAction(action); } catch { return null; }
    if (record.exists !== true || record.symbolicLink !== false || record.realPath !== path || record.resolvedPath !== path) return null;
  } else if (action.kind === "entry-rebuild") {
    if (object(action.metadata)?.boundary !== root || record.type !== "regular" || record.linkTarget !== null) return null;
    if (typeof record.identity !== "string" || !/^\d+:\d+$/.test(record.identity)) return null;
  } else return null;
  const bytes = Buffer.from(record.bytes, "base64");
  if (bytes.length > CONFIG_MAX_BYTES || bytes.toString("base64") !== record.bytes) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? text : null;
}

function selectedJournal(ctx: Ctx, id: string): { journal: OperationJournal; capture: RawEntryCapture } {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new ConfigError(ctx.t.recovery.noSnapshot(id));
  const capture = captureRawEntry(join(ctx.paths.operations, `${id}.json`), ctx.t, { within: ctx.paths.root, maxBytes: 16 * CONFIG_MAX_BYTES });
  const text = capturedText(capture);
  const journal = readJournal(ctx.paths, id);
  if (text === null || journal === null || JSON.stringify(JSON.parse(text)) !== JSON.stringify(journal)) {
    throw new ConfigError(ctx.t.recovery.noSnapshot(id));
  }
  // Old action history need not have a usable rollback witness. Only typed config/preset
  // snapshots are data sources, and their own semantics are checked when selected below.
  return { journal, capture };
}

function snapshotSettings(ctx: Ctx, journal: OperationJournal): SettingsRecovery | null {
  for (const phase of ["before", "after"] as const) {
    for (const action of journal.actions) {
      const text = snapshotText(action, action[phase], ctx.paths.config, ctx.paths.root);
      if (text === null) continue;
      const recovered = recoverSettings(text, ctx.t);
      if (recovered !== null && recovered.recovered.length > 0) return recovered;
    }
  }
  return null;
}

async function choosePreset(ctx: Ctx, library: PresetLibrary): Promise<PresetEntry> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`  ${ctx.t.recovery.choosePreset}\n`);
    library.entries.forEach((entry, index) => process.stdout.write(`  ${index + 1}. ${entry.preset.slug}\n`));
    for (;;) {
      const answer = (await input.question("  > ")).trim();
      const chosen = /^\d+$/.test(answer) ? library.entries[Number(answer) - 1]
        : resolvePreset(ctx.paths.presets, answer, ctx.t, library);
      if (chosen) return chosen;
      process.stdout.write(`  ${ctx.t.recovery.sourceInvalid}\n`);
    }
  } finally { input.close(); }
}

async function resolveActiveConflict(ctx: Ctx, config: ConfigV2, library: PresetLibrary): Promise<void> {
  const conflict = library.conflicts.find(({ slug }) => slug === config.preset);
  if (conflict === undefined || conflict.resolved && config.seedVersion === SEED_VERSION) return;
  const selected = ctx.flags.fromPreset;
  if (selected === conflict.slug || selected === conflict.recovery.preset.slug) {
    config.preset = selected;
    return;
  }
  if (ctx.flags.auto || !ctx.canPrompt) throw new ConfigError(ctx.t.recovery.sourceRequired);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`  ${ctx.t.recovery.activeChoice(conflict.slug)}\n`);
    process.stdout.write(`  1. ${conflict.slug}\n  2. ${conflict.recovery.preset.slug}\n  3. ${ctx.t.preset.unsaved}\n`);
    for (;;) {
      const choice = (await input.question("  > ")).trim();
      if (choice === "1") { config.preset = conflict.slug; return; }
      if (choice === "2") { config.preset = conflict.recovery.preset.slug; return; }
      if (choice === "3") { config.preset = null; config.unsaved = true; return; }
      process.stdout.write(`  ${ctx.t.recovery.sourceInvalid}\n`);
    }
  } finally { input.close(); }
}

function restoreSelectedPreset(ctx: Ctx, library: PresetLibrary, journal: OperationJournal | null): { action: PlannedOperationAction; capture: RawEntryCapture; slug: string } | null {
  const slug = ctx.flags.restorePreset;
  if (!slug) return null;
  if (journal === null || !SLUG_PATTERN.test(slug) || Buffer.byteLength(`${slug}.json`) > 255 || BUNDLED.some(preset => preset.slug === slug)) {
    throw new ConfigError(ctx.t.recovery.sourceInvalid);
  }
  const candidates = [join(customPresetDir(ctx.paths.presets), `${slug}.json`), join(ctx.paths.presets, `${slug}.json`)];
  const unavailable = library.unavailable.find(entry => entry.slug === slug && candidates.includes(entry.path));
  if (!unavailable && resolvePreset(ctx.paths.presets, slug, ctx.t, library)) throw new ConfigError(ctx.t.recovery.sourceInvalid);
  const path = unavailable?.path ?? journal.actions.find(action => candidates.includes(action.path))?.path;
  if (path === undefined) throw new ConfigError(ctx.t.recovery.sourceInvalid);
  // Capture raw damaged bytes before trying any decoder. Root, ancestor and user links refuse.
  const capture = captureRawEntry(path, ctx.t, { within: ctx.paths.root, maxBytes: PRESET_MAX_BYTES });
  for (const phase of ["before", "after"] as const) {
    for (const action of journal.actions) {
      if (action.path !== path) continue;
      const text = snapshotText(action, action[phase], action.path, ctx.paths.root);
      if (text === null || Buffer.byteLength(text) > PRESET_MAX_BYTES) continue;
      try {
        const preset = parsePreset(text, slug, ctx.t);
        const savedMode = object(action[phase])!.mode as number;
        const plan = planEntryRebuild(capture, serializePreset(preset), ctx.t, { reason: "restore-preset", mode: capture.mode ?? savedMode });
        return { action: plan.action, capture, slug };
      } catch { /* Another typed snapshot may be usable; parser excerpts stay private. */ }
    }
  }
  throw new ConfigError(ctx.t.recovery.sourceInvalid);
}

function privateCapture(capture: RawEntryCapture): JsonValue {
  return { path: capture.path, type: capture.type, identity: capture.identity, mode: capture.mode,
    bytes: capture.bytes?.toString("base64") ?? null, linkTarget: capture.linkTarget,
    boundary: capture.boundary, boundaryIdentity: capture.boundaryIdentity,
    parents: capture.parents.map(parent => ({ ...parent })) };
}

function planOperationQuarantine(ctx: Ctx, entry: ReturnType<typeof inspectOperations>["journals"][number]): PlannedOperationAction {
  const capture = captureRawEntry(entry.path, ctx.t, { within: ctx.paths.root });
  if (capture.type !== "regular" || capture.bytes === null) throw new ConfigError(ctx.t.recovery.quarantineUnavailable(entry.operationId));
  return planEntryRebuild(capture, serializeOperationQuarantine(ctx.paths, entry.operationId, capture.bytes), ctx.t,
    { reason: "quarantine-operation", mode: capture.mode ?? 0o600 }).action;
}

async function quarantineOneOperation(
  ctx: Ctx,
  entry: ReturnType<typeof inspectOperations>["journals"][number],
  remaining: readonly string[],
): Promise<AppRebuildResult> {
  const action = planOperationQuarantine(ctx, entry);
  const presentation = [ctx.t.recovery.quarantine(entry.operationId)]
    .flatMap(line => wrap(line, ctx.ui.width - 2).map(part => `  ${part}`));
  const result = await gate([], {
    paths: ctx.paths, operationActions: [action], retention: { kind: "migration", reason: "app-rebuild" },
    auto: ctx.flags.auto, dryRun: ctx.flags.dryRun, verbose: ctx.flags.verbose, ui: ctx.ui, t: ctx.t,
    heading: ctx.t.recovery.heading, interactive: () => ctx.canPrompt, ...(ctx.canPrompt ? {} : { out: () => {} }),
    recoveryPresentation: { lines: presentation,
      failureMessage: (id: string, phase: RecoveryPhase, path: string | null, code: string) =>
        `${ctx.t.recovery.failure(id, phase, path, code)}\ntonedial doctor ${connectionScopeFlag(ctx.agent)} --json` },
    verify: () => {
      const state = inspectOperations(ctx.paths).journals.find(({ operationId }) => operationId === entry.operationId)?.state;
      if (state !== "quarantined") throw new ConfigError(ctx.t.recovery.sourceInvalid);
    },
  });
  const lines = [...result.lines];
  if (result.reason === "written") {
    lines.push(`  ${ctx.t.recovery.quarantineComplete(entry.operationId)}`);
  } else {
    lines.push(`  ${result.reason === "dry-run" ? ctx.t.wiring.dryRun : ctx.t.wiring.declined}`);
  }
  return {
    lines,
    json: {
      appRebuilt: false, applied: result.applied, reason: result.reason, operationId: result.operationId ?? null,
      root: ctx.paths.root, quarantinedOperation: entry.operationId, remainingInvalidOperations: [...remaining],
      next: result.applied && remaining.length > 0
        ? `tonedial doctor --fix --quarantine-operation ${remaining[0]} ${connectionScopeFlag(ctx.agent)}` : null,
      nativeAttention: false, activationVerified: false, diff: result.diff,
    },
    rebuiltConfig: null,
    proposedConfig: null,
    legacy: null,
    quarantineOnly: true,
  };
}

export async function runAppRebuild(ctx: Ctx): Promise<AppRebuildResult> {
  const t: Messages = ctx.t;
  const operations = inspectOperations(ctx.paths);
  const pending = operations.journals.filter(entry => entry.state === "pending");
  const invalid = operations.journals.filter(entry => entry.state === "invalid");
  let quarantined = invalid.find(entry => entry.operationId === ctx.flags.quarantineOperation) ?? null;
  if (ctx.flags.quarantineOperation && quarantined === null) throw new ConfigError(t.recovery.quarantineUnavailable(ctx.flags.quarantineOperation));
  if (invalid.length > 0 && quarantined === null && operations.lock.state === "none" && pending.length === 0 && invalid.length === 1 &&
      !ctx.flags.auto && ctx.canPrompt) {
    const candidate = invalid[0]!;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const notice = t.recovery.quarantineCandidate(candidate.operationId).split("\n").flatMap(line =>
        line === candidate.operationId ? [line] : wrap(line, ctx.ui.width - 2));
      process.stdout.write(`${notice.map(line => `  ${line}`).join("\n")}\n`);
      const question = wrap(t.recovery.quarantineQuestion, ctx.ui.width - 3).map(line => `  ${line}`).join("\n");
      const answer = (await input.question(`${question} `)).trim();
      if (answer === "") throw new ConfigError(t.recovery.cancelled);
      if (answer !== candidate.operationId) throw new ConfigError(t.recovery.operationMismatch);
      quarantined = candidate;
    } finally { input.close(); }
  }
  if (invalid.length > 0 && quarantined === null) {
    const candidate = invalid[0]!;
    const command = `tonedial doctor --fix --quarantine-operation ${candidate.operationId} ${connectionScopeFlag(ctx.agent)}`;
    throw new ConfigError(t.recovery.quarantineRequired(candidate.operationId, command));
  }
  if (quarantined !== null && (operations.lock.state !== "none" || pending.length > 0)) {
    throw new ConfigError(t.doctor.recoveryPending);
  }
  const scopeExplicit = ctx.scopeExplicit ?? (ctx.flags.global || ctx.flags.here === true || ctx.flags.project !== null);
  if (ctx.flags.auto && !ctx.flags.dryRun && !scopeExplicit) throw new ConfigError(t.errors.scopeRequired);
  if (ctx.flags.tools !== null) parseToolSelection(ctx.flags.tools, true, t);
  if (quarantined !== null && invalid.length > 1) {
    return quarantineOneOperation(ctx, quarantined, invalid.filter(entry => entry !== quarantined).map(entry => entry.operationId));
  }
  const blocked = operations.lock.state !== "none" || pending.length > 0;
  if (blocked && (operations.lock.state === "live" || operations.lock.state === "unknown" ||
    pending.some(entry => entry.journal === null) || (!ctx.flags.fromOperation && (ctx.flags.auto || !ctx.canPrompt)))) {
    throw new ConfigError(t.doctor.recoveryPending);
  }
  const configCapture = captureRawEntry(ctx.paths.config, t, { within: ctx.paths.root, maxBytes: CONFIG_MAX_BYTES });
  const selected = ctx.flags.fromOperation ? selectedJournal(ctx, ctx.flags.fromOperation) : null;
  let retirementId: string | null = null;
  if (blocked) {
    const owner = operations.lock.owner;
    if (operations.lock.state === "live" || operations.lock.state === "unknown" || pending.some(entry => entry.journal === null)) {
      throw new ConfigError(t.doctor.recoveryPending);
    }
    if (selected?.journal.state === "retired-for-app-rebuild" && pending.length === 0) {
      // The retirement owner validates this exact receipt, including interrupted owner release.
      retirementId = selected.journal.operationId;
    } else {
      if (owner?.kind !== "mutation" || operations.lock.state !== "dead" ||
          readJournal(ctx.paths, owner.operationId)?.state !== "pending" ||
          pending.some(entry => entry.operationId !== owner.operationId)) throw new ConfigError(t.doctor.recoveryPending);
      if (selected?.journal.operationId === owner.operationId) retirementId = owner.operationId;
      else if (!ctx.flags.auto && ctx.canPrompt) {
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const operation = t.recovery.resumeOperation(owner.operationId).split("\n").flatMap(line =>
            line === owner.operationId ? [line] : wrap(line, ctx.ui.width - 2));
          process.stdout.write(`${operation.map(line => `  ${line}`).join("\n")}\n`);
          const question = wrap(t.recovery.resumeQuestion, ctx.ui.width - 3).map(line => `  ${line}`).join("\n");
          const answer = (await input.question(`${question} `)).trim();
          if (answer === "") throw new ConfigError(t.recovery.cancelled);
          if (answer !== owner.operationId) throw new ConfigError(t.recovery.operationMismatch);
          retirementId = owner.operationId;
        } finally { input.close(); }
      } else throw new ConfigError(t.doctor.recoveryPending);
    }
  }
  const currentText = capturedText(configCapture);
  const current = currentText === null ? null : recoverSettings(currentText, t);
  const config = current === null ? requireConfigV2(defaultConfig(), t) : structuredClone(current.config);
  const library = inspectPresetLibrary(ctx.paths.presets, t);
  const checks: Change[] = [];
  const readCaptures = new Map<string, RawEntryCapture>();
  const addRead = (capture: RawEntryCapture | null) => {
    if (capture !== null && !readCaptures.has(capture.path)) {
      readCaptures.set(capture.path, capture);
      checks.push(rawReadCheck(capture, t));
    }
  };
  for (const entry of library.entries) for (const capture of entry.selectionReads) addRead(capture);
  for (const copy of [...library.recoveryCopies, ...library.cacheRecoveries]) {
    for (const capture of copy.source.selectionReads) addRead(capture);
    for (const capture of copy.existing?.selectionReads ?? []) addRead(capture);
  }
  if (selected !== null) addRead(selected.capture);
  const savedSource = selected === null ? null : snapshotSettings(ctx, selected.journal);
  if (ctx.flags.fromOperation && savedSource === null && !ctx.flags.fromPreset && !ctx.flags.restorePreset && current === null) throw new ConfigError(t.recovery.noSnapshot(ctx.flags.fromOperation));
  const kept = new Set<string>();
  if (current !== null) mergeSettings(config, current, kept);
  const beforeSnapshot = kept.size;
  if (savedSource !== null) mergeSettings(config, savedSource, kept);
  const legacy = current?.legacy ?? (kept.size > beforeSnapshot ? savedSource?.legacy : null) ?? null;
  const snapshotOwnershipLost = kept.size > beforeSnapshot && savedSource !== null &&
    Object.keys(savedSource.config.wiring.registrations).length > 0;

  const artifacts = contextArtifactTargets(ctx.paths, t, {
    retainLowercase: Object.keys(legacy?.wiring ?? {}).length > 0,
  });
  let artifactSource: SettingsRecovery | null = null;
  for (const target of artifacts) {
    if (target.capture === null) continue;
    const text = capturedText(target.capture);
    if (text === null) continue;
    const decoded = recoverLegacyTone(text, t);
    if (decoded !== null) { artifactSource = decoded; mergeSettings(config, decoded, kept); break; }
  }
  const damagedFields = current?.invalid.filter(field => !["wiring", "managedSeeds", "seedVersion"].includes(field)) ?? [];
  const missingAxes = AXIS_ORDER.filter(axis => !kept.has(`axes.${axis}`));
  const obsoleteFields = ["fixed_width", "guards"];
  const sourceNeeded = current === null || damagedFields.some(field => !obsoleteFields.includes(field)) || missingAxes.length > 0;
  let chosenPreset = ctx.flags.fromPreset ? resolvePreset(ctx.paths.presets, ctx.flags.fromPreset, t, library) : null;
  if (chosenPreset === null && ctx.flags.fromPreset) {
    const pendingCopy = library.recoveryCopies.find(copy => copy.preset.slug === ctx.flags.fromPreset);
    if (pendingCopy !== undefined) chosenPreset = { preset: pendingCopy.preset, source: "custom", path: pendingCopy.path,
      capture: null, selectionReads: pendingCopy.source.selectionReads };
  }
  if (ctx.flags.fromPreset && chosenPreset === null) throw new ConfigError(t.recovery.sourceInvalid);
  if (sourceNeeded && chosenPreset === null && (savedSource === null || missingAxes.length > 0)) {
    if (ctx.flags.auto || !ctx.canPrompt) throw new ConfigError(t.recovery.sourceRequired);
    chosenPreset = await choosePreset(ctx, library);
  }
  if (chosenPreset !== null) assertPresetSelection(chosenPreset, t);
  const defaulted = new Set(current?.defaulted ?? []);
  if (sourceNeeded) {
    if (chosenPreset !== null) {
      for (const capture of chosenPreset.selectionReads) addRead(capture);
      const axes = applyPreset(chosenPreset.preset);
      for (const axis of AXIS_ORDER) if (!kept.has(`axes.${axis}`)) { config.axes[axis] = axes[axis]; defaulted.add(`axes.${axis}`); }
      const settings = chosenPreset.preset.settings;
      if (settings !== undefined) {
        if (!kept.has("safeword")) config.safeword = settings.safeword;
        if (!kept.has("speech_level")) config.speech_level = settings.speech_level;
        if (!kept.has("address_frequency")) config.address_frequency = settings.address_frequency;
        for (const key of personaFields) if (!kept.has(`persona.${key}`)) config.persona[key] = settings.persona[key];
        const address = { self_ref: config.persona.address?.self_ref ?? null, user_ref: config.persona.address?.user_ref ?? null };
        for (const key of ["self_ref", "user_ref"] as const) {
          if (!kept.has(`persona.address.${key}`)) address[key] = settings.persona.address?.[key] ?? null;
        }
        config.persona.address = address.self_ref || address.user_ref ? address : null;
      }
      if (!kept.has("preset")) config.preset = chosenPreset.preset.slug;
      if (!kept.has("unsaved")) config.unsaved = settings === undefined ? false : !matchesPreset(config, chosenPreset.preset);
    }
    for (const field of scalarFields) if (!kept.has(field)) defaulted.add(field);
    for (const key of personaFields) if (!kept.has(`persona.${key}`)) defaulted.add(`persona.${key}`);
    for (const key of ["self_ref", "user_ref"]) if (!kept.has(`persona.address.${key}`)) defaulted.add(`persona.address.${key}`);
  }
  if (ctx.flags.lang !== null) {
    if (!isLanguage(ctx.flags.lang)) throw new ConfigError(t.errors.languageUnsupported(ctx.flags.lang, LANGUAGES));
    config.language = ctx.flags.lang;
  }
  await resolveActiveConflict(ctx, config, library);

  const roots = [ctx.agent.root, ctx.cwd, ...(ctx.env.HOME ? [ctx.env.HOME] : []),
    ...Object.values(config.wiring.registrations).map(registration => registration.destination)];
  if (stateOverlapsInstructions(ctx.paths, roots) || (!ctx.agent.live && exportAliasesState(ctx.paths, ctx.agent.root))) {
    throw new ConfigError(t.errors.stateInstructionOverlap(ctx.paths.root));
  }
  const seedsSelection = generatedSeedSelection(ctx.paths, config, ctx.flags.tools !== null && ctx.flags.tools !== "none", t);
  const seeds = planGeneratedSeedRebuild(ctx.paths, config.managedSeeds, seedsSelection, t);
  const generatedSeeds = seedFiles(ctx.paths, seedsSelection);
  const rewrittenGenerated = new Set(generatedSeeds.filter(seed => seeds.operationActions.some(({ action }) =>
    action.path === seed.path || (object(action.after)?.type === "directory" && seed.path.startsWith(`${action.path}${sep}`))
  )).map(seed => seed.path));
  checks.push(...seeds.checks);
  config.managedSeeds = seeds.records;
  config.seedVersion = SEED_VERSION;
  const artifact = compile(toCompileInput(config));
  let quarantinePlan: PlannedOperationAction | null = null;
  if (quarantined !== null) {
    quarantinePlan = planOperationQuarantine(ctx, quarantined);
  }
  const operationActions: PlannedOperationAction[] = [...(quarantinePlan ? [quarantinePlan] : []), ...seeds.operationActions];
  for (const target of artifacts) {
    const capture = target.capture ?? captureRawEntry(target.path, t, { within: ctx.paths.root, allowLink: true });
    const plan = planEntryRebuild(capture, artifact, t, { reason: "generated" });
    if (plan.changed) operationActions.push(plan.action);
    else addRead(capture);
  }
  const copies: string[] = [];
  for (const copy of library.recoveryCopies) {
    const capture = captureRawEntry(copy.path, t, { within: ctx.paths.root, maxBytes: PRESET_MAX_BYTES });
    if (capture.type !== "missing") throw new ConfigError(t.errors.staleTarget(copy.path));
    operationActions.push(planEntryRebuild(capture, copy.contents, t, { reason: "restore-preset" }).action);
    copies.push(copy.preset.slug);
  }
  const restoredPreset = restoreSelectedPreset(ctx, library, selected?.journal ?? null);
  if (restoredPreset !== null) operationActions.push(restoredPreset.action);
  // Keep the exact captured config preimage and apply the metadata record last.
  const configPlan = planEntryRebuild(configCapture, serializeConfig(config, t), t, { reason: "restore-config" });
  if (configPlan.changed) operationActions.push(configPlan.action);
  else addRead(configCapture);

  // The old journal changes during retirement, so its old witness belongs to that phase.
  if (selected?.journal.operationId === retirementId) {
    const at = checks.findIndex(check => check.path === selected.capture.path);
    if (at !== -1) checks.splice(at, 1);
  }
  const insideRoot = (path: string) => {
    const local = relative(ctx.paths.root, path);
    return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  };
  const retiredExternalActions = retirementId === null ? 0 :
    (readJournal(ctx.paths, retirementId)?.actions ?? []).filter(action => !insideRoot(action.path) || !insideRoot(action.realPath)).length;
  const nativeAttention = current?.metadataLost === true || artifactSource !== null && current === null ||
    Object.keys(legacy?.wiring ?? {}).length > 0 || snapshotOwnershipLost || retiredExternalActions > 0 ||
    Object.values(config.wiring.registrations).some(registration => registration.target !== "shell" &&
      registration.resourceIds.some(id => config.wiring.resources[id]?.kind === "hook" && config.wiring.resources[id]?.managed.version === 1));
  const source = current !== null ? "settings" : savedSource !== null ? "snapshot" : artifactSource !== null ? "artifact" : "preset";
  const missingFields = [...new Set([...defaulted, ...damagedFields].filter(field => !obsoleteFields.includes(field)))];
  const presentation = [
    ...(source === "settings" ? [] : [`  ${ctx.ui.dim(t.recovery.source[source])}`]),
    `  ${t.recovery.keptSettings}`,
    ...(damagedFields.includes("fixed_width") ? [`  ${t.recovery.obsoleteWidthDiscarded}`] : []),
    ...(damagedFields.includes("guards") ? [`  ${t.recovery.obsoleteGuardsDiscarded}`] : []),
    ...(missingFields.length ? [`  ${t.recovery.missing(missingFields)}`] : []),
    ...(copies.length ? [`  ${t.recovery.copies(copies)}`] : []),
    ...(nativeAttention ? [`  ${t.recovery.nativePending}`] : []),
    ...(quarantined ? [`  ${t.recovery.quarantine(quarantined.operationId)}`] : []),
    ...(retirementId ? [`  ${t.recovery.retire(retirementId)}`] : []),
  ].flatMap(line => wrap(line.trimStart(), ctx.ui.width - 2).map(part => `  ${part}`));
  const options = {
    paths: ctx.paths, operationActions, retention: { kind: "migration" as const, reason: "app-rebuild" as const },
    auto: ctx.flags.auto, dryRun: ctx.flags.dryRun, verbose: ctx.flags.verbose, ui: ctx.ui, t,
    heading: t.recovery.heading,
    interactive: () => ctx.canPrompt, ...(ctx.canPrompt ? {} : { out: () => {} }),
    recoveryPresentation: { lines: presentation,
      failureMessage: (id: string, phase: RecoveryPhase, path: string | null, code: string) =>
        `${t.recovery.failure(id, phase, path, code)}\ntonedial doctor ${connectionScopeFlag(ctx.agent)} --json` },
    verify: () => {
      let verificationPath = ctx.paths.config;
      const mismatch = () => new ConfigError(t.recovery.sourceInvalid, { cause: { code: "VERIFY_MISMATCH", path: verificationPath } });
      try {
        const repaired = parseConfig(capturedText(captureRawEntry(ctx.paths.config, t, { within: ctx.paths.root })) ?? "", t);
        if (!isConfigV2(repaired) || serializeConfig(repaired, t) !== serializeConfig(config, t)) throw mismatch();
        for (const seed of generatedSeeds) {
          verificationPath = seed.path;
          const now = captureRawEntry(seed.path, t, { within: ctx.paths.root });
          if (capturedText(now) !== seed.contents) throw mismatch();
        }
        for (const target of artifacts) {
          verificationPath = target.path;
          if (capturedText(captureRawEntry(target.path, t, { within: ctx.paths.root })) !== artifact) throw mismatch();
        }
        if (quarantined !== null) {
          verificationPath = quarantined.path;
          const entry = inspectOperations(ctx.paths).journals.find(({ operationId }) => operationId === quarantined.operationId);
          if (entry?.state !== "quarantined") throw mismatch();
        }
        verificationPath = ctx.paths.tone;
        if (capturedText(captureRawEntry(ctx.paths.tone, t, { within: ctx.paths.root })) !== artifact) throw mismatch();
        for (const entry of library.entries) {
          for (const before of entry.selectionReads) {
            // Rewritten generated entries were checked against their new bytes above.
            if (before.path === restoredPreset?.capture.path || rewrittenGenerated.has(before.path)) continue;
            verificationPath = before.path;
            const now = captureRawEntry(before.path, t, { within: ctx.paths.root, maxBytes: PRESET_MAX_BYTES });
            if (now.type !== before.type || now.identity !== before.identity || now.mode !== before.mode ||
                (now.bytes === null ? before.bytes !== null : before.bytes === null || !now.bytes.equals(before.bytes))) {
              throw mismatch();
            }
          }
        }
        for (const slug of [...copies, ...(restoredPreset ? [restoredPreset.slug] : [])]) {
          verificationPath = slug === restoredPreset?.slug ? restoredPreset.capture.path
            : library.recoveryCopies.find(copy => copy.preset.slug === slug)!.path;
          if (resolvePreset(ctx.paths.presets, slug, t) === null) throw mismatch();
        }
      } catch (cause) {
        if (cause instanceof ConfigError && (cause.cause as { code?: unknown } | undefined)?.code === "VERIFY_MISMATCH") throw cause;
        const code = cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        throw new ConfigError(t.recovery.sourceInvalid, { cause: { code, path: verificationPath, cause } });
      }
    },
  };
  let result;
  if (retirementId !== null && !ctx.flags.dryRun) {
    const preview = await gate(checks, { ...options, dryRun: true });
    if (!ctx.flags.auto) {
      process.stdout.write(`${(preview.reason === "nothing" ? [...preview.lines, ...presentation] : preview.lines).join("\n")}\n`);
      if (await confirm(`  ${t.wiring.applyQuestion(preview.diff.length)}`) === "no") {
        return { lines: [`  ${t.wiring.declined}`], json: { appRebuilt: false, applied: false, reason: "declined", diff: preview.diff }, rebuiltConfig: null, proposedConfig: config, legacy, quarantineOnly: false };
      }
    }
    const snapshots = [configCapture, ...seeds.reads, ...artifacts.flatMap(target => target.capture === null ? [] : [target.capture]),
      ...library.entries.flatMap(entry => entry.selectionReads), ...(restoredPreset ? [restoredPreset.capture] : [])];
    retireOperationForAppRebuild(ctx.paths, retirementId, {
      snapshots: snapshots.map(privateCapture),
      assertFresh: () => {
        for (const action of operationActions) action.assertFresh?.();
        for (const check of checks) assertFresh(check, t, ctx.paths);
        if (selected?.journal.operationId === retirementId) assertFresh(rawReadCheck(selected.capture, t), t, ctx.paths);
        if (selected?.journal.operationId === retirementId && JSON.stringify(readJournal(ctx.paths, retirementId)) !== JSON.stringify(selected.journal)) throw new ConfigError(t.doctor.recoveryPending);
      },
    });
    result = await gate(checks, { ...options, auto: true });
    if (!ctx.flags.auto) result.lines.length = 0;
  } else result = await gate(checks, options);
  const applied = result.applied || result.reason === "nothing";
  const lines = [...result.lines];
  if (retirementId !== null && result.reason === "nothing" && ctx.flags.auto) lines.push(...presentation);
  lines.push(`  ${applied ? result.reason === "nothing" ? t.recovery.unchanged : t.recovery.rebuilt : result.reason === "dry-run" ? t.wiring.dryRun : t.wiring.declined}`);
  return {
    lines, rebuiltConfig: applied ? config : null, proposedConfig: config, legacy, quarantineOnly: false,
    json: {
      appRebuilt: applied, applied: result.applied, reason: result.reason, operationId: result.operationId ?? null,
      root: ctx.paths.root, source, recovered: [...kept], defaulted: [...defaulted], invalid: damagedFields,
      seeded: seeds.labels, chars: [...artifact].length, riskAxes: riskyAxes(config.axes),
      recoveredPresets: copies, restoredPreset: restoredPreset?.slug ?? null, retiredOperation: retirementId,
      quarantinedOperation: quarantined?.operationId ?? null,
      retiredExternalActions,
      nativeAttention, activationVerified: false, diff: result.diff,
    },
    warnings: riskWarnings(config.axes, t),
  };
}
