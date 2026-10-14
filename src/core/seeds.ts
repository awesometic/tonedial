// Generated state-root files, provenance, layout inspection, and approved rebuild planning.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  canonicalDestination,
  LEGACY_CONTEXT_ARTIFACT_FILENAME,
  readerPath,
  stateOverlapsInstructions,
  type Paths,
} from "./paths.ts";
import { ConfigError, isConfigV2, type Config } from "./config.ts";
import { catalogue, type Messages } from "./i18n.ts";
import { inspectOperations, type OperationAction, type OperationsInspection } from "./operations.ts";
import { GUIDE_FORMAT_MARKER, GUIDE_FORMAT_VERSION, READER_PROTOCOL_VERSION, READER_SOURCE } from "./reader.ts";
import { captureRawEntry, caseRenameMatchesCurrent, isNoop, planChange, planEntryRebuild, planGeneratedFamilyRebuild, rawReadChange, restoredArtifactMatchesCurrent, validateRollbackJournal, type Change, type PlannedOperationAction, type RawEntryCapture } from "../wiring/apply.ts";
import { BUNDLED, builtinPresetDir, LEGACY_BUILTIN_SLUGS } from "./presets.ts";
import { SKILL_MD, SKILL_NAME, SKILL_TRAITS_MD } from "./skill.ts";

// Bump for changed generated content; freshness also checks each managed seed's bytes/provenance.
export const SEED_VERSION = 12;

/** The state-root operating boundaries. The compiler owns the current tone separately. */
export const GUIDE_MD = `${GUIDE_FORMAT_MARKER}
ToneDial changes manner only; it never expands task scope or permissions.
Use the ToneDial CLI for configuration changes.
AGENTS.md is the operating guide, TONE.md is the current compiled tone, and the ToneDial skill
explains explicit in-session tuning and reloads.
`;

export type Seed = { id: string; version: number; path: string; label: string; contents: string };

/** Native sources are opt-in; inspection may additionally include retained seed records. */
export type SeedSelection = { native: boolean; recorded?: readonly string[]; legacyCaches?: readonly string[] };

/** Existing generated runtime families are repaired without inferring any native connection. */
export function generatedSeedSelection(paths: Paths, config: Config | null, native: boolean, t: Messages = catalogue("en").cli): SeedSelection {
  const recorded = new Set(Object.keys(config?.managedSeeds ?? {}));
  const root = lstatSync(paths.root, { throwIfNoEntry: false });
  if (root !== undefined && (!root.isDirectory() || root.isSymbolicLink())) throw new ConfigError(t.errors.seedConflict(paths.root));
  const present = (path: string) => {
    const parents: string[] = [];
    for (let parent = dirname(path); parent !== paths.root; parent = dirname(parent)) {
      if (parent === dirname(parent)) throw new ConfigError(t.errors.seedConflict(path));
      parents.unshift(parent);
    }
    for (const parent of parents) {
      const entry = lstatSync(parent, { throwIfNoEntry: false });
      if (entry === undefined) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ConfigError(t.errors.seedConflict(parent));
    }
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  };
  if (root !== undefined && present(readerPath(paths.root))) recorded.add("reader");
  const skillPresent = root !== undefined && present(join(paths.skill, SKILL_NAME));
  if (skillPresent || recorded.has("skill/body") || recorded.has("skill/traits")) {
    recorded.add("skill/body");
    recorded.add("skill/traits");
  }
  const legacyCaches = LEGACY_BUILTIN_SLUGS.filter((slug) =>
    recorded.has(`legacy-preset/${slug}`) || (root !== undefined && present(join(paths.presets, `${slug}.json`))));
  return { native, recorded: [...recorded], legacyCaches };
}

/** Diagnostics inspect required and retained seeds; setup supplies its own explicit choice. */
export function recordedSeedSelection(config: Config, pairTargets: readonly string[]): SeedSelection {
  const native = isConfigV2(config) && Object.values(config.wiring.registrations).some(
    (registration) => pairTargets.includes(registration.target) && registration.context === "pair",
  );
  return { native, recorded: Object.keys(config.managedSeeds) };
}

