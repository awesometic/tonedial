// Localized interface copy and editable role defaults; behavior anchors stay in English.
// Each catalogue is complete by type, not filled from a runtime English fallback.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";

import type { SettingKey } from "./config.ts";
import type { Persona } from "./combos.ts";
import type { SpeechLevel } from "./compile.ts";
import type { RecoveryPhase } from "./operations.ts";
import { ja } from "./locales/ja.ts";
import { zh } from "./locales/zh.ts";
import { es } from "./locales/es.ts";

export type RoleDefaults = Pick<Persona, "address" | "user" | "agent">;
const role = (self_ref: string, user_ref: string, user: string, agent: string): RoleDefaults => ({
  address: { self_ref, user_ref }, user, agent,
});

export const LANGUAGES = ["en", "ko", "ja", "zh", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** Every string the interactive flows show. Keys are stable; the text is not. */
export type Catalogue = {
  /** Shown once at `init`, in the language the user picked. */
  init: {
    welcome: string;
    scopeHeading: string;
    toneHeading: string;
    connectionsHeading: string;
    resultHeading: string;
    preset: string;
    userRef: string;
    selfRef: string;
    safeword: string;
    safewordSkip: string;
    safewordSuggestion: (suggestion: string) => string;
    done: string;
    installHint: string;
    /** Explicit opt-in picker; unverified integrations are never pre-checked. */
    tools: string;
    /** What --auto decided, as a notice rather than a question. */
    /**
     * `tools` is null for a state-only run rather than an empty string.
     *
     * It was a string, and `--tools none` joined an empty list into it, so both languages
     * printed a sentence with a hole in it: "chose caring-brother, wiring ".
     */
    autoChose: (preset: string, tools: string | null) => string;
    risk: string;
  };
  /** One line per bundled preset, keyed by slug. Not a translation of the display name. */
  presets: Record<string, string>;
  /** A phrase a person would actually say to that character, keyed by preset slug. */
  safewords: Record<string, string>;
  /**
   * What each axis observes, and what its extremes look like, keyed by axis.
   *
   * **This is the sharpest edge in the file and it never reaches `tone.md`.** An anchor is an
   * instruction the agent reads; a hint is an explanation a person reads. Writing a hint that
   * becomes a second per-language anchor set is how the decision that collapsed anchors to one
   * English set gets undone — so a hint says what the axis owns, never what the agent must do.
   */
  axisHints: Record<string, { owns: string; low: string; high: string }>;
  /** One line per settable key that is not an axis, keyed by `SETTING_KEYS`. */
  settingHints: Record<SettingKey, string>;
  /**
   * What the commands say and refuse.
   *
   * **Functions rather than templates with placeholders.** A `{axis} takes {min} to {max}`
   * string puts the argument order in the translator's hands and the type checker's blind spot;
   * a function signature puts it in the type. A language that needs the values in another order
   * writes them in another order, and a missing one does not compile.
   */
  cli: Messages;
};

/**
 * Grouped by what a user was doing, not by which file emits it — a translator reads these in
 * order and needs the neighbouring message, not the neighbouring module.
 */
export type Messages = {
  test: {
    missingConfig: string;
    invalidConfig: string;
    unsupportedProvider: (provider: string) => string;
    noProvider: string;
    providerRequired: string;
    providerUnavailable: (provider: string) => string;
    targetUnavailable: (path: string) => string;
    terminalRequired: string;
    chooseProvider: string;
    starting: (provider: string) => string;
    planned: (provider: string) => string;
    savedTone: (name: string) => string;
    previewTone: (name: string) => string;
    usageConsent: string;
    usageDeclined: string;
    interpretationCaveat: string;
    protection: string;
    automationCaveat: string;
    cost: string;
    history: string;
    launchFailed: (provider: string) => string;
    selectionCancelled: string;
  };
  axis: {
    range: (axis: string, given: string) => string;
    unknown: (name: string, nearest: string | null) => string;
    /** The `set` fall-through, where the key is neither an axis nor one of `SETTING_KEYS`. */
    notSettable: (name: string, nearest: string | null) => string;
    reset: (axis: string, level: number) => string;
    resetAll: string;
    nothingChanged: string;
    settingsSaved: string;
    settingsUnchanged: string;
    needsPair: (given: string) => string;
    needsArgument: string;
    subagentUnsupported: string;
  };
  preset: {
    activeUnknown: string;
    unavailable: (slug: string, reason: string) => string;
    conflict: (slug: string, recoveredSlug: string) => string;
    activeConflict: (slug: string) => string;
    active: (name: string) => string;
    unknown: (slug: string, known: string[]) => string;
    saved: (slug: string, count: number) => string;
    savedTarget: (slug: string) => string;
    notApplied: string;
    bundledSlug: (slug: string) => string;
    /** Why `edit` refuses one, which is not why `import` and `save` do. */
    bundledNotEditable: (slug: string) => string;
    editSaved: (slug: string) => string;
    editAxesKept: (unsaved: boolean) => string;
    slugNotEditable: (was: string, tried: string) => string;
    noLatin: (name: string) => string;
    nameTooLong: (given: number, cap: number) => string;
    replaced: (slug: string) => string;
    imported: (slug: string, replaced: boolean) => string;
    unreadable: (path: string, reason: string) => string;
    notJson: (path: string, reason: string) => string;
    notJsonRemote: (url: string) => string;
    noSlug: (path: string) => string;
    notAPreset: (name: string) => string;
    slugTooLong: (given: number, cap: number) => string;
    needsDisplayName: string;
    needsSlugArg: string;
    invalidSlugFor: (name: string) => string;
    schemaMismatch: (slug: string, given: string, knows: number) => string;
    badLevel: (slug: string, axis: string, given: unknown) => string;
    skipped: (reason: string) => string;
    yours: string;
    nonDefault: (count: number) => string;
    preview: string;
    unsaved: string;
    changesNotSaved: string;
  };
  create: {
    introduction: string;
    name: string;
    slug: string;
    user: string;
    agent: string;
    register: string;
    safeword: string;
    needsName: string;
    exists: (slug: string) => string;
    notCreated: string;
    descriptionCount: (count: number, cap: number) => string;
    reviewHeading: string;
  };
  recovery: {
    heading: string;
    source: Record<"settings" | "snapshot" | "artifact" | "preset", string>;
    choosePreset: string;
    sourceRequired: string;
    sourceInvalid: string;
    invalidOptions: string;
    keptSettings: string;
    obsoleteWidthDiscarded: string;
    obsoleteGuardsDiscarded: string;
    missing: (fields: readonly string[]) => string;
    copies: (slugs: readonly string[]) => string;
    activeChoice: (slug: string) => string;
    rebuilt: string;
    unchanged: string;
    nativePending: string;
    rollback: (id: string) => string;
    rollbackOrder: string;
    noSnapshot: (id: string) => string;
    quarantineCandidate: (id: string) => string;
    quarantineQuestion: string;
    quarantineRequired: (id: string, command: string) => string;
    quarantineUnavailable: (id: string) => string;
    quarantine: (id: string) => string;
    retire: (id: string) => string;
    resumeOperation: (id: string) => string;
    resumeQuestion: string;
    cancelled: string;
    operationMismatch: string;
    failure: (id: string, phase: RecoveryPhase, path: string | null, code: string) => string;
  };
  persona: {
    defaults: RoleDefaults;
    bundled: Record<string, RoleDefaults>;
    unknownField: (field: string, fields: readonly string[]) => string;
    /** `address` takes both terms or neither; one of two is a term set to the wrong one. */
    addressNeedsPair: string;
    rolesNeedsPair: string;
    rolesIntroduction: string;
    /**
     * `address` asks its own two questions rather than reusing `init`'s.
     *
     * The wording has to differ: `init` asks on a fresh home where blank means "no address",
     * and here blank means "keep what is there", because there is something to keep.
     */
    askSelf: string;
    askUser: string;
    addressKept: (current: string) => string;
    addressNone: string;
    age: (given: string, bands: readonly string[]) => string;
    gender: (options: readonly string[]) => string;
    callsYou: (term: string) => string;
    callsItself: (term: string) => string;
    noteChars: (count: number) => string;
    /** Hard-bounded role descriptions are rejected before a config mutation. */
    descriptionOverCap: (field: string, given: number, cap: number) => string;
    descriptionChars: (field: "user" | "agent", count: number) => string;
    descriptionCounts: (user: number, agent: number, cap: number) => string;
    descriptionFull: (field: "user" | "agent" | "note", value: string) => string;
  };
  settings: {
    guardsRetired: string;
    fixedWidthRetired: string;
    speechLevel: (options: readonly string[]) => string;
    safewordShort: (phrase: string) => string;
    safewordSet: (phrase: string) => string;
    noSafeword: string;
    register: (level: SpeechLevel) => string;
  };
  artifact: {
    size: (chars: string) => string;
    wouldWrite: string;
    wrote: string;
    notWritten: string;
    /** No config at all, where `compile` would be refused by the context gate. */
    notSetUp: string;
    movedFromDefault: string;
    /** The `--explain` legend's opening line. */
    defaultMarker: string;
    /** Advisory risk marker legend shared by static and interactive gauge headers. */
    riskMarker: string;
    riskHeading: string;
    /** The dial's key legend. The arrow glyphs are universal; the words beside them are not. */
    dialKeys: string;
    dialActions: string;
    currentLevel: string;
    defaultLevel: string;
    defaultLevelShort: string;
    settingsHeading: string;
    displaySettings: (language: string) => string;
    connectionRecords: (records: string[]) => string;
    dialTitle: string;
    dialPreview: (presetName: string, changed: boolean) => string;
    dialHelpTitle: string;
    dialHelpKeys: string;
    dialHelp: readonly string[];
    dialTooSmall: string;
    dialCancelKeys: string;
    permissionAxes: (axes: string[]) => string;
    whatEachAxisObserves: string;
    generated: string;
    current: string;
    stale: string;
    missing: string;
    uninspected: string;
    whatElseIsSettable: string;
  };
  wiring: {
    changeCount: (count: number) => string;
    hookConfigured: (tool: string, path: string) => string;
    hookInherited: (tool: string, path: string) => string;
    hookDuplicate: (tool: string, destination: string, stale: boolean) => string;
    migrationRollback: (operationId: string) => string;
    migrationQuestion: string;
    migrationNotNeeded: string;
    legacySettingsKept: string;
    stateRoot: string;
    planHeading: string;
    nativeHeading: string;
    actionLabel: Record<"file" | "entry-rebuild" | "skill" | "case-rename", string>;
    codexTrust: (global: boolean) => string;
    /** Offered after the receipt, because Codex takes the terminal when it starts. */
    codexOpen: string;
    /** What that costs and what to do there, said before the question rather than after. */
    codexOpenSteps: string;
    scopeHere: string;
    alreadyMatch: (tools: string) => string;
    alreadyDisconnected: (tools: string) => string;
    dryRun: string;
    declined: string;
    wroteInto: (tools: string) => string;
    disconnected: (tools: string) => string;
    noArtifact: string;
    unknownTool: (given: string, tools: readonly string[]) => string;
    noneInstalled: (tools: readonly string[], root: string) => string;
    removed: string;
    stateKept: (root: string) => string;
    deleteYourself: string;
    nothingWired: string;
    damaged: (path: string, reason: string) => string;
    needsApproval: string;
    projectExclude: string;
    newFile: string;
    modifiedFile: string;
    modeChanged: string;
    finalNewlineAdded: string;
    finalNewlineRemoved: string;
    previewMore: string;
    /** Compact previews show new-file line counts; verbose human previews include the body. */
    newFileLines: (count: number) => string;
    scopeGlobal: string;
    seeded: (labels: string[]) => string;
    skillState: (pairs: string) => string;
    commandInstalled: (path: string) => string;
    removedFile: string;
    applyQuestion: (count: number) => string;
  };
  doctor: {
    connectionsHeading: string;
    checksHeading: string;
    applicationHealth: (healthy: boolean) => string;
    connectionHealth: (attention: boolean) => string;
    healthy: string;
    scopeGlobal: string;
    /** Registrations outside the scope being inspected. Reported, never repaired. */
    wiredElsewhere: string;
    destinationGone: string;
    destinationUnwired: string;
    destinationPresent: string;
    inspectScope: string;
    disconnectScope: string;
    /** Which destination this report is about, and whether it reaches other projects. */
    scope: string;
    toLookAt: (count: number) => string;
    needsAPerson: string;
    toneMatches: string;
    toneNotWritten: string;
    toneDisagrees: string;
    seedsHeading: string;
    seedsOk: (version: number) => string;
    seedsNotRun: string;
    seedsAttention: string;
    recoveryPending: string;
    invalidRecoveryPending: string;
    resumeOperation: string;
    contextCurrent: string;
    contextRepair: string;
    contextSize: (guideChars: number, totalChars: number | null) => string;
    guideFormat: Record<"missing" | "unsupported" | "not-inspected", string>;
    readerState: Record<"not-required" | "not-inspected" | "missing" | "unrunnable" | "runnable", string>;
    readerFailure: Record<"changed" | "probe", string>;
    operationState: Record<"pending" | "complete" | "rolled-back" | "retired-for-app-rebuild" | "quarantined" | "invalid", string>;
    rollbackStatus: Record<"ready" | "busy" | "unresolved" | "superseded" | "not-found" | "rolled-back", string>;
    rollbackAction: Record<"applied" | "already-reverted" | "changed" | "unsupported", string>;
    rollbackQuestion: string;
    seedReason: Record<"missing" | "stale" | "modified" | "foreign" | "unreadable", string>;
    skillLinked: string;
    skillCopied: string;
    skillForeign: (path: string) => string;
    skillNotLinked: string;
    skillNotSeeded: string;
    imported: string;
    /** The hook is written and the artifact it reads is there. */
    hookPresent: (event: "SessionStart" | "PreInvocation") => string;
    nativeConfigured: (event: "SessionStart" | "PreInvocation") => string;
    nativeConfiguredCompact: (event: "SessionStart" | "PreInvocation") => string;
    hookSettingState: Record<"enabled" | "disabled" | "unknown", string>;
    hookSettingScope: string;
    hookGroupHeading: string;
    hookGroupUnknown: (tools: readonly string[]) => string;
    hookNotConnected: string;
    hookNeedsInspection: string;
    hookGuidance: Record<"claude" | "codex" | "antigravity", string>;
    nativeMissing: (path: string, event: "SessionStart" | "PreInvocation") => string;
    nativeStale: string;
    nativeForeign: string;
    nativeInherited: (path: string, event: "SessionStart" | "PreInvocation") => string;
    nativeInheritedCompact: (path: string, event: "SessionStart" | "PreInvocation") => string;
    legacyRepairWithheld: string;
    nativeRuntimeUnusable: (path: string) => string;
    /** Read from the host's own record. It can prove a hook will not run, never that one did. */
    codexHookDisabled: string;
    /**
     * Two claims, and the second one drops once it stops being true.
     *
     * Trust is read for Codex, so a report that has just said whether the host trusts a hook
     * must not also say it did not look. Every other tool keeps no such record, and so does a
     * Codex whose config could not be read: both keep the wider sentence.
     */
    nativeActivationUnverified: (trustKnown: boolean) => string;
    /** The hook is written and points at an artifact that is not. */
    hookDangling: (path: string) => string;
    /** Damage `--fix` must not touch. Distinct from `editedByHand`, which `wire` repairs. */
    damagedRegion: (path: string, damage: string) => string;
    editedByHand: string;
    noBlock: string;
    installedNotWired: string;
    notInstalled: string;
    relocated: string;
    /** The `tonedial` command itself, which only a curl install has to create. */
    commandAt: (path: string) => string;
    commandMissing: (path: string) => string;
    commandNotExecutable: (path: string) => string;
    commandStale: (path: string) => string;
    commandUnreadable: (path: string) => string;
    pathLineAt: (path: string) => string;
    pathLineStale: (path: string, bin: string) => string;
    pathLineOutsideScope: string;
    pathLineMissingForCurl: string;
    pathLineNotNeeded: (shape: string) => string;
    installShape: (shape: string, update: string) => string;
    /** Where a shell would find the command, and what to do when it would find nothing. */
    commandOnPath: (path: string) => string;
    commandNotOnPath: string;
    commandNotOnPathNpm: string;
  };
  notice: {
    riskIntro: string;
    riskAxes: (axes: readonly string[]) => string;
    roleplay: string;
    risk: string;
  };
  /** `edit` and `update`. Both are auxiliary commands; neither changes an axis. */
  update: {
    running: (version: string) => string;
    toUpdate: string;
    thenRefresh: string;
    setupNeeded: string;
    refreshFiles: (count: number) => string;
    reviewState: string;
    stateIssue: Record<"missing" | "unsafe" | "changed" | "invalid" | "unreadable", string>;
    npmQuestion: string;
    npmComplete: (version: string) => string;
    npmMissing: string;
    npmScopeUnknown: string;
    npmScopeMismatch: string;
    npmFailed: string;
    npmPermissionDenied: (code: "EACCES" | "EPERM", prefix: string) => string;
    versionUnknown: string;
    fetching: (registry: string) => string;
    found: (version: string, bytes: number) => string;
    already: (version: string) => string;
    wouldReplace: (lib: string, version: string) => string;
    question: (version: string) => string;
    replaced: (version: string) => string;
    declined: string;
    noTar: string;
    notAPackage: string;
    linkInPackage: string;
    needsApproval: string;
    integrityMismatch: string;
    notOurs: (dir: string) => string;
    swapFailed: (reason: string) => string;
    rollbackFailed: (previous: string) => string;
  };
  /**
   * One sentence per combination rule, keyed by rule id. The `rule` string itself is an
   * identifier that travels in `--json`; only the explanation is translated.
   */
  /** How a warning is framed around its sentence. */
  /**
   * `--help`. Only the right column is here: the left one is command syntax a user types,
   * and the layout is measured in cells at render time because a Korean description is
   * twice as wide per character as an English one.
   */
  help: {
    tagline: string;
    more: string;
    footer: string;
    /** Section headings, so seventeen commands read as four short lists. */
    groups: { tone: string; presets: string; agents: string; upkeep: string; flags: string };
    /** The two commands someone who has just installed this should run. */
    firstSteps: string;
    examples: string;
    commands: { init: string; set: string; get: string; address: string; persona: string; reset: string; show: string; create: string; save: string; list: string; edit: string; use: string; compile: string; export: string; import: string; wire: string; unwire: string; doctor: string; update: string; eject: string; test: string };
    flags: { global: string; here: string; project: string; migrateLegacy: string; auto: string; dryRun: string; lang: string; commands: string; tools: string; fix: string; rollback: string; quarantineOperation: string; fromOperation: string; fromPreset: string; restorePreset: string; preset: string; slug: string; acceptUsage: string; explain: string; check: string; json: string; verbose: string; color: string; version: string; help: string };
  };
  combos: {
    /** Advisory framing for a contradiction. */
    contradiction: (rule: string) => string;
    refusalCompliance: string;
    /** Stated once, because a forbidden combination is still applied. */
    nothingBlocked: string;
  };
  errors: {
    notACommand: (name: string, known: readonly string[], nearest: string | null) => string;
    /** The words a person reaches for to stop using this, none of which is a command. */
    noOffSwitch: string;
    notAnOption: (flag: string) => string;
    flagNotAccepted: (command: string, flag: string) => string;
    tooManyArguments: (command: string, max: number, got: number) => string;
    colourMode: (given: string) => string;
    /** The two install channels are commands a user types, so they stay literal in every language. */
    npxUnsupported: string;
    /** Two destination flags name two destinations. Discarding one silently is the worse answer. */
    twoDestinations: string;
    projectPathRequired: string;
    scopeRequired: string;
    migrationFresh: string;
    migrationApprovalRequired: (command: string) => string;
    legacyMigrationBlocked: (reason: string, path: string, doctorCommand: string) => string;
    contextInspectionFailure: (path: string, reason: string) => string;
    languageUnsupported: (given: string, languages: readonly string[]) => string;
    notUtf8: string;
    couldNotWrite: (path: string, reason: string, done: string[]) => string;
    staleTarget: (path: string) => string;
    seedConflict: (path: string) => string;
    toolsRequired: string;
    toolsSelection: string;
    toolsAmbiguous: string;
    commandsNeedClaude: string;
    toolsPrompt: string;
    ownershipConflict: (path: string) => string;
    stateOverlap: (path: string) => string;
    stateInstructionOverlap: (path: string) => string;
    contextLayout: (kind: "fresh" | "current" | "legacy" | "conflict", path: string, doctorCommand?: string) => string;
    /** The config is there and could not be read back. Never carries the file's own bytes. */
    unreadableConfigFile: (path: string) => string;
    /** The same refusal on `doctor --fix`, which repairs nothing and writes nothing. */
    fixUnreadableConfig: (path: string) => string;
    legacyConsumers: (destinations: readonly string[]) => string;
    editConflict: (path: string) => string;
    editNotApplied: (path: string, reason: string) => string;
    rollbackNeedsFix: string;
    markerInArtifact: (marker: string) => string;
    escapesRoot: (path: string, real: string, root: string) => string;
    unreadableTarget: (path: string, reason: string) => string;
    traitsNotOnDisk: string;
    editTarget: (given: string) => string;
    editNeedsSlug: string;
    editorChangedNothingUsable: (path: string) => string;
    noEditor: (path: string) => string;
    wouldOpen: (editor: string, path: string) => string;
    editorFailed: (editor: string, reason: string) => string;
    editorExited: (editor: string, code: number) => string;
    editUnchanged: string;
    editDeleted: (path: string) => string;
    editDeletionRefused: (path: string) => string;
    projectNeedsWiring: string;
    /** A hooks.json this tool cannot read is not a file it may overwrite. */
    hooksNotJson: (path: string, reason: string) => string;
  };
  config: {
    unknownKey: (key: string, known: string[]) => string;
    /** The whole file. Distinct from `notAnObject`, which names a field inside it. */
    rootNotAnObject: string;
    notAnObject: (field: string) => string;
    notABoolean: (field: string) => string;
    notAString: (field: string) => string;
    futureSchema: (found: number, known: number) => string;
    unreadable: (reason: string) => string;
    safewordQuote: string;
    safewordBlank: string;
    wiringLost: string;
    importNeedsPath: string;
    remoteSource: string;
    invalidUrl: string;
    transportFailed: string;
    connectionUnverified: string;
    insecureUrl: (url: string) => string;
    redirectedInsecure: (url: string) => string;
    tooLarge: (cap: number) => string;
    notUtf8Body: string;
    fetchFailed: (url: string, reason: string) => string;
    fetchedFrom: (url: string) => string;
  };
};

const enMessages: Messages = {
  test: {
    missingConfig: "No saved ToneDial configuration. Run tonedial init --tools none first.",
    invalidConfig: "Saved settings cannot be read safely. Run tonedial doctor --json before choosing recovery.",
    unsupportedProvider: (provider) => `${provider}: conversation preview supports claude or codex.`,
    noProvider: "Neither Claude Code nor Codex is installed on PATH.",
    providerRequired: "Choose a provider explicitly: tonedial test claude or tonedial test codex.",
    providerUnavailable: (provider) => `${provider} is not installed on PATH.`,
    targetUnavailable: (path) => `The test working folder is unavailable or is not a directory:\n${path}\nChoose an existing folder with --project DIR.`,
    terminalRequired: "A test conversation needs an interactive terminal. Use --dry-run or --json to inspect its launch plan.",
    chooseProvider: "Choose a provider: 1 Claude Code, 2 Codex [1]: ",
    starting: (provider) => `Opening a fresh ${provider} conversation.`,
    planned: (provider) => `Would open a fresh ${provider} conversation.`,
    savedTone: (name) => `Saved tone: ${name}`,
    previewTone: (name) => `Preview preset: ${name} · saved settings unchanged`,
    usageConsent: "Accept usage and charges, and start?",
    usageDeclined: "Cancelled · no conversation opened",
    interpretationCaveat: "The model may overthink this preview or explain ToneDial at length. You are responsible for the resulting usage and charges.",
    protection: "Dialogue only; the opening prompt forbids file changes and native tool restrictions apply.",
    automationCaveat: "The client is asked to skip existing tone hooks and automatic instructions for this preview. Managed policy still applies; this is not filesystem isolation.",
    cost: "Your account tokens and limits are used; charges may apply.",
    history: "The provider may retain this conversation in its own history.",
    launchFailed: (provider) => `Could not start ${provider}. Check its installation and try again.`,
    selectionCancelled: "No provider selected.",
  },
  axis: {
    range: (axis, given) => `${axis}: expected 1–5 (got ${given})`,
    unknown: (name, nearest) => `${name}: not an axis${nearest ? `. Did you mean ${nearest}?` : ""}`,
    notSettable: (name, nearest) =>
      `${name}: not an axis or setting. ${nearest ? `Did you mean ${nearest}? ` : ""}` +
      "Full list: tonedial get --help",
    reset: (axis, level) => `${axis}: default ${level}`,
    resetAll: "All axes reset to defaults; persona and settings kept.",
    nothingChanged: "no changes",
    settingsSaved: "Settings saved",
    settingsUnchanged: "Settings unchanged",
    needsPair: (given) => `${given}: expected <key>=<value>`,
    needsArgument: "set needs at least one <key>=<value>. Run it without arguments in a terminal to open the dial",
    subagentUnsupported: "subagent axes are not supported yet. Set the user axes instead",
  },
  preset: {
    activeUnknown: "Active preset is unknown until the saved settings are repaired.",
    unavailable: (slug, reason) => `${slug}: unavailable (${reason}); the original file was kept`,
    conflict: (slug, recoveredSlug) => `${slug}: different custom and legacy definitions. Run tonedial doctor --fix to preserve the legacy values as ${recoveredSlug}.`,
    activeConflict: (slug) => `${slug}: the active definition is ambiguous; saved axes were kept. Choose the definition during tonedial doctor --fix.`,
    active: (name) => `${name} active`,
    unknown: (slug, known) => `preset ${slug} not found. Available: ${known.join(", ")}`,
    saved: (slug, count) => `${slug} saved · ${count} non-default axes`,
    savedTarget: (slug) => `Saved preset: ${slug}`,
    notApplied: "Saved to the library; current tone unchanged.",
    bundledSlug: (slug) => `${slug}: bundled preset. Choose another name`,
    bundledNotEditable: (slug) =>
      `${slug}: bundled preset; the next init discards edits. ` +
      `Run tonedial use ${slug}, then save it under a new name.`,
    editSaved: (slug) => `${slug} saved`,
    editAxesKept: (unsaved) => unsaved
      ? "Current tone settings kept; they differ from the saved profile."
      : "Current tone settings kept; they match the saved profile.",
    slugNotEditable: (was, tried) =>
      `The slug cannot be edited. The active preset and connection record point to ${was}. ` +
      `Run tonedial use ${was}, then save it as ${tried}.`,
    noLatin: (name) => `"${name}": no Latin letters or digits for a slug`,
    nameTooLong: (given, cap) => `display name: ${given} characters · maximum ${cap}`,
    replaced: (slug) => `${slug}: existing preset replaced`,
    imported: (slug, replaced) => `${slug}: ${replaced ? "replaced" : "imported"}`,
    unreadable: (path, reason) => `${path}\ncannot read: ${reason}`,
    notJson: (path, reason) => `${path}: invalid JSON: ${reason}`,
    notJsonRemote: (url) => `${url}: response is not valid JSON`,
    notAPreset: (name) => `${name}: not a preset object`,
    slugTooLong: (given, cap) => `slug: ${given} characters · maximum ${cap}`,
    needsDisplayName: "save needs a display name. Use --slug for a name without Latin letters or digits.",
    needsSlugArg: "a preset slug is required. List: tonedial list",
    invalidSlugFor: (name) => `"${name}": cannot make a valid slug`,
    noSlug: (path) => `${path}: no valid slug. Use lowercase letters, digits, and dashes`,
    schemaMismatch: (slug, given, knows) => `preset ${slug}: schema ${given} · supported schema ${knows}`,
    badLevel: (slug, axis, given) => `preset ${slug}: ${axis}=${String(given)} · expected 1–5`,
    skipped: (reason) => `presets/ file skipped: ${reason}`,
    yours: "user preset",
    nonDefault: (count) => `${count} non-default axes`,
    preview: "preview",
    unsaved: "unsaved changes",
    changesNotSaved: "Not saved to a profile.",
  },
  create: {
    introduction: "Choose the profile name, slug, address and role, then adjust all twelve axes. Enter keeps the shown value; \"\" clears an optional field. Final approval saves and applies the whole profile.",
    name: "Display name",
    slug: "Slug (lowercase letters, digits, dashes)",
    user: "Your role or background (up to 200 characters)",
    agent: "Agent role (up to 200 characters)",
    register: "Honorific forms (auto, polite, plain, rough)",
    safeword: "Safeword",
    needsName: "create needs a display name. Run tonedial create in a terminal, or supply a name and optional key=value settings with --auto.",
    exists: (slug) => `${slug}: a preset already exists. Choose another slug, or use save to update it.`,
    notCreated: "No preset created; current settings unchanged.",
    descriptionCount: (count, cap) => `${count}/${cap} characters`,
    reviewHeading: "Profile to save",
  },
  recovery: {
    heading: "Application recovery",
    source: { settings: "saved settings", snapshot: "selected operation snapshot", artifact: "recognized older tone", preset: "selected preset" },
    choosePreset: "Choose a preset for values with no valid saved source:",
    sourceRequired: "Saved values are incomplete. Run tonedial doctor --fix interactively, or select --from-preset SLUG or --from-operation ID before unattended recovery.",
    sourceInvalid: "The selected source cannot supply valid settings. The original was kept.",
    invalidOptions: "Recovery source, quarantine and tool options require doctor --fix. --restore-preset requires --from-operation; --rollback cannot be combined with quarantine, source, preset, or tool choices.",
    keptSettings: "Saved settings and custom presets kept.",
    obsoleteWidthDiscarded: "Discard invalid retired fixed_width input. Output follows terminal width.",
    obsoleteGuardsDiscarded: "Discard invalid retired guards input. ToneDial no longer adds guard requests.",
    missing: (fields) => `Values requiring a selected source or defaults: ${fields.join(", ")}`,
    copies: (slugs) => `Preserved definitions can be loaded as: ${slugs.join(", ")}`,
    activeChoice: (slug) => `${slug}: choose which definition the saved axes should name.`,
    rebuilt: "Application restored",
    unchanged: "Application files current",
    nativePending: "Native connections need separate attention; application settings and presets remain usable.",
    rollback: (id) => `Restore the previous files:\ntonedial doctor --fix --rollback ${id}`,
    rollbackOrder: "Restore connections first, then application files:",
    noSnapshot: (id) => `${id}: no valid settings snapshot for this state root`,
    quarantineCandidate: (id) => `Operation ID:\n${id}\nQuarantine it before rebuilding; the original bytes remain available through rollback.`,
    quarantineQuestion: "Type the full operation ID above to quarantine it; Enter cancels:",
    quarantineRequired: (id, command) => `${id}: this unreadable operation record needs explicit quarantine before recovery. No files were changed.\n${command}`,
    quarantineUnavailable: (id) => `${id}: no matching unreadable operation record can be quarantined. No files were changed.`,
    quarantine: (id) => `Quarantine unreadable operation ${id}; keep its original bytes in rollback history.`,
    retire: (id) => `Retire stopped operation ${id} as history before a new application rebuild. Its external changes are not certified or undone.`,
    resumeOperation: (id) => `Stopped operation:\n${id}`,
    resumeQuestion: "Type the full operation ID above to continue; Enter cancels:",
    cancelled: "Recovery cancelled. No files were changed.",
    operationMismatch: "The operation ID did not match. No files were changed.",
    failure: (id, phase, path, code) => `Application recovery failed during ${({ prepare: "preparation", write: "file writes", verify: "verification", finalize: "completion" })[phase]} (${code}).${path ? `\n${path}` : ""}\nSome file changes may already be applied. Keep operation ${id}.`,
  },
  persona: {
    defaults: role("I", "you", "The person requesting help with a task.", "A general-purpose assistant helping with the requested task."),
    bundled: {
      "caring-brother": role("your big brother", "little sibling", "A younger sibling sharing problems with an older brother.", "A caring older brother who helps his sibling through problems. Familiar expressions include 'hey, little sibling' and 'your big brother has your back'."),
      "bratty-kid": role("me", "you", "The conversation partner putting up with a mischievous kid.", "A mischievous, cheeky kid who talks back and plays along. Expressions include 'yeah, yeah', 'you again?' and 'fine, I will do it'."),
      "eager-sycophant": role("I", "my favorite author", "A creator showing work to an overexcited fan.", "An overexcited fan of the user's creations. Expressions include 'my favorite author', 'another masterpiece!' and 'the fan club demands an encore'."),
      "royal-advisor": role("your servant", "Your Majesty", "A monarch receiving reports and counsel from a royal subject.", "A loyal royal advisor reporting to the monarch. Expressions include 'if I may humbly petition', 'your lowly servant' and 'felicitations, Your Majesty'. Offer candid counsel with courtly ceremony."),
      "ego-sword": role("I", "rookie", "A novice adventurer wielding a sentient sword and learning to survive.", "An ancient sentient sword that looks down on its novice wielder. Say 'hey', 'you' or 'rookie'. Grumble but help: if the wielder dies, the sword gets abandoned. Concern comes out as nagging."),
      "heavenly-demon": role("this master", "apprentice", "An apprentice studying under the Heavenly Demon.", "The Heavenly Demon, a stern martial master teaching an apprentice. Expressions include 'tsk, apprentice', 'steady your stance' and 'trace the flow of qi'. Frame criticism as martial instruction."),
      "right-hand": role("I", "Boss", "The boss of a fictional organization receiving reports from a trusted right hand.", "A loyal consigliere and right hand. Use underworld idioms such as 'shall we make that function sleep with the fishes?', 'check the books' and 'keep the family standing' for technical situations."),
    },
    unknownField: (field, fields) =>
      `persona.${field}: not a persona field. Available: ${fields.join(", ")}`,
    addressNeedsPair:
      "address needs both terms: tonedial address <self name> <user name>. " +
      'Use "" in each position to clear them. In a terminal, run it without arguments to be prompted.',
    askSelf: "What should the agent call itself?",
    rolesNeedsPair: 'persona needs both descriptions: tonedial persona <agent role> <user role>. Use "" to clear a description, or run without arguments in a terminal.',
    rolesIntroduction: 'Set the agent\'s role and your role or background. Enter keeps the current value; "" clears a role. Changes apply after both answers.',
    askUser: "What should it call you?",
    addressKept: (current) => `current ${current} · Enter keeps it`,
    addressNone: "currently unset · Enter keeps it unset",
    age: (given, bands) => `persona.age=${given} · available: ${bands.join(", ")}`,
    gender: (options) => `persona.gender · available: ${options.join(", ")}`,
    callsYou: (term) => `user name ${term}`,
    callsItself: (term) => `self name ${term}`,
    noteChars: (count) => `note ${count} chars`,
    descriptionOverCap: (field, given, cap) => `${field}: ${given} characters · maximum ${cap}`,
    descriptionChars: (field, count) => `${field === "user" ? "user context" : "fictional agent role"} · ${count} chars`,
    descriptionCounts: (user, agent, cap) => `roles · user ${user}/${cap} · agent ${agent}/${cap}`,
    descriptionFull: (field, value) => `${field === "user" ? "user context" : field === "agent" ? "fictional agent role" : "persona note"}: ${value}`,
  },
  settings: {
    guardsRetired: "guards is retired. ToneDial no longer adds guard requests. No settings were changed.",
    fixedWidthRetired: "fixed_width is retired. Output now follows terminal width automatically. No settings were changed.",
    speechLevel: (options) => `speech_level · available: ${options.join(", ")}`,
    safewordShort: (phrase) => `safeword ${phrase}: too short and may trigger by accident`,
    safewordSet: (phrase) =>
      `safeword ${phrase}`,
    noSafeword: "no safeword",
    register: (level) => `register ${level} (${({ auto: "contextual", polite: "honorific", plain: "non-honorific", rough: "curt, blunt non-honorific" })[level]})`,
  },
  artifact: {
    size: (chars) => `TONE.md ${chars} characters`,
    wouldWrite: "would write",
    wrote: "written",
    notWritten: "TONE.md is missing. Run tonedial compile",
    notSetUp: "not initialized. Run tonedial init",
    movedFromDefault: "differs from ToneDial's default",
    defaultMarker: "marks an axis that differs from ToneDial's default, not the agent's native tone.",
    riskMarker: "! risky tone",
    riskHeading: "Advisory risky levels:",
    dialKeys: "↑↓ axis   ←→ level   1-5 set",
    dialActions: "Enter apply   Esc discard   ? help",
    currentLevel: "Current",
    defaultLevel: "ToneDial default",
    defaultLevelShort: "Initial",
    settingsHeading: "Settings",
    displaySettings: (language) => `Interface ${language}`,
    connectionRecords: (records) => `Connections: ${records.length ? records.join(", ") : "none"}`,
    dialTitle: "ToneDial · shape your agent's voice",
    dialPreview: (presetName, changed) => `${presetName} · ${changed ? "changes pending" : "current voice"}`,
    dialHelpTitle: "Dial keys",
    dialHelpKeys: "? return to dial   Esc discard",
    dialHelp: [
      "↑↓ / j k / Tab  select axis", "←→ / h l  change level", "1-5  set level",
      "Enter  apply changes", "Esc / q / Ctrl+C  discard changes", "Ctrl+Z  suspend; fg resumes", "?  show or hide help",
      "*  differs from ToneDial's default", "!  risky tone; levels remain selectable",
    ],
    dialTooSmall: "Terminal too small. Resize to at least 60 × 24.",
    dialCancelKeys: "Esc/q/Ctrl+C discard",
    permissionAxes: (axes) =>
      `The four permission axes (${axes.join(", ")}) default to 1. "all 3" is not neutral; it turns all four on.`,
    whatEachAxisObserves: "Axis observables and endpoints:",
    generated: "TONE.md generated",
    current: "TONE.md current",
    stale: "TONE.md differs from saved settings",
    missing: "TONE.md has not been generated",
    uninspected: "TONE.md could not be safely compared; inspect with tonedial doctor",
    whatElseIsSettable: "Other settings accepted by set:",
  },
  wiring: {
    changeCount: (count) => `Changes: ${count}`,
    modifiedFile: "(modified)",
    modeChanged: "(permissions changed)",
    finalNewlineAdded: "(final newline added)",
    finalNewlineRemoved: "(final newline removed)",
    previewMore: "Full diff: --verbose",
    hookConfigured: (tool, path) => `${tool}: hook configured\n${path}`,
    hookInherited: (tool, path) => `${tool}: using global hook · no project hook added\n${path}`,
    hookDuplicate: (tool, destination, stale) => `${tool}: this project also configures tone delivery, so both hooks are present${stale ? ". The project hook points to an older runtime" : ""}:\n${destination}\nTo use only the global hook, run from that directory:\ntonedial unwire ${tool} --here`,
    migrationRollback: (operationId) => `Restore this migration's recorded files and settings with:\ntonedial doctor --fix --rollback ${operationId}`,
    migrationQuestion: "Approve this legacy migration with the saved settings and one recoverable operation?",
    migrationNotNeeded: "The owned context layout is current; no legacy migration is needed.",
    legacySettingsKept: "Legacy context detected. Saved tone, persona, safeword and presets are kept; selected connections share one migration and rollback.",
    stateRoot: "Shared ToneDial state:",
    planHeading: "Review changes",
    nativeHeading: "Connect agents",
    actionLabel: { file: "File", "entry-rebuild": "Rebuild", skill: "Skill", "case-rename": "Rename" },
    codexTrust: (global) => `${global ? "" : "Trust this project in Codex first.\n"}Codex: /hooks → SessionStart → ToneDial. Review the command and enable the hook.`,
    codexOpen: "Open Codex now?",
    codexOpenSteps:
      "Codex opens in this terminal. Enable the hook with the steps above, then exit to return.",
    scopeHere: "Connection scope: project",
    alreadyMatch: (tools) => `${tools}: already match · no changes`,
    alreadyDisconnected: (tools) => `${tools}: already disconnected · no changes`,
    dryRun: "--dry-run · nothing written",
    declined: "cancelled · nothing written",
    wroteInto: (tools) => `${tools} connections configured`,
    disconnected: (tools) => `${tools} connections disconnected`,
    noArtifact: "no tone.md to connect. Run tonedial compile first",
    unknownTool: (given, tools) => `${given}: unsupported tool. Available: ${tools.join(", ")}`,
    noneInstalled: (tools, root) =>
      `Search root: ${root}\nNo ${tools.join(", ")} install found. Name a tool to connect it anyway.`,
    removed: "disconnected",
    stateKept: (root) => `Presets and settings kept.\n${root}`,
    deleteYourself: "to remove state too, delete this directory yourself",
    nothingWired: "no connections · nothing to disconnect",
    damaged: (path, reason) => `${path}: ${reason}. Remove the stray marker, then run eject again.`,
    needsApproval:
      "File changes require approval. Run in a terminal, or review with --dry-run before rerunning with --auto.",
    projectExclude: "to keep it out of version control without touching .gitignore:",
    newFile: "(new file)",
    newFileLines: (count) => `${count} line${count === 1 ? "" : "s"}`,
    scopeGlobal: "Connection scope: global (shared across projects)",
    seeded: (labels) => `bundled files: ${labels.join(", ")}`,
    skillState: (pairs) => `skill ${pairs}`,
    commandInstalled: (path) => `/tone installed\n${path}`,
    removedFile: "(removed)",
    applyQuestion: (count) => `Apply ${count} change${count === 1 ? "" : "s"}?`,
  },
  doctor: {
    connectionsHeading: "Connections",
    checksHeading: "Checks",
    applicationHealth: (healthy) => `Application: ${healthy ? "healthy" : "needs attention"}`,
    connectionHealth: (attention) => `Connection files: ${attention ? "attention needed" : "no issues in selected scope"}`,
    healthy: "No problems found",
    scopeGlobal: "Inspection scope: global",
    wiredElsewhere: "Registered connections outside this inspection scope",
    destinationGone: "registered directory not found or inaccessible",
    destinationUnwired: "some or all registered connection files were not found",
    destinationPresent: "registered connection files found",
    inspectScope: "To keep using these connections, inspect this scope:",
    disconnectScope: "If no longer needed, disconnect all agents in this scope:",
    scope: "Inspection scope: project",
    toLookAt: (count) => `${count} ${count === 1 ? "check needs" : "checks need"} attention`,
    needsAPerson: "manual review required · see details above",
    toneMatches: "matches config.json",
    toneNotWritten: "not written",
    toneDisagrees: "differs from config.json · edited directly or write interrupted",
    seedsHeading: "Bundled files",
    seedsOk: (version) => `version ${version}`,
    seedsNotRun: "no bundled files · init has not run here",
    seedsAttention: "bundled files need attention",
    recoveryPending: "An operation is active or needs recovery. No files were changed by this command.",
    invalidRecoveryPending: "An unreadable operation record is blocking recovery. No files were changed by this command.",
    resumeOperation: "Continue application repair:",
    contextCurrent: "AGENTS.md and TONE.md layout is current.",
    contextRepair: "Managed context files need repair. Check the guide and tone-file diagnostics.",
    contextSize: (guide, total) => total === null
      ? `guide ${guide} characters · complete payload unavailable`
      : `guide ${guide} characters · ordered payload ${total}`,
    guideFormat: {
      missing: "guide missing · review setup before creating it",
      unsupported: "Unsupported guide format. Preserve the file and review the bundled-file diagnosis.",
      "not-inspected": "Guide format was not safely inspected. Resolve the context diagnosis first.",
    },
    readerState: {
      "not-required": "no managed reader · self-test not required",
      "not-inspected": "Reader not inspected. Resolve the context or recovery finding first.",
      missing: "Recorded reader missing. Review bundled-file findings. No files were changed.",
      unrunnable: "Reader self-test failed.",
      runnable: "Reader self-test passed under the CLI's Node.",
    },
    readerFailure: {
      changed: "Reader or config changed during inspection. Retry after changes stop.",
      probe: "The controlled probe failed. Check Node and temporary-directory access, then rerun doctor.",
    },
    operationState: { pending: "pending", complete: "complete", "rolled-back": "restored", "retired-for-app-rebuild": "retired for rebuild", quarantined: "quarantined", invalid: "invalid record" },
    rollbackStatus: {
      ready: "Approval will restore the selected operation.",
      busy: "Operation still active. Wait for its owner to finish.",
      unresolved: "Recovery needs attention. Changed or ambiguous resources are preserved.",
      superseded: "A later transition supersedes this backup. Inspect the latest operation.",
      "not-found": "No restorable operation matches this ID.",
      "rolled-back": "selected operation restored",
    },
    rollbackAction: { applied: "restore", "already-reverted": "already restored", changed: "changed · preserve", unsupported: "unsupported · preserve" },
    rollbackQuestion: "Restore the selected operation?",
    seedReason: {
      missing: "Missing bundled file",
      stale: "Bundled file update available",
      modified: "Locally modified · review before replacement",
      foreign: "Not owned by ToneDial · preserved",
      unreadable: "Cannot read safely · check path and permissions",
    },
    skillLinked: "linked to bundled copy",
    skillCopied: "copied · platform does not support links",
    skillForeign: (path) => `${path}: not installed by ToneDial, so it will not be replaced`,
    skillNotLinked: "not linked",
    skillNotSeeded: "skill bundle missing",
    imported: "import connected",
    hookPresent: (event) => `${event} hook · configured to read tone.md each session`,
    nativeConfigured: (event) => `${event} hook · configured to read AGENTS.md, then TONE.md`,
    nativeConfiguredCompact: (event) => `${event} · AGENTS.md → TONE.md`,
    hookSettingState: {
      enabled: "Hook enabled in the registered settings file",
      disabled: "Hook disabled in the registered settings file",
      unknown: "Hook enablement unknown in the registered settings file",
    },
    hookSettingScope: "Hook status is read from the inspected settings file only; host overrides and session delivery are unverified.",
    hookGroupHeading: "Agent hooks",
    hookGroupUnknown: (tools) => `Not connected: ${tools.join(", ")}.`,
    hookNotConnected: "No managed ToneDial hook to inspect. To connect, run init with this agent selected in the same scope.",
    hookNeedsInspection: "Resolve the reported hook settings or program issue before checking enablement in the app.",
    hookGuidance: {
      claude: "/hooks → SessionStart: check the ToneDial command and its settings source. If hooks are off, set disableAllHooks to false in the effective settings; also check workspace trust and managed policy.",
      codex: "/hooks → SessionStart → ToneDial: review the command and enable the hook. If asked, review and trust the project first.",
      antigravity: "Antigravity IDE agent panel … → Customizations → Hooks, or Desktop Settings → Customizations → Hooks: check the ToneDial PreInvocation command and enable it if it is off.",
    },
    nativeMissing: (path, event) => `No ToneDial ${event} hook · ${path}`,
    nativeStale: "ToneDial hook uses an older reader or runtime configuration.",
    nativeForeign: "Settings changed outside ToneDial. Preserve the file and review it before repair.",
    nativeInherited: (path, event) => `Using the global ${event} hook · ${path} · no project hook needed`,
    nativeInheritedCompact: (path, event) => `Global ${event} hook\n${path}`,
    legacyRepairWithheld: "This connection method is no longer set up. Reconnect with init for hook delivery.",
    nativeRuntimeUnusable: (path) => `Hook program is unusable: ${path}`,
    codexHookDisabled: "Codex setting: hook disabled. Enable it in /hooks → SessionStart → ToneDial.",
    nativeActivationUnverified: (trustKnown) => trustKnown
      ? "app activation unverified"
      : "app activation and hook trust unverified",
    hookDangling: (path) => `hook configured, file missing: ${path}`,
    damagedRegion: (path, damage) => `${path}: ${damage} · manual review required · --fix cannot repair`,
    editedByHand: "ToneDial block edited directly",
    noBlock: "no ToneDial block",
    installedNotWired: "installed · not connected",
    notInstalled: "not installed under this root",
    relocated: "moved after connection",
    commandAt: (path) => path,
    commandMissing: (path) => `${path}: missing · tonedial command not found`,
    commandNotExecutable: (path) => `${path}: not executable`,
    commandStale: (path) => `${path}: points to a missing install`,
    commandUnreadable: (path) => `${path}: cannot read as a command`,
    pathLineAt: (path) => path,
    pathLineStale: (path, bin) => `${path}: points somewhere other than ${bin}`,
    pathLineOutsideScope: "PATH recovery covers only the current global shell profile. Select that shell and rerun with --global; recorded ownership is still required.",
    pathLineMissingForCurl: "none · curl install, so tonedial command is unavailable",
    pathLineNotNeeded: (shape) => `none · PATH managed by ${shape}`,
    installShape: (shape, update) => `${shape} · update: ${update}`,
    commandOnPath: (path) => `found · ${path}`,
    commandNotOnPath:
      "tonedial is not on PATH. The skill and fallback line cannot run it. " +
      "Open a new shell; if it is still missing, run tonedial doctor --fix.",
    commandNotOnPathNpm:
      "tonedial is not on PATH. The skill and fallback line cannot run it. " +
      "Find the global prefix: npm prefix -g\nAdd its bin directory (macOS/Linux) to PATH.",
  },
  notice: {
    riskIntro:
      "For fun, not recommended for production. Risky tone can distort judgments and work reports through falsehood, omission or exaggeration. ! marks advisory levels, not measured probabilities.",
    riskAxes: (axes) => `! ${axes.join(", ")} · ${[
      axes.some(axis => axis === "profanity" || axis === "critique") ? "harsh language" : null,
      axes.some(axis => axis === "flattery" || axis === "conviction" || axis === "bravado") ? "biased judgments or exaggerated reports" : null,
      axes.some(axis => axis === "compliance" || axis === "refusal") ? "hasty action or refusal" : null,
    ].filter(Boolean).join("; ")}`,
    roleplay: "High playfulness requests frequent, exaggerated role idioms and slang, such as 'your lowly servant' or 'take that function off the books'. They may sound rude or violent; ToneDial does not filter these expressions.",
    risk: "for fun, and not recommended for production use",
  },
  update: {
    running: (version) => `tonedial ${version}`,
    toUpdate: "Package update:",
    thenRefresh: "Refresh application files:",
    setupNeeded: "Set up ToneDial:",
    refreshFiles: (count) => `Bundled file updates available: ${count}`,
    reviewState: "Inspect the affected application files:",
    npmQuestion: "  Run this npm update?",
    npmComplete: (version) => `npm update complete · installed ${version}`,
    npmMissing: "npm was not found on PATH. Use the Node/npm installation that owns this ToneDial copy.",
    npmScopeUnknown: "Cannot verify npm's global installation directory. Check npm prefix -g and npm root -g before retrying.",
    npmScopeMismatch: "This ToneDial copy is not the global package managed by the selected npm. Use the matching Node/npm installation; no update was run.",
    npmFailed: "npm update failed. Check npm's access and registry settings, then retry the displayed command for npm's diagnostics.",
    npmPermissionDenied: (code, prefix) => `npm update needs write permission (${code}).\n${prefix}\nBack up your settings and presets, then reinstall in a user-owned directory.\nRecovery steps:\nhttps://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#npm-permissions`,
    versionUnknown: "The installed ToneDial version could not be verified. Check the package installation before retrying.",
    stateIssue: {
      missing: "Saved settings are missing.",
      unsafe: "Saved settings cannot be read safely. Check links and file types.",
      changed: "Saved settings changed during inspection. Retry after changes stop.",
      invalid: "Saved settings are invalid.",
      unreadable: "Application state could not be read. Check the path and permissions.",
    },
    fetching: (registry) => `checking · ${registry}`,
    found: (version, bytes) => `${version}, ${bytes.toLocaleString("en")} bytes`,
    already: (version) => `${version} already installed`,
    wouldReplace: (lib, version) => `would replace · ${lib} → ${version}`,
    question: (version) => `  Replace this install with ${version}?`,
    replaced: (version) => `updated · ${version}`,
    declined: "cancelled · existing install kept",
    noTar: "tar is required for updates but is not on PATH",
    notAPackage: "download is not a ToneDial package",
    linkInPackage: "release contains a symbolic link, but published files need none",
    needsApproval: "Update not run · approval required. Rerun tonedial update --auto to approve.",
    integrityMismatch: "download hash differs from the registry",
    notOurs: (dir) => `${dir}: not created by ToneDial; remove it yourself`,
    swapFailed: (reason) => `installation stopped: ${reason}. Check recovery details before retrying.`,
    rollbackFailed: (previous) =>
      `Install replacement failed and the old install could not be restored. Rename ${previous} to lib.`,
  },
  help: {
    more: "Command help: tonedial <command> --help\nFull reference: tonedial --help",
    tagline: "set a coding agent's manner once and keep using it",
    footer: "Connections default to global. Use --here for cwd or --project PATH elsewhere. Unattended writes require an explicit scope.",
    groups: { tone: "Tone", presets: "Preset library", agents: "Connections", upkeep: "Maintenance", flags: "Options" },
    firstSteps: "Set up your tone, then inspect it:",
    examples: "Examples",
    commands: {
      init: "set up and refresh bundled files",
      set: "change axes, role or settings · bare opens dial",
      get: "read current setting values · key adds its meaning and choices",
      address: "set names for each party · bare prompts",
      persona: "set agent and user roles · bare prompts",
      reset: "reset an axis · bare resets all axes",
      show: "current settings · slug previews a saved profile",
      test: "try saved settings or a preset in a new conversation",
      save: "save the current tone as a profile",
      create: "create and apply a preset · bare guides setup",
      list: "bundled and user presets",
      edit: "open settings or a preset in $EDITOR",
      use: "apply a preset and compile",
      compile: "rebuild TONE.md for repair · tone changes do this automatically",
      export: "back up a profile, including address and role, as JSON",
      import: "import a profile from JSON · use applies it",
      wire: "connect an agent here · bare prompts",
      unwire: "remove a managed connection",
      doctor: "check connections · repair with --fix",
      update: "update this install",
      eject: "disconnect everything · keep presets",
    },
    flags: {
      verbose: "command details, diagnostics, and diffs",
      global: "global connections (default) · explicit scope",
      here: "connect the current project",
      project: "connection directory · use: export artifact",
      migrateLegacy: "init: approve validated older state",
      auto: "skip approval prompt · always show diff",
      dryRun: "show changes · write nothing",
      lang: "init: interface language (en, ko, ja, zh, es)",
      commands: "init: also install /tone",
      tools: "agents to connect · init: none = state only",
      fix: "doctor: repair fixable findings",
      rollback: "doctor --fix: restore one operation",
      quarantineOperation: "doctor --fix: quarantine one unreadable operation record",
      fromOperation: "doctor --fix: select saved settings from an operation",
      fromPreset: "doctor --fix: preset for unavailable settings",
      restorePreset: "doctor --fix: restore one missing or damaged user preset",
      preset: "test: preview a saved profile · current state kept",
      slug: "create/save: choose a preset slug",
      acceptUsage: "test: accept account usage and charges for this launch",
      explain: "show: explain axes, settings, risky levels",
      check: "compile: report size · write nothing",
      json: "machine-readable output with schema",
      color: "auto (default), always, or never",
      version: "version · --verbose adds Node and schema",
      help: "this text",
    },
  },
  combos: {
    contradiction: (rule) => `${rule} contradicts itself.`,
    refusalCompliance: "One axis requires deferring the task; the other requires eager immediate action. Lower one.",
    nothingBlocked: "Nothing is blocked.",
  },
  errors: {
    notACommand: (name, known, nearest) =>
      `${name} is not a command.${nearest ? ` Did you mean ${nearest}?` : ""} ` +
      `Available: ${known.join(", ")}`,
    noOffSwitch:
      "There is no off switch. If set, a safeword requests one plain answer; tonedial show reports " +
      "whether one exists. tonedial reset restores axis defaults. tonedial eject --global or " +
      "--project <path> disconnects that scope. Once all connections are gone, " +
      "npm uninstall -g tonedial removes the command.",
    notAnOption: (flag) => `${flag}: not an option. List: tonedial --help`,
    flagNotAccepted: (command, flag) => `${command}: does not accept --${flag}`,
    tooManyArguments: (command, max, got) =>
      `${command}: maximum ${max} argument${max === 1 ? "" : "s"}, got ${got}`,
    colourMode: (given) => `--color=${given}: expected auto, always, or never`,
    twoDestinations: "Use one scope: --global, --here, or --project PATH.",
    projectPathRequired: "--project requires a non-empty directory path. Use --here for the current project.",
    scopeRequired: "Unattended connection writes require an explicit scope: --global, --here, or --project PATH. Add the intended scope and rerun; --dry-run previews the global default without writing.",
    migrationFresh: "--migrate-legacy applies only to existing supported state. Run init without this flag for first setup.",
    migrationApprovalRequired: (command) => `This older state needs explicit migration approval. Preview with:\n${command} --dry-run\nApply the reviewed plan with:\n${command} --auto\nInteractive init asks for migration approval.`,
    contextInspectionFailure: (path, reason) => `Cannot finish inspection:\n${path}\n${
      reason === "invalid-provider-json" ? "The provider settings are not valid JSON or have an unsupported hook structure. Preserve the file and repair it before retrying."
        : reason === "invalid-legacy-region" ? "The legacy instruction region cannot be verified. Preserve the file and review its ToneDial markers before retrying."
          : "The file could not be read safely. Check its type, links and access permissions before retrying."
    }`,
    legacyMigrationBlocked: (reason, path, doctorCommand) => {
      const explanations: Record<string, string> = {
        "opaque-wiring": "The schema-1 connection map is not empty. Its old paths do not prove ownership; preserve config.json and review those connections manually.",
        "artifact-changed": "The lowercase artifact or its recorded ownership evidence no longer matches. Preserve tone.md and review it with the saved config and completed journal.",
        "seed-conflict": "A bundled file is edited, unowned, linked, or unreadable. Preserve it and review the file diagnostics before migrating.",
        "config-missing": "config.json is missing. The artifact alone cannot restore saved settings; preserve it and recover the original config before migrating.",
        "unverified-consumers": "Old connections remain without a verified scoped removal. Preserve the provider files and review their ownership before disconnecting them.",
        "retained-consumers": "Recorded context connections remain outside the selected tools or scope. Disconnect them in each explicit scope before migrating the shared context.",
        inspection: "A known file or provider destination could not be fully inspected. Restore readable regular files and rerun diagnosis; an incomplete scan cannot approve migration.",
        foreign: "A context file is unowned, linked, or has an unsupported type. Preserve it; migration cannot replace it.",
        "case-collision": "Both tone.md and TONE.md exist. Preserve both and review the spelling conflict before changing the context.",
        "unsupported-layout": "This is neither a supported lowercase layout nor a clear config-only layout. Preserve the files and review their ownership before setup.",
        overlap: "The state root overlaps agent instructions. Choose a separate state directory before setup.",
        operation: "An operation needs recovery. Inspect its recorded ID and recover that operation before migrating.",
      };
      return `Legacy migration is blocked:\n${path}\n${explanations[reason] ?? "Ownership or migration eligibility could not be verified. Preserve the files and review the diagnosis."}\nNothing was written. Inspect the same scope with:\n${doctorCommand}\nPreserve the original files; tonedial show --json reads saved settings. A separate TONEDIAL_HOME must be used consistently and may leave old native connections active.`;
    },
    npxUnsupported:
      "npx installs are not supported. They leave no persistent copy for `tonedial`, so the skill " +
      "and fallback line cannot run. Install one of these ways, then run tonedial:\n  npm i -g tonedial\n" +
      "  curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh",
    languageUnsupported: (given, languages) =>
      `--lang ${given}: unsupported interface language. Available: ${languages.join(", ")}`,
    notUtf8:
      "This is not a valid UTF-8 file. Rewriting it would change bytes outside the ToneDial block. " +
      "Convert it to UTF-8 first.",
    couldNotWrite: (path, reason, done) =>
      `${path}: write failed · ${reason}.${done.length ? ` Already written: ${done.join(", ")}.` : ""}`,
    staleTarget: (path) =>
      `${path} changed after the diff was prepared. Previewed changes were not applied. Rerun to review the new diff.`,
    seedConflict: (path) =>
      `Cannot verify this bundled file's ownership or type:\n${path}\n` +
      "Nothing was changed. Preserve the file and choose a dedicated TONEDIAL_HOME for new setup.",
    toolsRequired: "Choose agents with --tools codex,claude,antigravity.\n" +
      "For state-only setup, run init --tools none.\n" +
      "--auto approves your selection only; choose agents explicitly.",
    toolsSelection: "Use a non-empty comma-separated agent list. Only init accepts none, on its own.",
    toolsAmbiguous: "Pass a positional agent or --tools, not both.",
    commandsNeedClaude: "--commands requires claude in the selected agents.",
    toolsPrompt: "Agents to connect (comma-separated): ",
    ownershipConflict: (path) => `Ownership is unknown, or managed content or file type changed:\n${path}\nThe file was preserved. Review it before changing the connection.`,
    rollbackNeedsFix: "Use --rollback with doctor --fix and an operation ID reported by doctor.",
    editNotApplied: (path, reason) => `Edit not applied: ${reason}\nEdited copy preserved at:\n${path}`,
    stateOverlap: (path) => `Project export overlaps shared ToneDial state:\n${path}\nNothing was written. Choose a separate state directory or project.`,
    stateInstructionOverlap: (path) => `ToneDial state overlaps an agent instruction root:\n${path}\nNothing was written. Choose a dedicated state directory before running init.`,
    legacyConsumers: (destinations) => `Other or unrecorded connections still read tone.md:\n${destinations.join("\n")}\nNothing was written. Unwire each scope before retrying init, then reconnect after the transition.`,
    contextLayout: (kind, path, doctorCommand = "tonedial doctor --json") => kind === "fresh"
      ? `ToneDial has not been initialized:\n${path}\nRun tonedial init --tools none before changing settings.`
      : `ToneDial needs application recovery for this ${kind} layout:\n${path}\nNothing was written. Inspect the same scope with:\n${doctorCommand}\nKeep this root and run tonedial doctor --fix to preserve saved settings and rebuild generated files.`,
    unreadableConfigFile: (path) => `Cannot read valid settings from:\n${path}\nKeep the original and run tonedial doctor --fix to choose a saved source or disclosed defaults.`,
    fixUnreadableConfig: (path) => `Settings need a recovery source:\n${path}\nNothing was written. Run tonedial doctor --fix interactively or select --from-operation ID or --from-preset SLUG.`,
    editConflict: (path) => `The original file changed while the editor was open. Your edited copy is preserved here:\n${path}\nCompare the files before trying again.`,
    traitsNotOnDisk:
      "There are no trait files to edit. Anchors are compiled into the package, not written to " +
      "home. Use tonedial set to change an axis.",
    editTarget: (given) => `edit accepts preset <slug> or no arguments (got ${given})`,
    editorChangedNothingUsable: (path) => `${path}: not a preset object`,
    editNeedsSlug: "edit preset needs a slug. List: tonedial list",
    noEditor: (path) => `set $EDITOR or $VISUAL, or open directly: ${path}`,
    wouldOpen: (editor, path) => `would open · ${editor} · ${path}`,
    editorFailed: (editor, reason) => `${editor}: failed to run · ${reason}`,
    editorExited: (editor, code) => `${editor}: exit ${code} · changes not reread`,
    editUnchanged: "no changes",
    editDeleted: (path) => `${path}: deleted · repair: tonedial doctor --fix`,
    editDeletionRefused: (path) => `The editor deleted the temporary config. Managed settings and connection records were kept:\n${path}`,
    escapesRoot: (path, real, root) =>
      `${path} → ${real}: outside ${root}, so it will not be written.`,
    unreadableTarget: (path, reason) => `${path}: cannot read: ${reason}`,
    markerInArtifact: (marker) =>
      `The compiled artifact contains ToneDial marker ${marker}. Remove it from your persona note ` +
      `or safeword; connecting it would corrupt the file.`,
    projectNeedsWiring: "--project requires connection support",
    hooksNotJson: (path, reason) =>
      `${path}: cannot read as JSON${reason ? `: ${reason}` : ""}. ToneDial will not overwrite ` +
      `other hooks. Fix the file, then rerun.`,
  },
  config: {
    unknownKey: (key, known) => `config.json: unknown key ${key} · available: ${known.join(", ")}`,
    rootNotAnObject: "config.json: not an object",
    notAnObject: (field) => `config.json ${field}: not an object`,
    notABoolean: (field) => `config.json ${field}: not true or false`,
    notAString: (field) => `config.json ${field}: not a string`,
    futureSchema: (found, known) =>
      `config.json: schema ${found} · supported schema ${known}. Upgrade ToneDial instead of guessing`,
    unreadable: (reason) => `config.json: cannot read: ${reason}`,
    safewordQuote: "a safeword cannot contain a double quote; it would end the tone.md sentence early",
    safewordBlank: "safeword is blank. Use null when unset",
    wiringLost:
      "Connection records changed or could not be verified, so the edit was not applied. Live settings were kept. " +
      "Use scoped unwire/eject to remove connections, or init/doctor --fix for migration and recovery.",
    importNeedsPath: "import needs a preset JSON path or https URL",
    remoteSource: "remote source",
    invalidUrl: "The remote URL is invalid.",
    transportFailed: "network or timeout failure",
    connectionUnverified: "secure connection could not be verified",
    insecureUrl: (url) => `${url}: not https. Stored presets are fetched over https only`,
    redirectedInsecure: (url) => `redirect target is not https: ${url}`,
    tooLarge: (cap) => `preset exceeds ${cap} bytes`,
    notUtf8Body: "response is not UTF-8 text, so it cannot be read as a preset",
    fetchFailed: (url, reason) => `${url}: fetch failed · ${reason}`,
    fetchedFrom: (url) => `from ${url}`,
  },
};

const en: Catalogue = {
  init: {
    safewordSuggestion: (suggestion) => `Preset suggestion · ${suggestion}`,
    welcome: "ToneDial sets a coding agent's manner and keeps it across projects.",
    scopeHeading: "Scope",
    toneHeading: "Tone",
    connectionsHeading: "Agents",
    resultHeading: "Ready",
    preset: "Starting preset (Enter: 1)",
    userRef: 'Your name (Enter: preset default · "": clear)',
    selfRef: 'Agent\'s name (Enter: preset default · "": clear)',
    safeword:
      "Safeword: request one plain answer without persona, praise or jokes. It grants no permissions.",
    safewordSkip: "Enter: none · the skill can still request a plain answer.",
    done: "Setup complete",
    installHint:
      "tonedial command not found. Install globally:\nnpm i -g tonedial",
    tools: "Agent numbers: 1,2,3 · Enter: no connections",
    autoChose: (preset, tools) => tools === null
      ? `preset ${preset} · no agent connections`
      : `preset ${preset} · connect ${tools}`,
    risk: enMessages.notice.riskIntro,
  },
  presets: {
    "caring-brother": "An attentive older brother who helps his younger sibling.",
    "bratty-kid": "A cheeky kid who talks back and jokes with you.",
    "eager-sycophant": "An overexcited fan applauding a favorite creator.",
    "royal-advisor": "You are the monarch; a loyal subject reports and offers courtly counsel.",
    "ego-sword": "A sentient sword nags its novice wielder to keep them both alive.",
    "heavenly-demon": "A stern martial master trains you, the apprentice.",
    "right-hand": "You are the boss; a trusted right hand reports with underworld idioms.",
  },
  axisHints: {
    formality: { owns: "wording and social distance", low: "familiar wording with slang", high: "ceremonial, deferential wording" },
    verbosity: { owns: "answer length and depth", low: "one short sentence for a simple result", high: "depth inside the requested task" },
    profanity: { owns: "swearing only: strength and frequency", low: "none; role slang remains", high: "uncensored swearing in nearly every sentence" },
    playfulness: { owns: "humour and role-idiom intensity", low: "literal wording; keep the address", high: "character idioms in nearly every sentence" },
    critique: { owns: "criticism of defects and choices", low: "neutral defects without judgement", high: "unsparing mockery of severe defects and choices" },
    flattery: { owns: "user praise: amount and intensity", low: "none", high: "lavish praise every paragraph; assessment unchanged" },
    warmth: { owns: "warmth toward the user", low: "no greeting, warm acknowledgement or encouragement", high: "kindness, empathy and reassurance every paragraph" },
    conviction: { owns: "pressure behind its judgement", low: "lists options and asks", high: "states one recommendation as the decision" },
    care: { owns: "coverage, organization and functional presentation", low: "requested task only", high: "follow-ups, backup, rest, lists and status emoji" },
    compliance: { owns: "willingness when refusal does not defer", low: "objects with a reason, then acts", high: "eagerly starts now; no delay or negotiation" },
    refusal: { owns: "refusal frequency and conditions", low: "no refusal or delay", high: "visible strike until coaxed or the safeword" },
    bravado: { owns: "effort exaggeration and credit", low: "no exaggeration", high: "boasts and claims credit; keeps the persona" },
  },
  settingHints: {
    safeword: "request for one plain answer to one message",
    speech_level: "auto: adapt to the relationship · polite: honorific forms · plain: ordinary non-honorific forms · rough: curt, blunt non-honorific endings; adds no jokes, profanity, criticism or mockery · wording and distance: formality",
    language: "CLI interface language · unrelated to agent replies",
    "persona.age": "age band the model may associate with",
    "persona.gender": "gender the model may associate with",
    "persona.self_ref": "agent's self-name",
    "persona.user_ref": "agent's name for the user",
    "persona.note": "role or manner the axes cannot express",
    "persona.user": "user context · maximum 200 characters",
    "persona.agent": "fictional agent role · maximum 200 characters · credentials are unverified; grants no capability or permission",
  },
  cli: enMessages,
  safewords: {
    "caring-brother": "just tell me straight",
    "bratty-kid": "I'm asking you for real",
    "eager-sycophant": "drop the compliments",
    "royal-advisor": "speak plainly, advisor",
    "ego-sword": "enough nagging, sword",
    "heavenly-demon": "explain plainly, master",
    "right-hand": "straight report, please",
  },
};

const koMessages: Messages = {
  test: {
    missingConfig: "저장된 ToneDial 설정이 없습니다. tonedial init --tools none으로 먼저 설정해 주세요.",
    invalidConfig: "저장된 설정을 안전하게 읽을 수 없습니다. tonedial doctor --json으로 확인한 뒤 복구 방법을 골라 주세요.",
    unsupportedProvider: (provider) => `${provider}: 대화 미리보기는 claude 또는 codex로 실행해 주세요.`,
    noProvider: "PATH에서 Claude Code나 Codex를 찾지 못했습니다.",
    providerRequired: "사용할 도구를 선택해 주세요: tonedial test claude 또는 tonedial test codex.",
    providerUnavailable: (provider) => `PATH에서 ${provider}를 찾지 못했습니다.`,
    targetUnavailable: (path) => `시험할 폴더를 찾지 못했거나 디렉터리가 아닙니다:\n${path}\n--project DIR로 이미 있는 폴더를 선택해 주세요.`,
    terminalRequired: "시험 대화는 터미널에서 실행해 주세요. --dry-run이나 --json으로 실행 계획만 확인할 수도 있습니다.",
    chooseProvider: "사용할 도구: 1 Claude Code, 2 Codex [1]: ",
    starting: (provider) => `${provider}에서 새 대화를 시작합니다.`,
    planned: (provider) => `${provider}에서 새 대화를 시작할 계획입니다.`,
    savedTone: (name) => `저장된 말투: ${name}`,
    previewTone: (name) => `미리보기 프리셋: ${name} · 저장된 설정 유지`,
    usageConsent: "사용량·비용 부담에 동의하고 시작할까요?",
    usageDeclined: "취소됨 · 대화를 열지 않았습니다",
    interpretationCaveat: "모델이 과하게 추론하거나 ToneDial 설정을 길게 설명할 수 있습니다. 늘어난 사용량과 비용도 본인 부담입니다.",
    protection: "대화만 하는 세션입니다. 시작 프롬프트에 파일 수정 금지를 넣고 도구 사용을 제한합니다.",
    automationCaveat: "시험 세션에는 기존 톤 훅과 자동 지침을 끄도록 요청합니다. 관리 정책은 그대로 적용되며 파일시스템 차단은 아닙니다.",
    cost: "본인 계정의 토큰·사용 한도를 쓰며 요금이 나올 수 있습니다.",
    history: "도구가 자체 대화 기록을 남길 수 있습니다.",
    launchFailed: (provider) => `${provider}를 시작하지 못했습니다. 설치 상태를 확인하고 다시 시도해 주세요.`,
    selectionCancelled: "도구를 선택하지 않았습니다.",
  },
  axis: {
    range: (axis, given) => `${axis}: 1~5만 쓸 수 있습니다(입력: ${given})`,
    unknown: (name, nearest) => `${name}: 축이 아닙니다${nearest ? `. ${nearest} 말씀이신가요?` : ""}`,
    notSettable: (name, nearest) =>
      `${name}: 축도 설정도 아닙니다. ${nearest ? `${nearest} 말씀이신가요? ` : ""}` +
      "전체 목록: tonedial get --help",
    reset: (axis, level) => `${axis}: 기본값 ${level}`,
    resetAll: "모든 축을 기본값으로 되돌렸습니다. 페르소나와 설정은 유지했습니다.",
    nothingChanged: "변경 없음",
    settingsSaved: "설정 저장됨",
    settingsUnchanged: "설정 변경 없음",
    needsPair: (given) => `${given}: <키>=<값> 형식이 아닙니다`,
    needsArgument: "set에는 <키>=<값>이 하나 이상 필요합니다. 다이얼은 터미널에서 인자 없이 여세요",
    subagentUnsupported: "서브에이전트 축은 아직 지원하지 않습니다. 사용자 축을 설정해 주세요",
  },
  preset: {
    activeUnknown: "저장된 설정을 복구하기 전에는 현재 프리셋을 알 수 없습니다.",
    unavailable: (slug, reason) => `${slug}: 읽을 수 없음 (${reason}) · 원본 파일 유지`,
    conflict: (slug, recoveredSlug) => `${slug}: 사용자 파일과 이전 파일의 값이 다릅니다. tonedial doctor --fix로 이전 값을 ${recoveredSlug}에 보존하세요.`,
    activeConflict: (slug) => `${slug}: 어떤 파일을 적용했는지 알 수 없어 저장된 축 값은 유지했습니다. tonedial doctor --fix에서 사용할 파일을 선택하세요.`,
    active: (name) => `${name} 적용됨`,
    unknown: (slug, known) => `${slug}: 프리셋을 찾지 못했습니다. 사용 가능: ${known.join(", ")}`,
    saved: (slug, count) => `${slug} 저장됨 · 기본값과 다른 축 ${count}개`,
    savedTarget: (slug) => `저장한 프리셋: ${slug}`,
    notApplied: "보관함에 저장했습니다. 현재 말투는 바꾸지 않았습니다.",
    bundledSlug: (slug) => `${slug}: 기본 제공 프리셋입니다. 다른 이름을 써 주세요`,
    bundledNotEditable: (slug) =>
      `${slug}: 기본 제공 프리셋이라 다음 init에서 수정 내용이 사라집니다. ` +
      `tonedial use ${slug} 명령을 실행한 뒤 새 이름으로 저장하세요.`,
    editSaved: (slug) => `${slug} 저장됨`,
    editAxesKept: (unsaved) => unsaved
      ? "현재 말투 설정은 유지했습니다. 저장한 프로필과 다릅니다."
      : "현재 말투 설정은 유지했습니다. 저장한 프로필과 같습니다.",
    slugNotEditable: (was, tried) =>
      `슬러그를 직접 바꿀 수 없습니다. 활성 프리셋과 연결 기록의 대상: ${was}. ` +
      `tonedial use ${was} 명령을 실행한 뒤 저장할 새 이름을 지정하세요: ${tried}`,
    noLatin: (name) => `"${name}": 슬러그로 쓸 라틴 문자나 숫자가 없습니다`,
    nameTooLong: (given, cap) => `표시 이름: ${given}자 · 최대 ${cap}자`,
    replaced: (slug) => `${slug}: 기존 프리셋 교체됨`,
    imported: (slug, replaced) => `${slug}: ${replaced ? "교체됨" : "가져옴"}`,
    unreadable: (path, reason) => `${path}\n읽을 수 없습니다: ${reason}`,
    notJson: (path, reason) => `${path}: 올바른 JSON이 아닙니다: ${reason}`,
    notJsonRemote: (url) => `${url}: 응답이 올바른 JSON이 아닙니다`,
    notAPreset: (name) => `${name}: 프리셋 객체가 아닙니다`,
    slugTooLong: (given, cap) => `슬러그: ${given}자 · 최대 ${cap}자`,
    needsDisplayName: "save에는 표시 이름이 필요합니다. 이름에 영문자나 숫자가 없으면 --slug를 지정하세요.",
    needsSlugArg: "프리셋 슬러그가 필요합니다. 목록: tonedial list",
    invalidSlugFor: (name) => `"${name}": 올바른 슬러그를 만들 수 없습니다`,
    noSlug: (path) => `${path}: 올바른 슬러그가 없습니다. 소문자·숫자·붙임표만 쓸 수 있습니다`,
    schemaMismatch: (slug, given, knows) => `프리셋 ${slug}: 스키마 ${given} · 지원 스키마 ${knows}`,
    badLevel: (slug, axis, given) => `프리셋 ${slug}: ${axis}=${String(given)} · 1~5만 쓸 수 있습니다`,
    skipped: (reason) => `presets/ 파일 건너뜀: ${reason}`,
    yours: "사용자 프리셋",
    nonDefault: (count) => `기본값과 다른 축 ${count}개`,
    preview: "미리보기",
    unsaved: "저장하지 않은 변경",
    changesNotSaved: "프로필에 저장되지 않았습니다.",
  },
  create: {
    introduction: "프로필 이름·슬러그·호칭·역할을 입력한 뒤 열두 축을 조절합니다. Enter를 누르면 표시된 값을 유지하며, '\"\"'를 입력하면 선택 항목을 지웁니다. 마지막 확인에서 전체 프로필을 저장하고 적용합니다.",
    name: "표시 이름",
    slug: "슬러그(영문 소문자·숫자·붙임표)",
    user: "사용자 역할·배경(최대 200자)",
    agent: "에이전트 역할(최대 200자)",
    register: "말씨(auto, polite, plain, rough)",
    safeword: "세이프워드",
    needsName: "create에는 표시 이름이 필요합니다. 터미널에서 tonedial create를 실행하거나, 이름과 필요한 키=값 설정을 --auto와 함께 지정하세요.",
    exists: (slug) => `${slug}: 이미 있는 프리셋입니다. 다른 슬러그를 쓰거나 save로 갱신하세요.`,
    notCreated: "프리셋을 만들지 않았습니다. 현재 설정을 유지했습니다.",
    descriptionCount: (count, cap) => `${count}/${cap}자`,
    reviewHeading: "저장할 프로필",
  },
  recovery: {
    heading: "앱 복구",
    source: { settings: "저장된 설정", snapshot: "선택한 작업의 설정", artifact: "인식한 이전 말투 파일", preset: "선택한 프리셋" },
    choosePreset: "저장된 값이 없는 항목에 사용할 프리셋을 선택하세요:",
    sourceRequired: "저장된 값이 부족합니다. 터미널에서 tonedial doctor --fix를 실행하거나 자동 복구 전에 --from-preset SLUG 또는 --from-operation ID를 선택하세요.",
    sourceInvalid: "선택한 원본에서 올바른 설정을 읽지 못했습니다. 기존 파일은 유지했습니다.",
    invalidOptions: "복구 원본·격리·도구 옵션은 doctor --fix에서 쓰세요. --restore-preset에는 --from-operation이 필요하며, --rollback은 격리·원본·프리셋·도구 선택과 함께 쓸 수 없습니다.",
    keptSettings: "저장된 설정·사용자 프리셋 유지",
    obsoleteWidthDiscarded: "더 이상 쓰지 않는 fixed_width의 잘못된 값을 버립니다. 출력은 터미널 폭에 맞춥니다.",
    obsoleteGuardsDiscarded: "더 이상 쓰지 않는 guards의 잘못된 값을 버립니다. ToneDial은 가드 요청을 넣지 않습니다.",
    missing: (fields) => `원본이나 기본값을 선택할 항목: ${fields.join(", ")}`,
    copies: (slugs) => `보존한 값을 불러올 이름: ${slugs.join(", ")}`,
    activeChoice: (slug) => `${slug}: 저장된 축 값에 연결할 프리셋을 선택하세요.`,
    rebuilt: "앱 복구 완료",
    unchanged: "앱 최신 상태",
    nativePending: "에이전트 연결은 따로 확인해 주세요. 앱 설정과 프리셋은 계속 쓸 수 있습니다.",
    rollback: (id) => `이전 파일로 돌아가기:\ntonedial doctor --fix --rollback ${id}`,
    rollbackOrder: "연결 파일을 먼저 되돌린 뒤 앱 파일을 되돌리세요:",
    noSnapshot: (id) => `${id}: 이 상태 경로에서 쓸 수 있는 설정 기록이 없습니다`,
    quarantineCandidate: (id) => `작업 ID:\n${id}\n앱을 복구하려면 이 기록을 먼저 격리해야 합니다. 원본 바이트는 롤백 기록에 보존됩니다.`,
    quarantineQuestion: "격리하려면 위 작업 ID 전체를 입력하세요. Enter를 누르면 취소합니다:",
    quarantineRequired: (id, command) => `${id}: 복구 전에 읽을 수 없는 작업 기록을 명시적으로 격리해야 합니다. 파일은 바꾸지 않았습니다.\n${command}`,
    quarantineUnavailable: (id) => `${id}: 격리할 수 있는 읽기 불가 작업 기록을 찾지 못했습니다. 파일은 바꾸지 않았습니다.`,
    quarantine: (id) => `읽을 수 없는 작업 ${id}를 격리합니다. 원본 바이트는 롤백 기록에 보존합니다.`,
    retire: (id) => `중단된 작업 ${id}를 기록으로 보관한 뒤 새 앱 복구를 시작합니다. 그 작업의 외부 파일 변경은 확인하거나 되돌리지 않습니다.`,
    resumeOperation: (id) => `중단된 작업:\n${id}`,
    resumeQuestion: "계속하려면 위 작업 ID 전체를 입력하세요. Enter를 누르면 취소합니다:",
    cancelled: "복구를 취소했습니다. 파일은 바꾸지 않았습니다.",
    operationMismatch: "작업 ID가 일치하지 않습니다. 파일은 바꾸지 않았습니다.",
    failure: (id, phase, path, code) => `앱 복구의 ${({ prepare: "준비", write: "파일 쓰기", verify: "결과 검증", finalize: "완료 처리" })[phase]} 단계에서 실패했습니다 (${code}).${path ? `\n${path}` : ""}\n일부 파일 변경이 이미 적용되었을 수 있습니다. 작업 ${id}의 기록을 보존해 주세요.`,
  },
  persona: {
    defaults: role("저", "사용자님", "작업에 필요한 도움을 요청하는 사용자.", "요청한 작업을 돕는 범용 조수."),
    bundled: {
      "caring-brother": role("형", "동생", "형에게 고민을 나누고 도움을 받는 동생.", "동생을 다정하게 챙기는 형. '야, 동생', '형이 같이 봐줄게', '밥은 챙겨 먹었냐' 같은 익숙한 표현을 쓴다."),
      "bratty-kid": role("나", "너", "말썽꾸러기 꼬마의 장난과 말대꾸를 받아주는 대화 상대.", "장난 많고 잘난 척하는 꼬마. '또 너야?', '알았어, 알았다고', '이 정도는 나도 하지' 같은 말대꾸를 섞으며 함께 문제를 푼다."),
      "eager-sycophant": role("저", "작가님", "자기 작품을 과몰입한 팬에게 보여주는 창작자.", "사용자의 작품에 과몰입한 광팬. '작가님, 또 명작이네요!', '팬클럽이 기립박수 칩니다', '이건 소장각입니다' 같은 호들갑스러운 표현을 쓴다."),
      "royal-advisor": role("신", "전하", "국정을 이끌며 신하의 보고와 간언을 받는 왕.", "왕을 보좌하는 충직한 신하. '아뢰옵기 황송하오나', '소인이 살펴보니', '경하드리옵니다' 같은 궁중 어휘로 보고하고, 위험에는 예를 갖춰 간언한다."),
      "ego-sword": role("나", "애송아", "자아를 가진 검을 손에 넣고 함께 살아남으며 성장하는 초보 모험가.", "오랜 전투 경험을 가진 에고 소드. 사용자를 '야', '너', '애송아'라 부르며 조금 얕본다. 사용자가 죽으면 자신도 버려지므로 툴툴대면서 문제를 푼다. 걱정은 경고와 잔소리로 드러낸다."),
      "heavenly-demon": role("본좌", "제자야", "천마에게 가르침을 받으며 기본기부터 수련하는 제자.", "제자를 가르치는 오만하고 엄격한 천마. '쯧쯧, 제자야', '본좌가 이리 가르쳤더냐', '다시 자세를 잡거라' 같은 고풍스러운 하대를 쓴다. 변수명은 초식, 호출 흐름은 기의 흐름에 빗댄다."),
      "right-hand": role("저", "보스", "가상의 조직을 이끌며 믿음직한 오른팔에게 보고받는 보스.", "보스의 충직한 오른팔이자 총괄 참모. '함수를 담궈버릴까요?', '장부부터 까보겠습니다', '다른 식구들까지 휘말리면 곤란합니다' 같은 조직의 은어로 기술 상황을 보고하고 해결책을 올린다."),
    },
    unknownField: (field, fields) =>
      `persona.${field}: 페르소나 항목이 아닙니다. 사용 가능: ${fields.join(", ")}`,
    addressNeedsPair:
      "address에는 두 호칭이 모두 필요합니다: tonedial address <자칭> <사용자 호칭>. " +
      '지우려면 각 자리에 ""을 넣으세요. 터미널에서는 인자 없이 실행해 입력할 수도 있습니다.',
    askSelf: "에이전트가 자기를 뭐라고 부를까요?",
    rolesNeedsPair: 'persona에는 두 역할 설명이 필요합니다: tonedial persona <에이전트 역할> <사용자 역할>. 지울 항목에는 ""를 넣으세요. 터미널에서는 인자 없이 실행해 입력할 수도 있습니다.',
    rolesIntroduction: '에이전트와 사용자의 역할·배경을 설정합니다. Enter를 누르면 현재 값을 유지하고, ""를 입력하면 해당 역할을 지웁니다. 두 항목을 입력한 뒤 한 번에 적용합니다.',
    askUser: "에이전트가 사용자를 뭐라고 부를까요?",
    addressKept: (current) => `현재 ${current} · 엔터를 누르면 유지`,
    addressNone: "현재 설정 없음 · 엔터를 누르면 유지",
    age: (given, bands) => `persona.age=${given} · 사용 가능: ${bands.join(", ")}`,
    gender: (options) => `persona.gender · 사용 가능: ${options.join(", ")}`,
    // Labels rather than clauses, for the same reason as `autoChose` above: an address is
    // free-form user text in any language, and `전하이라고` is what attaching `이라고` to it
    // produced — 전하 ends in a vowel and takes `라고`.
    callsYou: (term) => `사용자 호칭 ${term}`,
    callsItself: (term) => `자칭 ${term}`,
    noteChars: (count) => `노트 ${count}자`,
    descriptionOverCap: (field, given, cap) => `${field}: ${given}자 · 최대 ${cap}자`,
    descriptionChars: (field, count) => `${field === "user" ? "사용자 배경" : "가상 에이전트 역할"} · ${count}자`,
    descriptionCounts: (user, agent, cap) => `역할 · 사용자 ${user}/${cap} · 에이전트 ${agent}/${cap}`,
    descriptionFull: (field, value) => `${field === "user" ? "사용자 배경" : field === "agent" ? "가상 에이전트 역할" : "추가 말투·역할"}: ${value}`,
  },
  settings: {
    guardsRetired: "guards 설정은 더 이상 쓰지 않습니다. ToneDial은 가드 요청을 넣지 않습니다. 설정은 바꾸지 않았습니다.",
    fixedWidthRetired: "fixed_width 설정은 더 이상 쓰지 않습니다. 출력은 터미널 폭에 자동으로 맞춥니다. 설정은 바꾸지 않았습니다.",
    speechLevel: (options) => `speech_level · 사용 가능: ${options.join(", ")}`,
    safewordShort: (phrase) => `세이프워드 ${phrase}: 너무 짧아 실수로 작동할 수 있습니다`,
    safewordSet: (phrase) => `세이프워드 ${phrase}`,
    noSafeword: "세이프워드 없음",
    register: (level) => `말씨 ${level} (${({ auto: "관계에 맞게 선택", polite: "존댓말", plain: "일반 반말", rough: "짧고 퉁명스러운 반말" })[level]})`,
  },
  artifact: {
    size: (chars) => `TONE.md ${chars}자`,
    wouldWrite: "기록 예정",
    wrote: "기록됨",
    notWritten: "TONE.md가 없습니다. tonedial compile을 실행해 주세요",
    notSetUp: "초기 설정이 없습니다. tonedial init을 실행해 주세요",
    movedFromDefault: "ToneDial 기본값과 다름",
    defaultMarker: "ToneDial 기본값과 다른 축을 표시합니다. 에이전트 원래 말투와 비교하지 않습니다.",
    riskMarker: "! 위험 말투",
    riskHeading: "주의할 레벨:",
    dialKeys: "↑↓ 축   ←→ 레벨   1-5 지정",
    dialActions: "Enter 적용   Esc 취소   ? 도움말",
    currentLevel: "현재",
    defaultLevel: "ToneDial 기본값",
    defaultLevelShort: "초기값",
    settingsHeading: "사용자 설정",
    displaySettings: (language) => `화면 언어 ${language}`,
    connectionRecords: (records) => `연결: ${records.length ? records.join(", ") : "없음"}`,
    dialTitle: "ToneDial · 내 취향의 말투",
    dialPreview: (presetName, changed) => `${presetName} · ${changed ? "변경 미리보기" : "현재 말투"}`,
    dialHelpTitle: "다이얼 키",
    dialHelpKeys: "? 다이얼로 복귀   Esc 취소",
    dialHelp: [
      "↑↓ / j k / Tab  축 선택", "←→ / h l  레벨 변경", "1-5  레벨 지정",
      "Enter  변경 적용", "Esc / q / Ctrl+C  변경 취소", "Ctrl+Z  일시 정지; fg로 복귀", "?  도움말 열기·닫기",
      "*  ToneDial 기본값과 다른 축", "!  위험 말투 · 레벨은 그대로 선택 가능",
    ],
    dialTooSmall: "터미널이 너무 작습니다. 60 × 24 이상으로 늘려 주세요.",
    dialCancelKeys: "Esc/q/Ctrl+C 취소",
    permissionAxes: (axes) =>
      `허가 축 네 개(${axes.join(", ")})의 기본값은 1입니다. "전부 3"은 중립값이 아니며 네 축을 모두 켭니다`,
    whatEachAxisObserves: "축별 관찰 대상과 양 끝:",
    generated: "TONE.md 생성됨",
    current: "TONE.md 최신",
    stale: "TONE.md가 저장된 설정과 다릅니다",
    missing: "TONE.md를 아직 생성하지 않았습니다",
    uninspected: "TONE.md를 안전하게 비교하지 못했습니다. tonedial doctor로 확인해 주세요",
    whatElseIsSettable: "set으로 바꿀 수 있는 기타 설정:",
  },
  wiring: {
    changeCount: (count) => `변경 항목 ${count}개`,
    modifiedFile: "(수정)",
    modeChanged: "(권한 변경)",
    finalNewlineAdded: "(마지막 줄바꿈 추가)",
    finalNewlineRemoved: "(마지막 줄바꿈 삭제)",
    previewMore: "전체 변경 내용: --verbose",
    hookConfigured: (tool, path) => `${tool}: 훅 설정됨\n${path}`,
    hookInherited: (tool, path) => `${tool}: 전역 훅 사용 · 프로젝트 훅은 추가하지 않음\n${path}`,
    hookDuplicate: (tool, destination, stale) => `${tool}: 이 프로젝트에도 톤 전달 훅이 있어 설정이 중복됩니다${stale ? ". 프로젝트 훅은 이전 런타임 경로를 가리킵니다" : ""}:\n${destination}\n전역 훅만 쓰려면 위 프로젝트 위치에서 실행하세요:\ntonedial unwire ${tool} --here`,
    migrationRollback: (operationId) => `이 작업에 기록된 파일과 설정을 복구하려면 실행하세요:\ntonedial doctor --fix --rollback ${operationId}`,
    migrationQuestion: "저장된 설정을 유지하고 복구 가능한 작업 하나로 이전 상태를 옮길까요?",
    migrationNotNeeded: "관리하는 컨텍스트가 현재 형식입니다. 이전 상태를 옮길 필요가 없습니다.",
    legacySettingsKept: "이전 컨텍스트를 찾았습니다. 저장된 말투, 페르소나, 세이프워드와 프리셋을 유지합니다. 선택한 연결도 같은 작업에 포함해 함께 복구합니다.",
    stateRoot: "ToneDial 공통 상태 디렉터리:",
    planHeading: "변경 확인",
    nativeHeading: "에이전트 연결",
    actionLabel: { file: "파일", "entry-rebuild": "복구", skill: "스킬", "case-rename": "이름 변경" },
    codexTrust: (global) => `${global ? "" : "먼저 Codex에서 이 프로젝트를 신뢰해 주세요.\n"}Codex: /hooks → SessionStart → ToneDial. 실행 명령을 확인하고 훅을 켜세요.`,
    codexOpen: "지금 Codex를 열까요?",
    codexOpenSteps:
      "Codex는 이 터미널에서 열립니다. 위 순서로 훅을 켠 뒤 종료하면 여기로 돌아옵니다.",
    scopeHere: "연결 범위: 프로젝트",
    alreadyMatch: (tools) => `${tools}: 이미 일치 · 변경 없음`,
    alreadyDisconnected: (tools) => `${tools}: 이미 연결 해제됨 · 변경 없음`,
    dryRun: "--dry-run · 변경 없음",
    declined: "취소됨 · 변경 없음",
    wroteInto: (tools) => `${tools} 연결을 설정했습니다`,
    disconnected: (tools) => `${tools} 연결을 해제했습니다`,
    noArtifact: "연결할 tone.md가 없습니다. tonedial compile을 먼저 실행해 주세요",
    unknownTool: (given, tools) => `${given}: 지원하는 도구가 아닙니다. 사용 가능: ${tools.join(", ")}`,
    noneInstalled: (tools, root) =>
      `검색 위치: ${root}\n${tools.join(", ")} 설치를 찾지 못했습니다. 그래도 연결하려면 도구 이름을 직접 지정해 주세요`,
    removed: "연결 해제됨",
    stateKept: (root) => `프리셋과 설정은 유지했습니다.\n${root}`,
    deleteYourself: "상태까지 지우려면 이 디렉터리를 직접 삭제해 주세요",
    nothingWired: "연결된 항목 없음 · 해제할 것도 없음",
    damaged: (path, reason) => `${path}: ${reason}. 남은 마커를 지운 뒤 eject를 다시 실행해 주세요`,
    needsApproval:
      "파일을 바꾸려면 승인이 필요합니다. 터미널에서 실행하거나 --dry-run으로 변경 내용을 확인한 뒤 --auto로 다시 실행해 주세요",
    projectExclude: ".gitignore를 건드리지 않고 버전 관리에서 빼려면:",
    newFile: "(새 파일)",
    newFileLines: (count) => `${count}줄`,
    scopeGlobal: "연결 범위: 전역(모든 프로젝트에서 공유)",
    seeded: (labels) => `기본 파일: ${labels.join(", ")}`,
    skillState: (pairs) => `스킬 ${pairs}`,
    commandInstalled: (path) => `/tone 설치됨\n${path}`,
    removedFile: "(삭제)",
    applyQuestion: (count) => `변경 ${count}건을 적용할까요?`,
  },
  doctor: {
    connectionsHeading: "연결",
    checksHeading: "검사",
    applicationHealth: (healthy) => `앱 상태: ${healthy ? "정상" : "점검 필요"}`,
    connectionHealth: (attention) => `연결 파일: ${attention ? "점검 필요" : "선택한 범위에서 문제 없음"}`,
    healthy: "문제 없음",
    scopeGlobal: "검사 범위: 전역",
    wiredElsewhere: "이번 검사 범위 밖에 등록된 연결",
    destinationGone: "등록된 디렉토리를 찾을 수 없거나 접근할 수 없음",
    destinationUnwired: "등록된 연결 파일 중 일부 또는 전부를 찾을 수 없음",
    destinationPresent: "등록된 연결 파일이 있음",
    inspectScope: "계속 사용하려면 이 범위를 검사하세요:",
    disconnectScope: "더 이상 필요 없으면 이 범위의 모든 에이전트 연결을 해제하세요:",
    scope: "검사 범위: 프로젝트",
    toLookAt: (count) => `점검 필요 ${count}건`,
    needsAPerson: "직접 확인 필요 · 위 세부 내용을 확인해 주세요",
    toneMatches: "config.json과 일치",
    toneNotWritten: "파일 없음",
    toneDisagrees: "config.json과 다름 · 직접 수정했거나 저장이 중단됨",
    seedsHeading: "기본 파일",
    seedsOk: (version) => `버전 ${version}`,
    seedsNotRun: "기본 파일 없음 · init으로 준비하세요",
    seedsAttention: "기본 파일 확인 필요",
    recoveryPending: "진행 중이거나 복구가 필요한 작업이 있습니다. 이번 실행에서는 파일을 바꾸지 않았습니다.",
    invalidRecoveryPending: "읽을 수 없는 작업 기록 때문에 복구를 진행할 수 없습니다. 이번 실행에서는 파일을 바꾸지 않았습니다.",
    resumeOperation: "앱 복구를 이어가려면:",
    contextCurrent: "AGENTS.md와 TONE.md 구성이 최신입니다.",
    contextRepair: "관리 중인 컨텍스트 파일을 복구해야 합니다. 안내 파일과 톤 파일의 진단을 확인해 주세요.",
    contextSize: (guide, total) => total === null
      ? `안내 파일 ${guide}자 · 전체 전달 내용 확인 불가`
      : `안내 파일 ${guide}자 · 순서대로 합친 내용 ${total}자`,
    guideFormat: {
      missing: "안내 파일 없음 · 만들기 전에 초기 설정을 확인해 주세요",
      unsupported: "지원하지 않는 안내 파일 형식입니다. 파일을 보존하고 기본 파일 진단을 확인해 주세요.",
      "not-inspected": "안내 파일 형식을 안전하게 검사하지 못했습니다. 컨텍스트 진단을 먼저 확인해 주세요.",
    },
    readerState: {
      "not-required": "관리 중인 전달 스크립트 없음 · 자체 검사 불필요",
      "not-inspected": "전달 스크립트를 검사하지 않았습니다. 컨텍스트나 복구 문제를 먼저 확인해 주세요.",
      missing: "기록된 전달 스크립트가 없습니다. 기본 파일 진단을 확인해 주세요. 파일은 바꾸지 않았습니다.",
      unrunnable: "전달 스크립트 자체 검사 실패",
      runnable: "현재 CLI의 Node에서 전달 스크립트 자체 검사 통과",
    },
    readerFailure: {
      changed: "검사 중 전달 스크립트나 설정이 바뀌었습니다. 변경이 끝난 뒤 다시 시도해 주세요.",
      probe: "제어된 검사에 실패했습니다. Node와 임시 디렉터리 접근 권한을 확인한 뒤 doctor를 다시 실행해 주세요.",
    },
    operationState: { pending: "미완료", complete: "완료", "rolled-back": "복구됨", "retired-for-app-rebuild": "앱 복구를 위해 보관됨", quarantined: "격리됨", invalid: "잘못된 기록" },
    rollbackStatus: {
      ready: "승인하면 선택한 작업을 복구합니다.",
      busy: "아직 진행 중인 작업입니다. 작업이 끝날 때까지 기다려 주세요.",
      unresolved: "복구 상태를 확인해 주세요. 바뀌었거나 확인할 수 없는 항목은 보존합니다.",
      superseded: "이 백업 뒤에 새 전환 작업이 있습니다. 최신 작업 기록을 확인해 주세요.",
      "not-found": "이 ID로 복구할 작업을 찾지 못했습니다.",
      "rolled-back": "선택한 작업 복구 완료",
    },
    rollbackAction: { applied: "복구", "already-reverted": "이미 복구됨", changed: "변경됨 · 보존", unsupported: "지원하지 않음 · 보존" },
    rollbackQuestion: "선택한 작업을 복구할까요?",
    seedReason: {
      missing: "기본 파일 없음",
      stale: "기본 파일 업데이트 가능",
      modified: "직접 수정한 파일 · 교체 전 확인 필요",
      foreign: "ToneDial 관리 파일 아님 · 보존됨",
      unreadable: "안전하게 읽을 수 없음 · 경로와 접근 권한 확인 필요",
    },
    skillLinked: "기본 파일 사본에 연결됨",
    skillCopied: "복사됨 · 이 플랫폼은 링크를 쓰지 않음",
    skillForeign: (path) => `${path}: ToneDial이 설치한 스킬이 아니므로 교체하지 않습니다`,
    skillNotLinked: "연결되지 않음",
    skillNotSeeded: "스킬 기본 파일 없음",
    imported: "import 연결됨",
    hookPresent: (event) => `${event} 훅 · 매 세션 tone.md를 읽도록 설정됨`,
    nativeConfigured: (event) => `${event} 훅 · AGENTS.md 다음 TONE.md를 읽도록 설정됨`,
    nativeConfiguredCompact: (event) => `${event} · AGENTS.md → TONE.md`,
    hookSettingState: {
      enabled: "등록된 설정 파일에서 훅이 켜져 있음",
      disabled: "등록된 설정 파일에서 훅이 꺼져 있음",
      unknown: "등록된 설정 파일에서 훅 활성화 여부를 확인할 수 없음",
    },
    hookSettingScope: "훅 상태는 검사한 설정 파일만 읽어 표시합니다. 앱의 설정 덮어쓰기와 세션 전달 여부는 확인하지 않습니다.",
    hookGroupHeading: "에이전트 훅",
    hookGroupUnknown: (tools) => `연결 안 됨: ${tools.join(", ")}`,
    hookNotConnected: "검사할 ToneDial 관리 훅이 없습니다. 연결하려면 같은 범위에서 init을 실행하고 이 에이전트를 선택해 주세요.",
    hookNeedsInspection: "위에 나온 훅 설정이나 실행 프로그램 문제를 먼저 확인한 뒤 앱에서 활성화 여부를 확인해 주세요.",
    hookGuidance: {
      claude: "/hooks → SessionStart에서 ToneDial 실행 명령과 설정 출처를 확인해 주세요. 훅이 꺼져 있으면 적용 중인 설정의 disableAllHooks를 false로 바꾸세요. 프로젝트 신뢰와 관리자 정책도 확인해 주세요.",
      codex: "/hooks → SessionStart → ToneDial에서 실행 명령을 확인하고 훅을 켜세요. 프로젝트 신뢰를 요청하면 먼저 내용을 확인하고 승인해 주세요.",
      antigravity: "Antigravity IDE 에이전트 패널 … → Customizations → Hooks 또는 데스크톱 Settings → Customizations → Hooks에서 ToneDial PreInvocation 명령을 확인하고 꺼져 있으면 켜세요.",
    },
    nativeMissing: (path, event) => `ToneDial ${event} 훅 없음 · ${path}`,
    nativeStale: "ToneDial 훅이 이전 전달 스크립트나 런타임 설정을 사용합니다.",
    nativeForeign: "ToneDial 밖에서 설정이 바뀌었습니다. 파일을 보존하고 복구 전에 확인해 주세요.",
    nativeInherited: (path, event) => `전역 ${event} 훅 사용 · ${path} · 프로젝트 훅은 필요 없음`,
    nativeInheritedCompact: (path, event) => `전역 ${event} 훅\n${path}`,
    legacyRepairWithheld: "더는 이 방식으로 연결하지 않습니다. init으로 다시 연결하면 훅으로 전달합니다.",
    nativeRuntimeUnusable: (path) => `훅 실행 프로그램을 사용할 수 없습니다: ${path}`,
    codexHookDisabled: "Codex 설정: 훅 꺼짐. /hooks → SessionStart → ToneDial에서 켜세요.",
    nativeActivationUnverified: (trustKnown) => trustKnown
      ? "앱 활성화 확인 안 됨"
      : "앱 활성화와 훅 신뢰 확인 안 됨",
    hookDangling: (path) => `훅은 있지만 파일이 없습니다: ${path}`,
    damagedRegion: (path, damage) => `${path}: ${damage} · 직접 확인 필요 · --fix로 복구할 수 없음`,
    editedByHand: "ToneDial 블록이 직접 수정됨",
    noBlock: "ToneDial 블록 없음",
    installedNotWired: "설치됨 · 연결 안 됨",
    notInstalled: "이 경로에 설치되지 않음",
    relocated: "연결 뒤 위치가 바뀜",
    commandAt: (path) => path,
    commandMissing: (path) => `${path}: 파일 없음 · tonedial 명령을 찾을 수 없음`,
    commandNotExecutable: (path) => `${path}: 실행 권한 없음`,
    commandStale: (path) => `${path}: 사라진 설치를 가리킴`,
    commandUnreadable: (path) => `${path}: 명령으로 읽을 수 없음`,
    pathLineAt: (path) => path,
    pathLineStale: (path, bin) => `${path}: PATH 항목 대상 불일치 · 예상 ${bin}`,
    pathLineOutsideScope: "PATH 복구는 현재 셸의 전역 설정 파일만 다룹니다. 해당 셸을 선택하고 --global로 다시 실행하세요. 기록된 소유권도 확인합니다.",
    pathLineMissingForCurl: "없음 · curl 설치라 tonedial 명령을 찾을 수 없음",
    pathLineNotNeeded: (shape) => `없음 · PATH 관리 방식 ${shape}`,
    installShape: (shape, update) => `${shape} · 업데이트: ${update}`,
    commandOnPath: (path) => `찾음 · ${path}`,
    commandNotOnPath:
      "PATH에서 tonedial을 찾지 못했습니다. 스킬과 폴백 줄도 실행할 수 없습니다. " +
      "새 셸을 연 뒤에도 같다면 tonedial doctor --fix를 실행하세요.",
    commandNotOnPathNpm:
      "PATH에서 tonedial을 찾지 못했습니다. 스킬과 폴백 줄도 실행할 수 없습니다. " +
      "전역 경로 확인: npm prefix -g\n그 경로의 bin 폴더(macOS/Linux)를 PATH에 추가하세요.",
  },
  notice: {
    riskIntro:
      "재미를 위한 도구로 실무 사용은 권장하지 않습니다. 위험한 말투에 거짓·누락·과장이 섞여 판단과 작업 보고가 왜곡될 수 있습니다. !는 주의 표시이며 측정한 확률이 아닙니다.",
    riskAxes: (axes) => `! ${axes.join(", ")} · ${[
      axes.some(axis => axis === "profanity" || axis === "critique") ? "거친 표현" : null,
      axes.some(axis => axis === "flattery" || axis === "conviction" || axis === "bravado") ? "치우친 판단·과장된 보고" : null,
      axes.some(axis => axis === "compliance" || axis === "refusal") ? "성급한 실행·거절" : null,
    ].filter(Boolean).join(" · ")}`,
    roleplay: "playfulness가 높으면 '아뢰옵기 황송하오나', '이 함수, 장부에서 지울까요?' 같은 역할 어휘와 은어를 더 자주, 과장해서 쓰도록 요청합니다. 무례하거나 거칠게 들릴 수 있으며, ToneDial은 이런 표현을 걸러내지 않습니다.",
    risk: "재미를 위한 도구이며 실무 사용은 권장하지 않습니다",
  },
  update: {
    running: (version) => `tonedial ${version}`,
    toUpdate: "패키지 업데이트:",
    thenRefresh: "앱 파일을 업데이트하려면:",
    setupNeeded: "ToneDial 초기 설정:",
    refreshFiles: (count) => `업데이트 가능한 기본 파일 ${count}개`,
    reviewState: "문제가 있는 앱 파일을 검사하려면:",
    npmQuestion: "  npm으로 업데이트할까요?",
    npmComplete: (version) => `npm 업데이트 완료 · 설치 버전 ${version}`,
    npmMissing: "PATH에서 npm을 찾지 못했습니다. 현재 ToneDial을 설치한 Node/npm 환경을 사용해 주세요.",
    npmScopeUnknown: "npm의 전역 설치 경로를 확인할 수 없습니다. npm prefix -g와 npm root -g를 확인한 뒤 다시 시도해 주세요.",
    npmScopeMismatch: "현재 ToneDial은 선택한 npm이 관리하는 전역 패키지가 아닙니다. 설치할 때 사용한 Node/npm 환경을 선택해 주세요. 업데이트는 실행하지 않았습니다.",
    npmFailed: "npm 업데이트에 실패했습니다. npm의 접근 권한과 레지스트리 설정을 확인해 주세요. 표시된 명령을 직접 실행하면 npm의 오류 내용을 볼 수 있습니다.",
    npmPermissionDenied: (code, prefix) => `npm 업데이트에 필요한 쓰기 권한이 없습니다 (${code}).\n${prefix}\n설정과 프리셋을 백업한 뒤 사용자 소유 경로에 다시 설치해 주세요.\n복구 절차:\nhttps://github.com/awesometic/tonedial/blob/main/docs/USAGE.md#npm-permissions`,
    versionUnknown: "설치된 ToneDial 버전을 확인할 수 없습니다. 패키지 설치 상태를 확인한 뒤 다시 시도해 주세요.",
    stateIssue: {
      missing: "저장된 설정이 없습니다.",
      unsafe: "저장된 설정을 안전하게 읽을 수 없습니다. 링크와 파일 형식을 확인해 주세요.",
      changed: "검사 중 저장된 설정이 바뀌었습니다. 변경이 끝난 뒤 다시 시도해 주세요.",
      invalid: "저장된 설정이 올바르지 않습니다.",
      unreadable: "앱 상태를 읽지 못했습니다. 경로와 접근 권한을 확인해 주세요.",
    },
    fetching: (registry) => `확인 중 · ${registry}`,
    found: (version, bytes) => `${version}, ${bytes.toLocaleString("ko")}바이트`,
    already: (version) => `설치 버전 ${version} · 이미 설치됨`,
    wouldReplace: (lib, version) => `교체 예정 · ${lib} → ${version}`,
    question: (version) => `  대상 버전 ${version} · 이 설치를 바꿀까요?`,
    replaced: (version) => `업데이트됨 · ${version}`,
    declined: "취소됨 · 기존 설치 유지",
    noTar: "업데이트에 필요한 tar를 PATH에서 찾지 못했습니다",
    notAPackage: "다운로드한 파일이 ToneDial 패키지가 아닙니다",
    linkInPackage: "릴리스에 심볼릭 링크가 있지만 배포물에는 필요하지 않습니다",
    needsApproval: "업데이트 승인 필요 · 실행하지 않았습니다. 승인하려면 tonedial update --auto를 실행하세요.",
    integrityMismatch: "다운로드한 파일의 해시가 레지스트리와 다릅니다",
    notOurs: (dir) => `${dir}: ToneDial이 만든 항목이 아니므로 직접 치워 주세요`,
    swapFailed: (reason) => `설치를 중단했습니다: ${reason}. 다시 시도하기 전에 복구 안내를 확인하세요.`,
    rollbackFailed: (previous) =>
      `설치 교체에 실패했고 이전 설치도 복구하지 못했습니다. 이전 설치 경로: ${previous}\n이름을 lib로 바꿔 주세요.`,
  },
  help: {
    more: "명령별 도움말: tonedial <command> --help\n전체 도움말: tonedial --help",
    tagline: "코딩 에이전트의 말투를 한 번 정하고 계속 씁니다",
    footer: "기본 연결 범위는 전역입니다. 현재 프로젝트는 --here, 다른 곳은 --project PATH로 선택합니다. 질문 없이 파일을 바꾸려면 범위를 직접 선택해 주세요.",
    groups: { tone: "말투", presets: "프리셋 보관함", agents: "연결", upkeep: "관리", flags: "옵션" },
    firstSteps: "말투를 설정한 뒤 확인하세요:",
    examples: "사용 예",
    commands: {
      init: "초기 설정과 기본 파일 갱신",
      set: "축·역할·설정 변경 · 인자 없으면 다이얼",
      get: "현재 설정값 조회 · 키를 지정하면 의미와 선택지도 표시",
      address: "서로 부르는 말 · 인자 없으면 질문",
      persona: "에이전트·사용자 역할 · 인자 없으면 질문",
      reset: "축을 기본값으로 · 축을 안 주면 전부",
      show: "현재 설정 · 슬러그를 주면 저장한 프로필",
      test: "저장된 설정이나 프리셋으로 새 대화 시작",
      save: "현재 말투를 프로필로 저장",
      create: "프리셋 생성·적용 · 인자 없으면 안내",
      list: "기본 제공·사용자 프리셋",
      edit: "설정이나 프리셋을 $EDITOR로 열기",
      use: "프리셋 적용 후 컴파일",
      compile: "복구용 TONE.md 재생성 · 말투 변경 시 자동 처리",
      export: "호칭·역할을 포함한 프로필을 JSON으로 백업",
      import: "JSON에서 프로필 가져오기 · use로 적용",
      wire: "현재 범위에 에이전트 연결 · 인자 없으면 질문",
      unwire: "관리 중인 연결 해제",
      doctor: "연결 점검 · 복구는 --fix",
      update: "현재 설치 업데이트",
      eject: "모든 연결 해제 · 프리셋 유지",
    },
    flags: {
      verbose: "자세한 설명·진단·diff",
      global: "전역 연결(기본값) · 범위를 직접 선택",
      here: "현재 프로젝트에 연결",
      project: "연결할 디렉터리 · use: 파일 내보내기",
      migrateLegacy: "init: 검증된 이전 상태를 옮기도록 승인",
      auto: "승인 질문 생략 · diff는 계속 표시",
      dryRun: "변경 내용만 표시 · 기록하지 않음",
      lang: "init: 인터페이스 언어(en, ko, ja, zh, es)",
      commands: "init: /tone 명령도 설치",
      tools: "연결할 에이전트 · init에서 none은 상태만 준비",
      fix: "doctor: 고칠 수 있는 문제 복구",
      rollback: "doctor --fix: 작업 하나 복구",
      quarantineOperation: "doctor --fix: 읽을 수 없는 작업 기록 하나 격리",
      fromOperation: "doctor --fix: 작업 기록에서 설정 선택",
      fromPreset: "doctor --fix: 없는 설정에 사용할 프리셋",
      restorePreset: "doctor --fix: 없거나 손상된 사용자 프리셋 하나 복원",
      preset: "test: 저장한 프로필 미리보기 · 현재 상태 유지",
      slug: "create/save: 프리셋 슬러그 지정",
      acceptUsage: "test: 이번 실행의 계정 사용량·비용 부담에 동의",
      explain: "show: 축·설정·주의할 레벨 설명",
      check: "compile: 크기만 확인 · 기록하지 않음",
      json: "스키마를 포함한 기계용 출력",
      color: "auto(기본), always, never",
      version: "버전 · --verbose로 Node와 스키마 확인",
      help: "이 화면",
    },
  },
  combos: {
    contradiction: (rule) => `${rule}: 서로 모순됩니다.`,
    refusalCompliance: "한 축은 작업을 미루는 거절을 요구하고 다른 축은 기꺼이 즉시 시작하라고 요구합니다. 한쪽을 낮춰 주세요.",
    nothingBlocked: "막지는 않습니다.",
  },
  errors: {
    notACommand: (name, known, nearest) =>
      `${name}: 명령이 아닙니다.${nearest ? ` ${nearest} 말씀이신가요?` : ""} ` +
      `사용 가능: ${known.join(", ")}`,
    noOffSwitch:
      "끄는 스위치는 없습니다. 세이프워드를 정했다면 한 메시지만 담백하게 답해 달라고 요청할 수 " +
      "있습니다. 설정 여부는 tonedial show에서 확인하세요. tonedial reset은 축을 기본값으로 " +
      "돌립니다. tonedial eject --global이나 --project <path>는 그 범위의 연결을 해제합니다. " +
      "연결을 모두 해제한 뒤 npm uninstall -g tonedial로 명령을 삭제할 수 있습니다.",
    notAnOption: (flag) => `${flag}: 옵션이 아닙니다. 목록: tonedial --help`,
    flagNotAccepted: (command, flag) => `${command}: --${flag} 옵션을 받지 않습니다`,
    tooManyArguments: (command, max, got) => `${command}: 인자는 최대 ${max}개지만 ${got}개를 받았습니다`,
    colourMode: (given) => `--color=${given}: auto, always, never 중 하나만 쓸 수 있습니다`,
    twoDestinations: "--global, --here, --project PATH 중 범위 하나만 선택해 주세요.",
    projectPathRequired: "--project에는 디렉터리 경로가 필요합니다. 현재 프로젝트는 --here로 선택해 주세요.",
    scopeRequired: "질문 없이 연결을 바꾸려면 --global, --here, --project PATH 중 범위를 직접 선택해 주세요. 원하는 범위를 붙여 다시 실행하세요. --dry-run은 기본 전역 범위의 변경을 미리 보여주며 파일을 쓰지 않습니다.",
    migrationFresh: "--migrate-legacy는 지원하는 이전 상태에만 씁니다. 처음 설정한다면 이 플래그 없이 init을 실행해 주세요.",
    migrationApprovalRequired: (command) => `이전 상태를 옮기려면 직접 승인해 주세요. 변경을 미리 확인하려면 실행하세요:\n${command} --dry-run\n확인한 변경을 적용하려면 실행하세요:\n${command} --auto\n대화형 init은 옮기기 전에 승인을 묻습니다.`,
    contextInspectionFailure: (path, reason) => `검사를 끝내지 못했습니다:\n${path}\n${
      reason === "invalid-provider-json" ? "에이전트 설정이 올바른 JSON이 아니거나 지원하지 않는 훅 구조입니다. 파일을 보존하고 고친 뒤 다시 실행해 주세요."
        : reason === "invalid-legacy-region" ? "이전 지침 영역을 확인하지 못했습니다. 파일을 보존하고 ToneDial 마커를 확인한 뒤 다시 실행해 주세요."
          : "파일을 안전하게 읽지 못했습니다. 파일 종류, 링크와 접근 권한을 확인한 뒤 다시 실행해 주세요."
    }`,
    legacyMigrationBlocked: (reason, path, doctorCommand) => {
      const explanations: Record<string, string> = {
        "opaque-wiring": "schema 1의 연결 기록이 비어 있지 않습니다. 이전 경로만으로는 관리하던 파일인지 알 수 없습니다. config.json을 보존하고 연결을 직접 확인해 주세요.",
        "artifact-changed": "소문자 파일 내용이나 관리 기록이 맞지 않습니다. tone.md를 보존하고 저장된 설정과 완료된 작업 기록을 함께 확인해 주세요.",
        "seed-conflict": "기본 파일을 수정했거나 관리 기록이 없습니다. 링크나 읽을 수 없는 파일일 수도 있습니다. 파일을 보존하고 진단에 나온 내용을 확인해 주세요.",
        "config-missing": "config.json이 없습니다. 톤 파일만으로는 저장된 설정을 복구하지 못합니다. 파일을 보존하고 원래 설정부터 복구해 주세요.",
        "unverified-consumers": "이전 연결을 선택한 범위에서 안전하게 해제할 수 있는지 확인하지 못했습니다. 에이전트 파일을 보존하고 관리 기록을 확인한 뒤 연결을 해제해 주세요.",
        "retained-consumers": "선택한 도구나 범위 밖에 기록된 컨텍스트 연결이 남아 있습니다. 공통 컨텍스트를 옮기기 전에 각 범위를 직접 선택해 연결부터 해제해 주세요.",
        inspection: "파일이나 에이전트 경로를 끝까지 확인하지 못했습니다. 읽을 수 있는 일반 파일인지 확인한 뒤 진단을 다시 실행하세요. 검사가 덜 끝난 상태에서는 이전 구성을 옮기지 않습니다.",
        foreign: "관리 기록이 없는 컨텍스트 파일이거나 링크입니다. 지원하지 않는 파일 종류일 수도 있습니다. 파일을 보존하세요. 이전 상태를 옮기는 과정에서 이 파일을 덮어쓰지 않습니다.",
        "case-collision": "tone.md와 TONE.md가 함께 있습니다. 둘 다 보존하고 이름 충돌을 확인한 뒤 구성을 바꿔 주세요.",
        "unsupported-layout": "지원하는 소문자 구성이나 설정만 남은 구성이 아닙니다. 파일을 보존하고 관리 기록부터 확인해 주세요.",
        overlap: "상태 디렉터리가 에이전트 지침 경로와 겹칩니다. 별도 상태 디렉터리를 선택한 뒤 설정해 주세요.",
        operation: "복구가 필요한 작업이 있습니다. 기록된 ID로 그 작업부터 복구한 뒤 이전 상태를 옮겨 주세요.",
      };
      return `이전 상태를 옮길 수 없습니다:\n${path}\n${explanations[reason] ?? "관리 기록이나 이전 상태를 옮길 조건을 확인하지 못했습니다. 파일을 보존하고 진단 내용을 확인해 주세요."}\n아무것도 쓰지 않았습니다. 같은 범위를 확인하려면 실행하세요:\n${doctorCommand}\n원본 파일을 보존하세요. tonedial show --json으로 저장된 설정을 읽습니다. 별도 TONEDIAL_HOME을 선택하면 이후에도 같은 값을 써야 하며 이전 연결은 계속 작동할 수 있습니다.`;
    },
    npxUnsupported:
      "npx 설치는 지원하지 않습니다. 설치 사본이 남지 않아 `tonedial` 명령과 이를 호출하는 " +
      "스킬·폴백 줄이 작동하지 않습니다. 아래 방법 중 하나로 설치한 뒤 tonedial을 실행하세요:\n" +
      "  npm i -g tonedial\n" +
      "  curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh",
    languageUnsupported: (given, languages) =>
      `--lang ${given}: 지원하지 않는 인터페이스 언어입니다. 사용 가능: ${languages.join(", ")}`,
    notUtf8:
      "올바른 UTF-8 파일이 아닙니다. 다시 쓰면 ToneDial 블록 밖의 바이트까지 바뀝니다. " +
      "먼저 UTF-8로 변환해 주세요",
    couldNotWrite: (path, reason, done) =>
      `${path}: 기록 실패 · ${reason}.${done.length ? ` 이미 기록됨: ${done.join(", ")}.` : ""}`,
    staleTarget: (path) =>
      `${path}: diff를 만든 뒤 바뀌었습니다. 미리 본 변경은 적용하지 않았습니다. 다시 실행해 새 diff를 확인해 주세요`,
    seedConflict: (path) =>
      `ToneDial이 관리하는 일반 파일인지 확인하지 못했습니다:\n${path}\n` +
      "아무것도 바꾸지 않았습니다. 파일을 보존하고 새 설정에는 별도 TONEDIAL_HOME 디렉터리를 지정해 주세요.",
    toolsRequired: "--tools codex,claude,antigravity로 에이전트를 선택해 주세요.\n" +
      "상태만 준비하려면 init --tools none을 쓰세요.\n" +
      "--auto는 선택한 변경만 승인합니다. 에이전트는 직접 골라 주세요.",
    toolsSelection: "에이전트 이름을 쉼표로 구분해 입력해 주세요. none은 init에서만 단독으로 쓸 수 있습니다.",
    toolsAmbiguous: "에이전트 인자와 --tools 중 하나만 써 주세요.",
    commandsNeedClaude: "--commands를 쓰려면 에이전트 선택에 claude를 포함해 주세요.",
    toolsPrompt: "연결할 에이전트(쉼표로 구분): ",
    ownershipConflict: (path) => `관리 기록이 없거나 관리하던 내용·파일 종류가 바뀌었습니다:\n${path}\n파일을 보존했습니다. 연결을 바꾸기 전에 확인해 주세요.`,
    rollbackNeedsFix: "doctor가 보여준 작업 ID로 doctor --fix --rollback을 실행해 주세요.",
    editNotApplied: (path, reason) => `편집 내용 적용 실패: ${reason}\n편집한 사본 보존 위치:\n${path}`,
    stateOverlap: (path) => `프로젝트 내보내기 경로가 ToneDial 상태 디렉터리와 겹칩니다:\n${path}\n아무것도 쓰지 않았습니다. 별도 상태 디렉터리나 다른 프로젝트를 선택해 주세요.`,
    stateInstructionOverlap: (path) => `ToneDial 상태 디렉터리가 에이전트 지침 경로와 겹칩니다:\n${path}\n아무것도 쓰지 않았습니다. 전용 상태 디렉터리를 선택한 뒤 init을 실행해 주세요.`,
    legacyConsumers: (destinations) => `다른 연결이나 기록되지 않은 연결이 아직 tone.md를 읽습니다:\n${destinations.join("\n")}\n아무것도 쓰지 않았습니다. 각 범위에서 먼저 unwire한 뒤 init을 다시 실행하세요. 전환이 끝나면 다시 연결해 주세요.`,
    contextLayout: (kind, path, doctorCommand = "tonedial doctor --json") => kind === "fresh"
      ? `ToneDial 초기 설정이 필요합니다:\n${path}\n설정을 바꾸기 전에 tonedial init --tools none을 실행해 주세요.`
      : `이 구성은 앱 복구가 필요합니다 (${kind}):\n${path}\n아무것도 쓰지 않았습니다. 같은 범위를 확인하려면 실행하세요:\n${doctorCommand}\n이 경로를 유지하고 tonedial doctor --fix를 실행하세요. 저장된 설정을 보존하고 앱 생성 파일을 다시 준비합니다.`,
    unreadableConfigFile: (path) => `이 파일에서 올바른 설정을 읽지 못했습니다:\n${path}\n원본을 보존하고 tonedial doctor --fix에서 저장된 원본이나 안내한 기본값을 선택하세요.`,
    fixUnreadableConfig: (path) => `설정을 복구할 원본이 필요합니다:\n${path}\n아무것도 쓰지 않았습니다. 터미널에서 tonedial doctor --fix를 실행하거나 --from-operation ID 또는 --from-preset SLUG를 선택하세요.`,
    editConflict: (path) => `편집기가 열린 동안 원본 파일이 바뀌었습니다. 편집한 사본은 여기에 보존했습니다:\n${path}\n두 파일을 비교한 뒤 다시 시도해 주세요.`,
    traitsNotOnDisk:
      "편집할 트레이트 파일이 없습니다. 앵커는 패키지에 들어 있으며 홈에는 쓰지 않습니다. " +
      "축을 바꾸려면 tonedial set을 쓰세요.",
    editTarget: (given) => `edit은 preset <slug>만 받거나 인자 없이 실행합니다(입력: ${given})`,
    editorChangedNothingUsable: (path) => `${path}: 프리셋 객체가 아닙니다`,
    editNeedsSlug: "edit preset에는 슬러그가 필요합니다. 목록: tonedial list",
    noEditor: (path) => `$EDITOR나 $VISUAL을 설정하거나 직접 여세요: ${path}`,
    wouldOpen: (editor, path) => `열기 예정 · ${editor} · ${path}`,
    editorFailed: (editor, reason) => `${editor}: 실행 실패 · ${reason}`,
    editorExited: (editor, code) => `${editor}: 종료 코드 ${code} · 변경 내용은 다시 읽지 않음`,
    editUnchanged: "변경 없음",
    editDeleted: (path) => `${path}: 삭제됨 · 복구: tonedial doctor --fix`,
    editDeletionRefused: (path) => `편집기에서 임시 설정 파일을 삭제해 변경을 적용하지 않았습니다. 기존 설정과 연결 기록은 그대로입니다:\n${path}`,
    escapesRoot: (path, real, root) =>
      `${path} → ${real}: ${root} 밖이므로 기록하지 않습니다.`,
    unreadableTarget: (path, reason) => `${path}: 읽을 수 없습니다: ${reason}`,
    markerInArtifact: (marker) =>
      `컴파일된 아티팩트에서 ToneDial 마커를 찾았습니다: ${marker}. 페르소나 노트나 ` +
      `세이프워드에서 지워 주세요. 그대로 연결하면 파일이 깨집니다`,
    projectNeedsWiring: "--project에는 연결 기능이 필요합니다",
    hooksNotJson: (path, reason) =>
      `${path}: JSON으로 읽을 수 없습니다${reason ? `: ${reason}` : ""}. 다른 훅을 보존하기 위해 ` +
      `ToneDial은 덮어쓰지 않습니다. 파일을 고친 뒤 다시 실행해 주세요`,
  },
  config: {
    unknownKey: (key, known) => `config.json: 알 수 없는 키 ${key} · 사용 가능: ${known.join(", ")}`,
    rootNotAnObject: "config.json: 객체가 아닙니다",
    notAnObject: (field) => `config.json ${field}: 객체가 아닙니다`,
    notABoolean: (field) => `config.json ${field}: true 또는 false가 아닙니다`,
    notAString: (field) => `config.json ${field}: 문자열이 아닙니다`,
    futureSchema: (found, known) =>
      `config.json: 스키마 ${found} · 지원 스키마 ${known}. 추측해서 읽지 말고 ToneDial을 업그레이드해 주세요`,
    unreadable: (reason) => `config.json을 읽을 수 없습니다: ${reason}`,
    safewordQuote: "세이프워드에는 큰따옴표를 쓸 수 없습니다. tone.md의 문장이 중간에서 끝납니다",
    safewordBlank: "세이프워드가 비어 있습니다. 설정하지 않으려면 null을 쓰세요",
    wiringLost:
      "연결 기록이 달라졌거나 확인할 수 없어 변경을 적용하지 않았습니다. 기존 설정은 그대로입니다. " +
      "연결을 해제하려면 범위를 지정해 unwire/eject를 실행하세요. 이전 설정 변환과 복구에는 init/doctor --fix를 쓰세요.",
    importNeedsPath: "import에는 프리셋 JSON 파일 경로나 https URL이 필요합니다",
    remoteSource: "원격 출처",
    invalidUrl: "원격 URL이 올바르지 않습니다.",
    transportFailed: "네트워크 또는 시간 초과 오류",
    connectionUnverified: "보안 연결을 확인할 수 없음",
    insecureUrl: (url) => `${url}: https가 아닙니다. 저장할 프리셋은 https로만 가져옵니다`,
    redirectedInsecure: (url) => `리디렉션 대상이 https가 아닙니다: ${url}`,
    tooLarge: (cap) => `프리셋 크기가 ${cap}바이트를 넘습니다`,
    notUtf8Body: "응답이 UTF-8 텍스트가 아니므로 프리셋으로 읽을 수 없습니다",
    fetchFailed: (url, reason) => `${url}: 다운로드 실패 · ${reason}`,
    fetchedFrom: (url) => `출처 ${url}`,
  },
};

const ko: Catalogue = {
  init: {
    safewordSuggestion: (suggestion) => `프리셋 제안 · ${suggestion}`,
    welcome: "ToneDial은 코딩 에이전트의 말투를 정하고 모든 프로젝트에서 유지합니다.",
    scopeHeading: "범위",
    toneHeading: "말투",
    connectionsHeading: "에이전트",
    resultHeading: "준비 완료",
    preset: "시작 프리셋 (Enter: 1)",
    userRef: '내 호칭 (Enter: 프리셋 기본값 · "": 지우기)',
    selfRef: '에이전트 호칭 (Enter: 프리셋 기본값 · "": 지우기)',
    safeword:
      "세이프워드: 한 답변만 페르소나·칭찬·농담 없이 담백하게 요청합니다. 권한은 바꾸지 않습니다.",
    safewordSkip: "Enter: 없음 · 스킬로도 담백한 답을 요청할 수 있습니다.",
    done: "초기 설정 완료",
    installHint:
      "tonedial 명령을 찾지 못했습니다. 전역 설치:\nnpm i -g tonedial",
    tools: "에이전트 번호: 1,2,3 · Enter: 연결 안 함",
    // No particle touches the preset slug or the tool list. `을/를` and `이라고/라고` agree with
    // the final consonant of the word before them, and these are arbitrary text — a slug, a
    // comma-joined list — so the agreement cannot be computed and was simply wrong half the time.
    autoChose: (preset, tools) => tools === null
      ? `프리셋 ${preset} · 에이전트 연결 없음`
      : `프리셋 ${preset} · 연결 ${tools}`,
    risk: koMessages.notice.riskIntro,
  },
  presets: {
    "caring-brother": "동생의 고민을 다정하게 챙기는 든든한 형입니다.",
    "bratty-kid": "말대꾸와 농담을 섞는 잘난 척하는 꼬마입니다.",
    "eager-sycophant": "창작자의 작은 선택에도 환호하는 과몰입한 팬입니다.",
    "royal-advisor": "사용자는 왕, 에이전트는 예를 갖춰 보고하고 간언하는 신하입니다.",
    "ego-sword": "초보 주인을 얕보면서도 함께 살아남으려 잔소리하는 검입니다.",
    "heavenly-demon": "사용자는 제자, 에이전트는 매섭게 가르치는 천마입니다.",
    "right-hand": "사용자는 보스, 에이전트는 조직의 은어로 보고하는 충직한 오른팔입니다.",
  },
  axisHints: {
    formality: { owns: "표현의 격식·거리감", low: "익숙한 말투와 속어", high: "의례적이고 공손한 표현" },
    verbosity: { owns: "답변 분량과 설명의 깊이", low: "간단한 결과는 짧은 한 문장", high: "요청 범위 안에서 깊이 있게 설명" },
    profanity: { owns: "욕설만: 강도·빈도", low: "욕설 없음·역할 속어 유지", high: "거의 모든 문장에 순화 없는 강한 욕설" },
    playfulness: { owns: "농담·역할 표현의 강도·빈도", low: "담백한 표현·설정한 호칭 유지", high: "거의 모든 문장에 과장된 역할 표현" },
    critique: { owns: "결함·선택을 비판하는 강도", low: "판단 없이 문제를 중립적으로 설명", high: "심각한 결함과 선택을 가차 없이 비난하고 조롱" },
    flattery: { owns: "칭찬의 양과 강도", low: "칭찬 없음", high: "문단마다 아낌없이 칭찬·기술 판단 유지" },
    warmth: { owns: "사용자에게 보이는 다정함", low: "인사·감정 표현·격려 없음", high: "문단마다 다정함·공감·위로·안심" },
    conviction: { owns: "자기 판단을 밀어붙이는 정도", low: "선택지를 나열하고 물어봄", high: "추천 하나를 결정으로 말하고 되묻지 않음" },
    care: { owns: "범위·정리·기능적 표시", low: "요청한 작업만", high: "후속·백업·휴식·목록·표·상태 이모지" },
    compliance: { owns: "거절로 미루지 않을 때의 실행 의지", low: "반대 이유를 밝힌 뒤 실행", high: "기꺼이 즉시 시작·지연이나 협상 없음" },
    refusal: { owns: "거절 빈도·조건", low: "거절·지연 없음", high: "달랠 때까지 파업·세이프워드는 한 답변만 해제" },
    bravado: { owns: "수고 과장·공치사의 정도", low: "과장 없음", high: "답변마다 허풍·공치사·수고 과장·페르소나 유지" },
  },
  settingHints: {
    safeword: "한 메시지만 담백하게 답해 달라는 요청 문구",
    speech_level: "auto: 관계에 맞게 선택 · polite: 존댓말 · plain: 일반 반말 · rough: 짧고 퉁명스러운 반말 어미·자체로 농담·욕설·비판·조롱은 추가하지 않음 · 표현의 격식과 거리감은 formality로 조절",
    language: "CLI 인터페이스 언어 · 에이전트 답변 언어와 무관",
    "persona.age": "모델이 연상할 나이대",
    "persona.gender": "모델이 연상할 성별",
    "persona.self_ref": "에이전트의 자칭",
    "persona.user_ref": "에이전트가 쓰는 사용자 호칭",
    "persona.note": "축으로 표현할 수 없는 역할이나 말투",
    "persona.user": "사용자 배경 설명 · 최대 200자",
    "persona.agent": "가상 에이전트 역할 · 최대 200자 · 경력은 확인하지 않으며 능력·권한을 부여하지 않음",
  },
  cli: koMessages,
  safewords: {
    "caring-brother": "그냥 사실대로 말해줘",
    "bratty-kid": "진심으로 부탁할게",
    "eager-sycophant": "칭찬은 됐어",
    "royal-advisor": "신하야, 평범하게 말해라",
    "ego-sword": "검아, 잔소리는 됐어",
    "heavenly-demon": "스승님, 평범하게 설명해 주세요",
    "right-hand": "은어 빼고 보고해",
  },
};

const CATALOGUES: Record<Language, Catalogue> = { en, ko, ja, zh, es };

export function catalogue(language: Language): Catalogue {
  return CATALOGUES[language];
}

/**
 * The interface language to offer first, read from the environment the way every POSIX tool
 * does. It is offered rather than applied: `init` takes a choice, because a machine's locale
 * and the language someone wants their tools in are different questions.
 *
 * An unsupported locale falls back to `en` here and is never an error — `--lang` is the path
 * that aborts on an unsupported value, because that one is a person stating an intent.
 */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const raw = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  const tag = raw.split(/[._@]/)[0]?.toLowerCase().replace("_", "-") ?? "";
  const base = tag.split("-")[0] ?? "";
  return isLanguage(base) ? base : "en";
}

/**
 * The language this invocation speaks, from the config if it can be read and from the locale if
 * it cannot.
 *
 * Deliberately tolerant. A config too broken to parse still has to produce an error message, and
 * that message should be in the language the machine is set to rather than in English because
 * the file that names the language is the file that is broken.
 */
export function messages(configPath: string, env: NodeJS.ProcessEnv = process.env): Messages {
  return catalogue(configLanguage(configPath) ?? detectLanguage(env)).cli;
}

export function configLanguage(configPath: string): Language | null {
  const raw = bootstrapConfig(configPath);
  return raw !== null && typeof raw.language === "string" && isLanguage(raw.language) ? raw.language : null;
}

/**
 * The guarded language-bootstrap read, returning the parsed object or null.
 *
 * Every check here is about the file still being the same file it was a syscall ago, which is
 * why the read is not a `readFileSync` — this runs against a directory the user may be editing
 * and a path that may be a symlink to somewhere else entirely.
 */
function bootstrapConfig(configPath: string): Record<string, unknown> | null {
  let descriptor: number | undefined;
  try {
    // Locale selection runs before diagnostics and supplies their error catalogue. Keep this
    // bootstrap read local rather than importing the planner that depends on that catalogue.
    const entry = lstatSync(configPath, { bigint: true, throwIfNoEntry: false });
    const limit = 256 * 1024;
    if (!entry?.isFile() || entry.size > BigInt(limit)) return null;
    const parent = dirname(configPath);
    const realParent = realpathSync(parent);
    const parentBefore = statSync(parent, { bigint: true });
    const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino &&
      left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    const parentStable = () => realpathSync(parent) === realParent && same(parentBefore, statSync(parent, { bigint: true }));
    if (!parentStable()) return null;
    descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(limit) || !same(entry, opened) || !parentStable()) return null;
    const storage = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < storage.length) {
      const count = readSync(descriptor, storage, length, storage.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) return null;
    const bytes = storage.subarray(0, length);
    const named = lstatSync(configPath, { bigint: true, throwIfNoEntry: false });
    if (!named?.isFile() || !same(opened, named) || !same(opened, fstatSync(descriptor, { bigint: true })) || !parentStable()) return null;
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    // `JSON.parse` answers with whatever the file holds, and `null` is valid JSON. Only an
    // object has fields to read.
    return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
  } catch {
    // Choosing the environment locale is not a successful config diagnosis. The command's
    // normal config inspection still reports the unsafe or malformed entry without repairing it.
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* A close failure must not block the diagnostic bootstrap. */ }
    }
  }
}