export function seedFiles(paths: Paths, selection: SeedSelection): Seed[] {
  const guide: Seed = {
    id: "guide",
    version: GUIDE_FORMAT_VERSION,
    path: paths.agents,
    label: "AGENTS.md",
    contents: GUIDE_MD,
  };
  const reader: Seed = {
    id: "reader",
    version: READER_PROTOCOL_VERSION,
    path: readerPath(paths.root),
    label: "reader.mjs",
    contents: READER_SOURCE,
  };
  const native: Seed[] = [
    reader,
    { id: "skill/body", version: 12, path: join(paths.skill, SKILL_NAME, "SKILL.md"), label: `skill/${SKILL_NAME}/SKILL.md`, contents: SKILL_MD },
    {
      id: "skill/traits",
      version: 6,
      path: join(paths.skill, SKILL_NAME, "references", "traits.md"),
      label: `skill/${SKILL_NAME}/references/traits.md`,
      contents: SKILL_TRAITS_MD,
    },
  ];
  return [
    guide,
    ...native.filter((seed) => selection.native || selection.recorded?.includes(seed.id)),
    ...BUNDLED.map((preset) => ({
      id: `preset/${preset.slug}`,
      version: 1,
      path: join(builtinPresetDir(paths.presets), `${preset.slug}.json`),
      label: `presets/builtin/${preset.slug}.json`,
      contents: `${JSON.stringify(preset, null, 2)}\n`,
    })),
    ...BUNDLED.filter((preset) => LEGACY_BUILTIN_SLUGS.includes(preset.slug) &&
      (selection.legacyCaches?.includes(preset.slug) || selection.recorded?.includes(`legacy-preset/${preset.slug}`)))
      .map((preset) => ({ id: `legacy-preset/${preset.slug}`, version: 1,
        path: join(paths.presets, `${preset.slug}.json`), label: `presets/${preset.slug}.json`,
        contents: `${JSON.stringify(preset, null, 2)}\n` })),
  ];
}

/** Preserve actual case on a folding filesystem; two lexical entries need synchronized writes. */
export function contextArtifactTargets(paths: Paths, t: Messages, options: { retainLowercase?: boolean } = {}): { path: string; capture: RawEntryCapture | null }[] {
  const root = lstatSync(paths.root, { throwIfNoEntry: false });
  const lowerPath = join(paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME);
  if (root === undefined) return [{ path: paths.tone, capture: null }];
  if (!root.isDirectory() || root.isSymbolicLink()) throw new ConfigError(t.errors.staleTarget(paths.root));
  const names = readdirSync(paths.root);
  const upper = captureRawEntry(paths.tone, t, { within: paths.root, allowLink: true });
  const lower = captureRawEntry(lowerPath, t, { within: paths.root, allowLink: true });
  const alias = upper.identity !== null && upper.identity === lower.identity &&
    !(names.includes(basename(paths.tone)) && names.includes(LEGACY_CONTEXT_ARTIFACT_FILENAME));
  if (alias) {
    const name = names.find((entry) => entry.toLowerCase() === basename(paths.tone).toLowerCase());
    if (name === undefined || upper.type !== lower.type || upper.mode !== lower.mode || upper.linkTarget !== lower.linkTarget ||
        (upper.bytes !== null && (lower.bytes === null || !upper.bytes.equals(lower.bytes)))) {
      throw new ConfigError(t.errors.staleTarget(paths.tone));
    }
    const actual = name === LEGACY_CONTEXT_ARTIFACT_FILENAME ? lower : name === basename(paths.tone) ? upper :
      captureRawEntry(join(paths.root, name!), t, { within: paths.root, allowLink: true });
    return [{ path: actual.path, capture: actual }];
  }
  if (upper.type === "missing" && lower.type === "missing" && options.retainLowercase) {
    // A saved config or journal directory supplies a read-only case-folding witness. No
    // filesystem probe is created before approval; two real names are never collapsed.
    const sample = names.find(name => /[a-z]/i.test(name));
    if (sample !== undefined) {
      const variant = sample.replace(/[a-z]/i, letter => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
      if (!names.includes(variant)) {
        const original = lstatSync(join(paths.root, sample), { bigint: true, throwIfNoEntry: false });
        const folded = lstatSync(join(paths.root, variant), { bigint: true, throwIfNoEntry: false });
        if (original !== undefined && folded !== undefined && original.dev === folded.dev && original.ino === folded.ino &&
            !readdirSync(paths.root).includes(variant)) {
          return [{ path: lowerPath, capture: lower }];
        }
      }
    }
  }
  const compatibility = lower.type !== "missing" || options.retainLowercase === true;
  return [{ path: paths.tone, capture: upper }, ...(compatibility ? [{ path: lowerPath, capture: lower }] : [])];
}

/** The one closed generated inventory rebuild; user preset directories are never replaced. */
export function planGeneratedSeedRebuild(paths: Paths, records: Config["managedSeeds"], selection: SeedSelection, t: Messages): {
  operationActions: PlannedOperationAction[];
  checks: Change[];
  reads: RawEntryCapture[];
  records: Config["managedSeeds"];
  labels: string[];
} {
  const seeds = seedFiles(paths, selection);
  const nextRecords = { ...records };
  const operationActions: PlannedOperationAction[] = [];
  const checks: Change[] = [];
  const reads: RawEntryCapture[] = [];
  const labels: string[] = [];
  const handled = new Set<string>();
  for (const family of [builtinPresetDir(paths.presets), join(paths.skill, SKILL_NAME)]) {
    const children = seeds.filter((seed) => seed.path.startsWith(`${family}${sep}`));
    if (children.length === 0) continue;
    const capture = captureRawEntry(family, t, { within: paths.root, allowLink: true, allowDirectory: true });
    if (capture.type === "regular" || capture.type === "symlink") {
      const plan = planGeneratedFamilyRebuild(capture, children.map((seed) => ({ relativePath: relative(family, seed.path), contents: seed.contents })), t);
      operationActions.push(plan.action);
      reads.push(capture);
      for (const seed of children) { handled.add(seed.id); labels.push(seed.label); }
    }
  }
  for (const seed of seeds) {
    nextRecords[seed.id] = seedRecord(seed);
    if (handled.has(seed.id)) continue;
    const capture = captureRawEntry(seed.path, t, { within: paths.root, allowLink: true });
    reads.push(capture);
    const plan = planEntryRebuild(capture, seed.contents, t, { reason: "generated" });
    // Keep equal generated reads bound under the lock without replacing their entries.
    if (plan.changed) operationActions.push(plan.action);
    else checks.push(rawReadChange(capture, t));
    if (plan.changed || JSON.stringify(records[seed.id]) !== JSON.stringify(nextRecords[seed.id])) labels.push(seed.label);
  }
  return { operationActions, checks, reads, records: nextRecords, labels };
}

export type SeedState = "current" | "missing" | "stale" | "modified" | "foreign" | "unreadable";
export type SeedInspection = { seed: Seed; state: SeedState };

export type ContextLayoutKind = "fresh" | "current" | "legacy" | "conflict";

/** The finite causes consumed by command gates and diagnostics. */
export type ContextLayoutCause =
  | "none"
  | "repair"
  | "legacy"
  | "foreign"
  | "case-collision"
  | "overlap"
  | "operation"
  | "inspection";

/** A read-only snapshot of a known delivery destination from the existing wiring owner. */
export type ContextConsumerCheck = {
  id: string;
  legacy: boolean;
  /** A bounded removal plan verified existing v2 authority; selection still owns application. */
  removalVerified?: boolean;
  change: Change;
};

/** Bounded diagnostic data; parser messages and file contents never cross this boundary. */
export type ContextInspectionFailure = {
  path: string;
  reason: "unreadable" | "invalid-provider-json" | "invalid-legacy-region";
};

export type ContextLayoutOptions = {
  /** The already validated config, or null when the config entry is absent. */
  config: Config | null;
  /** The deterministic artifact candidate when the caller has already compiled it. */
  expectedArtifact?: string | null;
  /** Known instruction roots supplied by the path/command owner. */
  instructionRoots?: readonly string[];
  /** Known v2 destinations and their bounded, identity-only snapshots. */
  consumers?: readonly ContextConsumerCheck[];
  /** A partial known-consumer read is never evidence that no legacy delivery remains. */
  consumerInspectionFailed?: boolean;
  inspectionFailure?: ContextInspectionFailure | null;
  /** Reuse one existing operations inspection when the caller already has it. */
  operations?: OperationsInspection;
};

export type ContextLayoutInspection = {
  kind: ContextLayoutKind;
  cause: ContextLayoutCause;
  /** Evidence only; B leaves transition permission to the later C/D route. */
  checks: readonly Change[];
  legacyWitness: "not-applicable" | "present" | "absent" | "unresolved";
  legacyConsumers: readonly string[];
  inspectionFailure: ContextInspectionFailure | null;
  /** Native attention is reported separately and grants no authority over provider files. */
  nativeAttention?: { legacyConsumers: readonly string[]; inspectionFailure: ContextInspectionFailure | null };
  /** Eligibility is evidence, never approval or historical ownership. */
  migration: {
    route: "witnessed" | "adopt-lowercase" | "config-only" | null;
    reason: string | null;
  };
};

function identityRead(path: string, t: Messages, within?: string): Change | null {
  try {
    // Generated lexical links are rebuild inputs, never a reason to inspect their referents.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    return planChange(path, (before) => before, t, undefined, within);
  } catch {
    // Layout inspection is a gate input. A non-regular, redirected, or unreadable entry is
    // reported as a conflict rather than escaping the command's structured error boundary.
    return null;
  }
}

function exactSeedRecord(record: Config["managedSeeds"][string] | undefined, path: string): boolean {
  return record?.type === "file" && record.path === path;
}

function actionSnapshot(value: OperationAction["after"]): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Match the shared journal's checkpointed identity and bytes, never bytes alone. */
function actionMatchesCurrent(action: OperationAction, change: Change): boolean {
  const after = actionSnapshot(action.after);
  const snapshot = change.snapshot;
  if (after === null || snapshot.bytes === null || snapshot.symbolicLink) return false;
  if (after.exists !== true || after.symbolicLink !== false) return false;
  if (after.resolvedPath !== snapshot.resolvedPath || after.realPath !== snapshot.realPath ||
      after.pathIdentity !== snapshot.pathIdentity || after.targetIdentity !== snapshot.targetIdentity) {
    return false;
  }
  if (typeof after.bytes !== "string") return false;
  try {
    const bytes = Buffer.from(after.bytes, "base64");
    return bytes.toString("base64") === after.bytes && bytes.equals(snapshot.bytes);
  } catch {
    return false;
  }
}

function hasCompletedWitness(
  operations: OperationsInspection,
  path: string,
  change: Change,
): boolean {
  return operations.journals.some((entry) => {
    if (entry.state !== "complete" || entry.journal === null) return false;
    // Retained rollback checkpoints can still carry the original complete label. Only an
    // entirely checkpointed forward operation proves ownership of a generated artifact.
    if (entry.journal.completed.length !== entry.journal.actions.length) return false;
    try {
      validateRollbackJournal(entry.journal);
    } catch {
      return false;
    }
    return entry.journal.actions.some((action) =>
      (action.kind === "file" && action.path === path && actionMatchesCurrent(action, change)) ||
      (basename(path) !== LEGACY_CONTEXT_ARTIFACT_FILENAME && action.kind === "case-rename" && caseRenameMatchesCurrent(action, change)));
  });
}

type ContextEntries = {
  upper: boolean;
  lower: boolean;
  unexpectedCase: boolean;
  unreadable: boolean;
};

function contextEntries(upperPath: string, lowerPath: string): ContextEntries {
  // On a case-insensitive volume, lstat(upperPath) also observes an actual lower-case entry.
  // Keep the lexical spelling from the directory listing so that aliasing cannot turn legacy
  // bytes into an upper-case managed artifact. A mixed spelling is equally unowned evidence.
  if (dirname(upperPath) !== dirname(lowerPath)) {
    return { upper: false, lower: false, unexpectedCase: true, unreadable: false };
  }
  try {
    // `Paths.root` may be a stable configured symlink. `statSync` follows that alias, matching
    // the existing bounded path owner and avoiding a false unreadable result from lstat alone.
    const directory = statSync(dirname(upperPath), { throwIfNoEntry: false });
    if (directory === undefined) return { upper: false, lower: false, unexpectedCase: false, unreadable: false };
    if (!directory.isDirectory()) return { upper: false, lower: false, unexpectedCase: false, unreadable: true };
  } catch {
    return { upper: false, lower: false, unexpectedCase: false, unreadable: true };
  }
  try {
    const names = readdirSync(dirname(upperPath));
    const upperName = basename(upperPath);
    const lowerName = basename(lowerPath);
    const folded = lowerName.toLowerCase();
    const matching = names.filter((name) => name.toLowerCase() === folded);
    return {
      upper: names.includes(upperName),
      lower: names.includes(lowerName),
      unexpectedCase: matching.some((name) => name !== upperName && name !== lowerName),
      unreadable: false,
    };
  } catch {
    // An unreadable directory cannot safely be treated as a case alias or a missing entry.
    return { upper: false, lower: false, unexpectedCase: false, unreadable: true };
  }
}

function inspectionResult(
  kind: ContextLayoutKind,
  cause: ContextLayoutCause,
  checks: readonly Change[],
  legacyWitness: ContextLayoutInspection["legacyWitness"] = "not-applicable",
  legacyConsumers: readonly string[] = [],
): ContextLayoutInspection {
  return { kind, cause, checks, legacyWitness, legacyConsumers, inspectionFailure: null, migration: { route: null, reason: cause } };
}

/**
 * Inspect the paired state layout without writing it.
 *
 * This is deliberately the one layout decision point. It reads only the state pair, the known
 * legacy artifact, and destinations supplied by the existing wiring owner. Returned identity
 * changes are appended to the caller's normal gate so the same evidence is revalidated under
 * the operation lock before any mutation.
 */
export function inspectContextLayout(
  paths: Paths,
  configRead: Change,
  t: Messages,
  options: ContextLayoutOptions,
): ContextLayoutInspection {
  const consumers = [...(options.consumers ?? [])];
  const legacyConsumers = consumers.filter((consumer) => consumer.legacy).map((consumer) => consumer.id).sort();
  const checks: Change[] = [];
  if (!isNoop(configRead)) return inspectionResult("conflict", "inspection", checks, "unresolved", legacyConsumers);
  checks.push(configRead);
  if (configRead.snapshot.symbolicLink) {
    return inspectionResult("conflict", "foreign", checks, "unresolved", legacyConsumers);
  }

  if (options.instructionRoots !== undefined) {
    try {
      if (stateOverlapsInstructions(paths, options.instructionRoots)) {
        return inspectionResult("conflict", "overlap", checks, "unresolved", legacyConsumers);
      }
    } catch {
      return inspectionResult("conflict", "inspection", checks, "unresolved", legacyConsumers);
    }
  }

  let operations: OperationsInspection;
  try {
    operations = options.operations ?? inspectOperations(paths);
  } catch {
    return inspectionResult("conflict", "operation", checks, "unresolved", legacyConsumers);
  }

  const guide = identityRead(paths.agents, t, paths.root);
  const artifact = identityRead(paths.tone, t, paths.root);
  const legacyPath = join(paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME);
  const legacy = identityRead(legacyPath, t, paths.root);
  for (const read of [guide, artifact, legacy]) {
    if (read !== null) checks.push(read);
  }
  if (guide === null || artifact === null || legacy === null) {
    return inspectionResult("conflict", "foreign", checks, "unresolved", legacyConsumers);
  }
  const configPresent = configRead.before !== null;
  const expectedArtifact = options.expectedArtifact ?? null;
  const guideRecord = options.config?.managedSeeds.guide;
  const guideRecorded = exactSeedRecord(guideRecord, paths.agents);
  const guidePresent = guide.snapshot.exists;
  const guideForeign = guidePresent && (guide.snapshot.symbolicLink || !guideRecorded);
  const guideRepair = guideRecorded && (!guidePresent || guide.before === null ||
    digest(guide.before) !== guideRecord!.sha256 || guideRecord!.version !== GUIDE_FORMAT_VERSION ||
    guide.before !== GUIDE_MD);

  const entries = contextEntries(paths.tone, legacyPath);
  const artifactPresent = entries.upper;
  const legacyPresent = entries.lower;
  if (entries.unreadable) {
    return inspectionResult("conflict", "inspection", checks, "unresolved", legacyConsumers);
  }
  if (options.config !== null && isConfigV2(options.config) && guidePresent) {
    const actual = !entries.upper && entries.lower && artifact.snapshot.pathIdentity === legacy.snapshot.pathIdentity ? legacy : artifact;
    const supportedGuide = guide.before !== null && guide.before.split(/\r?\n/, 1)[0] === GUIDE_FORMAT_MARKER;
    const expectedCurrent = expectedArtifact === null || actual.before === expectedArtifact;
    const compatibleLower = !entries.lower || actual === legacy || legacy.before === actual.before;
    const operationBlocked = operations.lock.state !== "none" ||
      operations.journals.some((entry) => entry.state === "pending" || entry.state === "invalid");
    const repair = !supportedGuide || !actual.snapshot.exists || !expectedCurrent || !compatibleLower;
    const result = inspectionResult(supportedGuide ? "current" : "conflict", operationBlocked ? "operation" : repair ? "repair" : "none",
      checks, "not-applicable", legacyConsumers);
    result.migration.reason = repair ? "app-rebuild" : "not-needed";
    result.nativeAttention = { legacyConsumers, inspectionFailure: options.consumerInspectionFailed ? options.inspectionFailure ?? null : null };
    return result;
  }
  if (artifactPresent && legacyPresent) {
    return inspectionResult("conflict", "case-collision", checks, "unresolved", legacyConsumers);
  }
  if (entries.unexpectedCase) {
    return inspectionResult("conflict", "foreign", checks, "unresolved", legacyConsumers);
  }
  const artifactOwned = artifactPresent && !artifact.snapshot.symbolicLink &&
    hasCompletedWitness(operations, paths.tone, artifact);
  const artifactForeign = artifactPresent && (artifact.snapshot.symbolicLink || !artifactOwned);
  const artifactRepair = !artifactPresent
    ? guideRecorded
    : artifactOwned && expectedArtifact !== null && artifact.before !== expectedArtifact;

  let legacyWitness: ContextLayoutInspection["legacyWitness"] = "not-applicable";
  if (legacyPresent) {
    if (legacy.snapshot.symbolicLink || expectedArtifact === null || legacy.before !== expectedArtifact) {
      legacyWitness = "unresolved";
    } else {
      const witnessed = hasCompletedWitness(operations, legacyPath, legacy);
      // New adoption authority is for absent historical evidence. A stale or incomplete
      // recorded artifact action is unresolved evidence, never an absent journal.
      const recordedArtifact = operations.journals.some(({ state, journal }) => {
        if (journal === null || state === "retired-for-app-rebuild") return false;
        const related = journal.actions.filter((action) => action.path === legacyPath);
        if (related.length === 0) return false;
        if (state !== "rolled-back" || journal.completed.length !== 0) return true;
        try { validateRollbackJournal(journal); } catch { return true; }
        return related.some((action) => !restoredArtifactMatchesCurrent(action, legacy, t));
      });
      legacyWitness = witnessed ? "present" : recordedArtifact ? "unresolved" : "absent";
    }
  }

  let kind: ContextLayoutKind;
  let cause: ContextLayoutCause = "none";
  if (guideForeign || artifactForeign) {
    kind = "conflict";
    cause = "foreign";
  } else if (!configPresent && !guidePresent && !artifactPresent && !legacyPresent && legacyConsumers.length === 0) {
    kind = "fresh";
  } else if (options.config !== null && isConfigV2(options.config) && guideRecorded && !legacyPresent && legacyConsumers.length === 0) {
    kind = "current";
    if (guideRepair || artifactRepair) cause = "repair";
  } else {
    kind = "legacy";
    cause = "legacy";
  }

  // A pending/invalid journal or any lock entry blocks a mutation, but does not change the
  // underlying layout classification that diagnostics need to report.
  const operationBlocked = operations.lock.state !== "none" ||
    operations.journals.some((entry) => entry.state === "pending" || entry.state === "invalid");
  if (operationBlocked) cause = "operation";
  const result = inspectionResult(kind, cause, checks, legacyWitness, legacyConsumers);
  result.nativeAttention = { legacyConsumers, inspectionFailure: options.consumerInspectionFailed ? options.inspectionFailure ?? null : null };
  if (cause === "operation" || kind === "conflict") return result;
  if (kind === "fresh" || kind === "current") {
    result.migration.reason = kind === "current" ? "not-needed" : "fresh";
    return result;
  }
  const config = options.config;
  if (!configPresent || config === null) {
    result.migration.reason = "config-missing";
    return result;
  }
  if (!isConfigV2(config) && Object.keys(config.wiring).length > 0) {
    result.migration.reason = "opaque-wiring";
    return result;
  }
  if (consumers.some((consumer) => consumer.legacy && consumer.removalVerified !== true)) {
    result.migration.reason = "unverified-consumers";
    return result;
  }
  if (isConfigV2(config) && legacyWitness === "present") {
    result.migration = { route: "witnessed", reason: null };
    return result;
  }
  const selection = { native: false, recorded: Object.keys(config.managedSeeds) };
  const knownSeeds = seedFiles(paths, selection);
  const seeds = inspectSeeds(paths, config.managedSeeds, selection);
  if (Object.keys(config.managedSeeds).some((id) => !knownSeeds.some((seed) => seed.id === id)) ||
      seeds.some(({ state }) => state === "modified" || state === "foreign" || state === "unreadable")) {
    result.migration.reason = "seed-conflict";
    return result;
  }
  if (legacyPresent && legacyWitness === "absent") {
    result.migration = { route: "adopt-lowercase", reason: "approval-required" };
  } else if (!legacyPresent && !artifactPresent && !guidePresent) {
    const registeredContext = isConfigV2(config) && (
      Object.values(config.wiring.registrations).some((registration) => registration.context === "pair") ||
      Object.values(config.wiring.resources).some((resource) => resource.kind === "hook")
    );
    result.migration = legacyConsumers.length === 0 && !registeredContext
      ? { route: "config-only", reason: "approval-required" }
      : { route: null, reason: "retained-consumers" };
  } else {
    result.migration.reason = legacyWitness === "unresolved" ? "artifact-changed" : "unsupported-layout";
  }
  return result;
}

function digest(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Proposed provenance: persist this only in the same approved operation as the seed write. */
export function seedRecord(seed: Seed): Config["managedSeeds"][string] {
  return { path: seed.path, type: "file", version: seed.version, sha256: digest(seed.contents) };
}

/** Inspect known bundled paths only. A stored path never grants an arbitrary filesystem read. */
export function inspectSeeds(
  paths: Paths,
  records: Config["managedSeeds"],
  selection: SeedSelection,
): SeedInspection[] {
  return seedFiles(paths, selection).map((seed) => ({ seed, state: inspectSeed(seed, records[seed.id], paths.root) }));
}

/** Init and wire prepare the same seeds and provenance before entering the write gate. */
export function planSeedChanges(
  paths: Paths,
  records: Config["managedSeeds"],
  selection: SeedSelection,
  t: Messages,
): { changes: Change[]; records: Config["managedSeeds"]; labels: string[]; skillFiles: Record<string, string> } {
  const inspected = inspectSeeds(paths, records, selection);
  const conflict = inspected.find(({ state }) => state === "foreign" || state === "unreadable");
  if (conflict) throw new ConfigError(t.errors.seedConflict(conflict.seed.path));
  const selected = inspected.map(({ seed }) => ({ seed, change: planChange(seed.path, () => seed.contents, t, undefined, paths.root) }));
  for (const { seed, change } of selected) {
    const record = records[seed.id];
    // Bind provenance checks to the snapshot the gate will revalidate.
    if (change.snapshot.symbolicLink || (record && !exactSeedRecord(record, seed.path)) || (change.before !== null &&
        !exactSeedRecord(record, seed.path))) {
      throw new ConfigError(t.errors.seedConflict(seed.path));
    }
  }
  const nextRecords = { ...records };
  const skillFiles: Record<string, string> = {};
  for (const { seed } of inspected) {
    nextRecords[seed.id] = seedRecord(seed);
    if (seed.id.startsWith("skill/")) skillFiles[relative(join(paths.skill, SKILL_NAME), seed.path)] = seed.contents;
  }
  return {
    changes: selected.map(({ change }) => change),
    records: nextRecords,
    labels: inspected.filter(({ state }) => state !== "current").map(({ seed }) => seed.label),
    skillFiles,
  };
}

function inspectSeed(seed: Seed, record: Config["managedSeeds"][string] | undefined, root: string): SeedState {
  if (record && (record.path !== seed.path || record.type !== "file")) return "foreign";
  let fd: number | undefined;
  try {
    const parent = relative(canonicalDestination(root), canonicalDestination(dirname(seed.path)));
    if (isAbsolute(parent) || parent === ".." || parent.startsWith(`..${sep}`)) return "foreign";
    const entry = lstatSync(seed.path, { bigint: true, throwIfNoEntry: false });
    if (!entry) return "missing";
    if (!entry.isFile() || !record) return "foreign";
    // A FIFO substituted after lstat must not block before fstat can reject it.
    fd = openSync(seed.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    // Check the opened object before reading: a replacement link cannot supply seed bytes.
    if (!opened.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino) return "foreign";
    const actual = digest(readFileSync(fd));
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(seed.path, { bigint: true, throwIfNoEntry: false });
    if (!named?.isFile() || named.dev !== opened.dev || named.ino !== opened.ino
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || after.size !== opened.size) {
      return "unreadable";
    }
    if (actual !== record.sha256) return "modified";
    return record.version === seed.version && actual === digest(seed.contents) ? "current" : "stale";
  } catch {
    return "unreadable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
