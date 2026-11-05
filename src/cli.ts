// Argument parsing, dispatch, and human/JSON output.

import { parseArgs } from "node:util";

import { ConfigError, OwnershipConflict, SETTING_KEYS, isConfigV2, nearest } from "./core/config.ts";
import { AXIS_ORDER } from "./core/anchors.ts";
import { compile } from "./core/compile.ts";
import { toCompileInput } from "./core/resolve.ts";
import { inspectContextLayout } from "./core/seeds.ts";
import { OperationError, inspectOperations } from "./core/operations.ts";
import { RegionError } from "./wiring/region.ts";
import { connectionScopeFlag, installShape, resolveAgentPaths, resolvePaths, shellQuote, type AgentPaths } from "./core/paths.ts";
import { catalogue, configLanguage, detectLanguage, messages, type Catalogue, type Messages } from "./core/i18n.ts";
import { isColourMode, palette, type Palette } from "./ui/style.ts";
import { cells, maxCells, resolveBudget, wrap } from "./ui/width.ts";
import { interactive } from "./ui/prompt.ts";
import { humanText, isCopyableLine, isRiskNotice, nextStep, riskNotice } from "./ui/format.ts";
import { ApprovalRequired, type Change } from "./wiring/apply.ts";
import { ScopeRequired, projectIsHome } from "./wiring/scopes.ts";

import { planConfig, runCompile } from "./commands/compile.ts";
import { runExport, runImport } from "./commands/transfer.ts";
import { runList } from "./commands/list.ts";
import { runEdit } from "./commands/edit.ts";
import { runUpdate } from "./commands/update.ts";
import { runSave } from "./commands/save.ts";
import { runCreate } from "./commands/create.ts";
import { runAddress, runPersona, runSet, runReset } from "./commands/set.ts";
import { runShow } from "./commands/show.ts";
import { runGet, settingHelp } from "./commands/get.ts";
import { runUse } from "./commands/use.ts";
import { runDoctor } from "./commands/doctor.ts";
import { recoveryPendingError } from "./commands/rebuild.ts";
import { runEject } from "./commands/eject.ts";
import { runInit } from "./commands/init.ts";
import { runUnwire, runWire } from "./commands/wire.ts";
import { runTest } from "./commands/test.ts";
import { runOff, runOn } from "./commands/toggle.ts";

export const JSON_SCHEMA = 3;

/**
 * Stated here rather than read from `package.json`, because reading a package-relative file at
 * run time is the one thing that breaks all three binary packagers at once. A test asserts this
 * equals the manifest, which is the cheap half of the trade.
 */
export const VERSION = "0.1.13";

/** Command flags are declared centrally and parsed strictly, so a typo fails rather than
 *  being silently dropped — which is what a permissive parse did to `--project`. */
// `--json`, `--help`, `--version`, `--verbose`, and `--color` are deliberately absent: how output is
// painted or shaped is not a property of which command produced it, so they are not in any
// command's allowlist and every command takes them.
export type Flags = {
  /** Expand human-readable help, diagnostics, and approval previews. Never changes JSON. */
  verbose: boolean;
  project: string | null;
  check: boolean;
  explain: boolean;
  /** Explicit global selection. The effective connection default is resolved separately. */
  global: boolean;
  /** Explicitly select the current project; connection commands otherwise default global. */
  here?: boolean;
  /** Init only: approve the narrowly validated older-state migration. */
  migrateLegacy?: boolean;
  /** Skip the approval question. Never the diff. */
  auto: boolean;
  /** Show the diff and write nothing at all. */
  dryRun: boolean;
  /** On doctor: repair what it found, through the same approval gate. */
  fix: boolean;
  /** On doctor --fix: explicitly select one recorded operation to restore. */
  rollback: string | null;
  /** On doctor --fix: preserve one unreadable operation record and unblock recovery. */
  quarantineOperation?: string | null;
  fromOperation?: string | null;
  fromPreset?: string | null;
  restorePreset?: string | null;
  /** Test only: preview preset axes without changing saved settings. */
  preset?: string | null;
  /** Create/save: choose a slug independently of the display name. */
  slug?: string | null;
  /** Test only: accept account usage for this invocation. */
  acceptUsage?: boolean;
  /** On init: the interface language, stated rather than detected. */
  lang: string | null;
  /** On init: also install the Claude Code /tone command. Off by default. */
  commands: boolean;
  /** Explicit native setup selection; `none` is state-only init. */
  tools: string | null;
};

const FLAG_NAMES = ["project", "check", "explain", "global", "here", "migrateLegacy", "auto", "dryRun", "fix", "rollback", "quarantineOperation", "fromOperation", "fromPreset", "restorePreset", "preset", "slug", "acceptUsage", "lang", "commands", "tools"] as const;

/** Command-line spelling for each flag, where it differs from the field name. */
const FLAG_SPELLING: Record<(typeof FLAG_NAMES)[number], string> = {
  project: "project", check: "check", explain: "explain",
  global: "global", auto: "auto", dryRun: "dry-run", fix: "fix", lang: "lang", commands: "commands",
  tools: "tools", rollback: "rollback", here: "here", migrateLegacy: "migrate-legacy",
  quarantineOperation: "quarantine-operation",
  fromOperation: "from-operation", fromPreset: "from-preset", restorePreset: "restore-preset",
  preset: "preset", slug: "slug", acceptUsage: "accept-usage",
};

/** What a command returns: lines a person reads, and the object a program reads. */
export type CommandResult = {
  lines: string[];
  json: Record<string, unknown>;
  /** Non-blocking notices about tone combinations and persona settings. */
  warnings?: string[];
  /** A dry run that found changes to make; the output ends with the command that makes them. */
  previewed?: boolean;
  /**
   * Something to do once the receipt is on screen, and only then.
   *
   * It exists for a handoff: `init` can offer to open Codex or Claude Code so a hook it just wrote
   * can be trusted there, and the host takes the terminal the moment it starts. Anything still unprinted
   * would be lost behind it, and a setup that half-printed and then gave the screen away is not
   * a finished setup. It never runs under `--json`, where the payload is the whole answer and
   * nobody is watching a terminal.
   * A fresh test conversation uses the same handoff and may return the native exit status.
   */
  after?: () => Promise<void | number>;
};

export type Ctx = {
  paths: ReturnType<typeof resolvePaths>;
  cwd: string;
  flags: Flags;
  /** Resolved once per invocation. Every command paints through it, so `NO_COLOR` and a
   *  non-TTY pipe are one decision rather than a check repeated at nine call sites. */
  ui: Palette;
  /** Effective wiring destination; flags retain explicit intent separately from the default. */
  agent: AgentPaths;
  /** The process environment this invocation resolved everything from. */
  env: NodeJS.ProcessEnv;
  /** What this invocation says, in the language the config names. Resolved once, like `ui`. */
  t: Messages;
  /** The parsed output mode, also needed when a command hands stdio to an external editor. */
  asJson: boolean;
  /** JSON and non-terminal calls never ask questions. */
  canPrompt: boolean;
  /** User intent, distinct from the effective global default and an isolation override. */
  scopeExplicit?: boolean;
  /** This invocation as a command to rerun, offered when approval was needed and nobody could give it. */
  rerun?: string;
  /** Read-only context evidence revalidated with the command's eventual writes. */
  contextChecks?: readonly Change[];
};

/** Each command declares its accepted flags and positional limit; null means unlimited. */
const COMMANDS: Record<
  string,
  { run: (ctx: Ctx, args: string[]) => CommandResult | Promise<CommandResult>; flags: (keyof Flags)[]; max: number | null; context?: "state" | "setup" }
> = {
  on: { run: runOn, flags: [], max: 0, context: "state" },
  off: { run: runOff, flags: [], max: 0, context: "state" },
  set: { run: runSet, flags: [], max: null, context: "state" },
  get: { run: runGet, flags: [], max: 1 },
  test: { run: runTest, flags: ["project", "dryRun", "preset", "acceptUsage"], max: 1 },
  address: { run: runAddress, flags: [], max: 2, context: "state" },
  persona: { run: runPersona, flags: [], max: 2, context: "state" },
  reset: { run: runReset, flags: [], max: 1, context: "state" },
  show: { run: runShow, flags: ["explain"], max: 1 },
  create: { run: runCreate, flags: ["slug", "auto", "dryRun"], max: null, context: "state" },
  save: { run: runSave, flags: ["slug"], max: null, context: "state" },
  list: { run: runList, flags: [], max: 0 },
  edit: { run: runEdit, flags: ["dryRun"], max: 2, context: "state" },
  update: { run: runUpdate, flags: ["global", "auto", "dryRun"], max: 0 },
  use: { run: runUse, flags: ["project"], max: 1, context: "state" },
  compile: { run: runCompile, flags: ["check"], max: 0, context: "state" },
  export: { run: runExport, flags: [], max: 1 },
  import: { run: runImport, flags: [], max: 1, context: "state" },
  wire: { run: runWire, flags: ["global", "here", "project", "auto", "dryRun", "tools"], max: 1, context: "state" },
  unwire: { run: runUnwire, flags: ["global", "here", "project", "auto", "dryRun"], max: 1 },
  init: { run: runInit, flags: ["global", "here", "project", "migrateLegacy", "auto", "dryRun", "lang", "commands", "tools"], max: 0, context: "setup" },
  // Doctor checks mutation permission after its recovery-first diagnosis, even with bad config.
  doctor: { run: runDoctor, flags: ["global", "here", "project", "auto", "dryRun", "fix", "rollback", "quarantineOperation", "fromOperation", "fromPreset", "restorePreset", "tools"], max: 0 },
  eject: { run: runEject, flags: ["global", "here", "project", "auto", "dryRun"], max: 0 },
};

const CONNECTION_COMMANDS = ["init", "wire", "doctor", "unwire", "eject"];
/** Commands that present a plan or ask for approval carry a title; short receipts start with their result. */
const TITLED_COMMANDS = [...CONNECTION_COMMANDS, "update", "create", "save", "import", "edit", "test"];

/**
 * Every command this CLI dispatches. Exported so the help screen can be held to covering them:
 * the list is grouped now, and a group is a place a command can be left out of.
 */
export const COMMAND_NAMES = Object.keys(COMMANDS) as readonly string[];

/**
 * The left column is command syntax a user types, so it is a literal here and stays English.
 * The right column is prose and comes from the catalogue.
 */
type CommandRow = [keyof Messages["help"]["commands"], string];

/** Intent groups share one command inventory between compact and full help. */
const COMMAND_GROUPS: [keyof Messages["help"]["groups"], CommandRow[]][] = [
  // Most-used first. ASCII "..." because U+2026 is East Asian Ambiguous: padded as two cells,
  // it drew one cell short of the column in a Latin terminal.
  ["tone", [
    ["set", "set <key>=<value>..."],
    ["show", "show [slug]"],
    ["get", "get [key]"],
    ["reset", "reset [axis]"],
    ["address", "address [self user]"],
    ["persona", "persona [agent user]"],
    ["test", "test [claude|codex]"],
    ["off", "off"],
    ["on", "on"],
  ]],
  ["presets", [
    ["list", "list"],
    ["use", "use <slug>"],
    ["create", "create [name] ..."],
    ["save", "save [display name]"],
    ["export", "export <slug>"],
    ["import", "import <file>"],
    ["edit", "edit [preset <slug>]"],
  ]],
  ["agents", [
    ["init", "init"],
    ["wire", "wire [tool]"],
    ["unwire", "unwire [tool]"],
    ["doctor", "doctor"],
    ["eject", "eject"],
  ]],
  ["upkeep", [
    ["compile", "compile"],
    ["update", "update"],
  ]],
];

const COMMAND_SYNTAX: CommandRow[] = COMMAND_GROUPS.flatMap(([, rows]) => rows);

const COMMAND_EXAMPLES: Record<keyof Messages["help"]["commands"], readonly string[]> = {
  on: ["tonedial on"],
  off: ["tonedial off"],
  set: ["tonedial set", "tonedial set warmth=5 critique=4", "tonedial set persona.agent=reviewer", "tonedial set address_frequency=rarely"],
  get: ["tonedial get", "tonedial get language", "tonedial get speech_level --json", "tonedial get address_frequency"],
  test: ["tonedial test codex --dry-run", "tonedial test claude --project .", "tonedial test codex --preset my-tone --accept-usage"],
  address: ['tonedial address "assistant" "friend"', "tonedial set address_frequency=rarely"],
  persona: ["tonedial persona", 'tonedial persona "Fictional reviewer" "Developer"'],
  reset: ["tonedial reset", "tonedial reset warmth"],
  show: ["tonedial show", "tonedial show --explain"],
  create: ["tonedial create", "tonedial create Jarvis address_frequency=rarely --auto"],
  save: ["tonedial save", 'tonedial save "My Tone"'],
  list: ["tonedial list"],
  edit: ["tonedial edit", "tonedial edit preset my-tone"],
  update: ["tonedial update --dry-run"],
  use: ["tonedial use caring-brother"],
  compile: ["tonedial compile --check"],
  export: ["tonedial export caring-brother > caring-brother.json"],
  import: ["tonedial import ./caring-brother.json"],
  wire: ["tonedial wire codex --here --dry-run"],
  unwire: ["tonedial unwire codex --here --dry-run"],
  init: ["tonedial init --tools none --global --auto", "tonedial init --tools codex --here"],
  doctor: ["tonedial doctor", "tonedial doctor --fix --global --tools none --dry-run",
    "tonedial doctor --fix --quarantine-operation ID --global"],
  eject: ["tonedial eject --here --dry-run"],
};

const FLAG_SYNTAX: [keyof Messages["help"]["flags"], string][] = [
  ["global", "--global"],
  ["here", "--here"],
  ["project", "--project=DIR"],
  ["migrateLegacy", "--migrate-legacy"],
  ["auto", "--auto"],
  ["dryRun", "--dry-run"],
  ["lang", "--lang=CODE"],
  ["commands", "--commands"],
  ["tools", "--tools=LIST"],
  ["fix", "--fix"],
  ["rollback", "--rollback=ID"],
  ["quarantineOperation", "--quarantine-operation=ID"],
  ["fromOperation", "--from-operation=ID"],
  ["fromPreset", "--from-preset=SLUG"],
  ["restorePreset", "--restore-preset=SLUG"],
  ["preset", "--preset=SLUG"],
  ["slug", "--slug=SLUG"],
  ["acceptUsage", "--accept-usage"],
  ["explain", "--explain"],
  ["check", "--check"],
  ["json", "--json"],
  ["verbose", "-v, --verbose"],
  ["color", "--color=MODE"],
  ["version", "--version"],
  ["help", "--help"],
];

/** Recovery-only flags: listed by `doctor --help`, summarized by one line in the full reference. */
const RECOVERY_FLAGS: readonly (keyof Messages["help"]["flags"])[] =
  ["rollback", "quarantineOperation", "fromOperation", "fromPreset", "restorePreset"];
const REFERENCE_FLAGS = FLAG_SYNTAX.filter(([key]) => !RECOVERY_FLAGS.includes(key));

/** The first commands after install: state, a preview, the dial, then an agent connection. */
const FIRST_STEPS = ["  tonedial init --tools none --global", "  tonedial test", "  tonedial set", "  tonedial wire"];

function helpRows(pairs: [string, string][], width: number, ui: Palette): string[] {
  return pairs.flatMap(([syntax, description]) => {
    // Stack before compressing descriptions into an unreadable sliver.
    if (ui.width - width - 4 < 24) {
      return [`  ${ui.accent(syntax)}`, ...wrap(description, ui.width - 4).map(line => `    ${line}`)];
    }
    const [first, ...rest] = wrap(description, ui.width - width - 4);
    const label = syntax + " ".repeat(width - maxCells(syntax));
    return [
      `  ${ui.accent(label)}  ${first ?? ""}`,
      ...rest.map((line) => `  ${" ".repeat(width)}  ${line}`),
    ];
  });
}

/**
 * Laid out at render time rather than hand-padded, because a Korean description is two cells
 * per character and a gutter counted in UTF-16 units ragged every row the moment one arrived.
 * A description that will not fit beside its syntax folds under it instead of overflowing.
 */
function expandedUsage(t: Messages, ui: Palette): string {
  const width = Math.max(
    ...COMMAND_SYNTAX.map(([, syntax]) => maxCells(syntax)),
    ...REFERENCE_FLAGS.map(([, syntax]) => maxCells(syntax)),
  );
  return [
    ...wrap(`tonedial — ${t.help.tagline}`, ui.width).map(ui.bold),
    "",
    "tonedial <command> [options]",
    "",
    ...wrap(t.help.firstSteps, ui.width),
    ...FIRST_STEPS,
    ...COMMAND_GROUPS.flatMap(([group, commands]) => [
      "",
      ui.bold(t.help.groups[group]),
      ...helpRows(commands.map(([key, syntax]) => [syntax, t.help.commands[key]]), width, ui),
    ]),
    "",
    ui.bold(t.help.groups.flags),
    ...helpRows(REFERENCE_FLAGS.map(([key, syntax]) => [syntax, t.help.flags[key]]), width, ui),
    ...wrap(t.help.recoveryOptions, ui.width - 2).map(line => `  ${line}`),
    "",
    ...wrap(t.help.footer, ui.width),
    ...wrap(t.help.commandHelp, ui.width),
    "",
    ...wrap(t.help.feedback, ui.width),
  ].join("\n");
}

/** The no-argument screen is a directory, not the manual: every command remains discoverable. */
function compactUsage(t: Messages, ui: Palette): string {
  return [
    ...wrap(`tonedial — ${t.help.tagline}`, ui.width).map(ui.bold),
    "",
    "tonedial <command> [options]",
    "",
    ...wrap(t.help.firstSteps, ui.width),
    ...FIRST_STEPS,
    "",
    ...COMMAND_GROUPS.flatMap(([group, commands]) => [
      ui.bold(t.help.groups[group]),
      ...wrap(commands.map(([key]) => key).join("  "), ui.width - 2).map(line => `  ${line}`),
    ]),
    "",
    ...wrap(t.help.commandHelp, ui.width),
    ...wrap(t.help.fullReference, ui.width),
    "",
    ...wrap(t.help.feedback, ui.width),
  ].join("\n");
}

/** One command's syntax and only the flags that can affect that command. */
function commandUsage(name: string, copy: Catalogue, ui: Palette): string {
  const t = copy.cli;
  const command = COMMANDS[name]!;
  const syntax = COMMAND_SYNTAX.find(([key]) => key === name)?.[1] ?? name;
  const flagKeys = [
    // `update --global` stays accepted from earlier releases; it never selected anything.
    ...command.flags.filter((key) => !(name === "update" && key === "global")),
    "json",
    "verbose",
    "color",
    "help",
  ] as (keyof Messages["help"]["flags"])[];
  const overrides = t.help.commandFlags[name as keyof Messages["help"]["commands"]] ?? {};
  // A shared row's `compile:` or `use:` clause names the command it applies to. Inside one
  // command's help, its own label is noise and another command's clause does not apply.
  // `doctor --fix:` stays, since it names the flag the option also needs.
  const own = (description: string) => {
    const kept = description.split(" · ").flatMap((segment) => {
      const prefix = /^([a-z]+(?:\/[a-z]+)*)[:：] ?/.exec(segment);
      const owners = prefix?.[1]!.split("/") ?? [];
      if (!prefix || !owners.every((owner) => Object.hasOwn(COMMANDS, owner))) return [segment];
      return owners.includes(name) ? [segment.slice(prefix[0].length)] : [];
    });
    return kept.length ? kept.join(" · ") : description;
  };
  const flags = flagKeys.map((key) => {
    const syntax = FLAG_SYNTAX.find(([candidate]) => candidate === key)?.[1] ?? `--${key}`;
    return [syntax, overrides[key] ?? own(t.help.flags[key])] as [string, string];
  });
  // Section headings here carry no colon, like Options and Examples.
  const heading = (text: string) => ui.bold(text.replace(/[:：]\s*$/, ""));
  const width = Math.max(...flags.map(([flag]) => maxCells(flag)));
  const keyWidth = Math.max(...[...AXIS_ORDER, ...SETTING_KEYS].map(key => maxCells(key)));
  return [
    ui.bold(`tonedial ${syntax}`),
    "",
    ...wrap(t.help.commands[name as keyof Messages["help"]["commands"]], ui.width),
    "",
    ui.bold(t.help.groups.flags),
    ...helpRows(flags, width, ui),
    "",
    ui.bold(t.help.examples),
    ...COMMAND_EXAMPLES[name as keyof Messages["help"]["commands"]].map(example => `  ${ui.accent(example)}`),
    ...(["get", "set"].includes(name) ? [
      "", heading(t.artifact.whatEachAxisObserves),
      ...helpRows(AXIS_ORDER.map(key => [key, settingHelp(key, copy).join(" · ")]), keyWidth, ui),
      "", heading(t.artifact.whatElseIsSettable),
      ...helpRows(SETTING_KEYS.map(key => [key, settingHelp(key, copy).join(" · ")]), keyWidth, ui),
    ] : []),
  ].join("\n");
}

/**
 * How wide the stream on the other end is, or undefined when there is no terminal to ask.
 *
 * A real stream bounds the view even when an exported COLUMNS is stale. A declaration remains
 * useful for pipes/test renderers that have no dimensions of their own.
 */
function columns(env: NodeJS.ProcessEnv, stream: NodeJS.WriteStream, isTTY: boolean): number | undefined {
  if (isTTY && Number.isInteger(stream.columns) && stream.columns > 0) return stream.columns;
  const declared = Number(env.COLUMNS);
  if (Number.isInteger(declared) && declared > 0) return declared;
  return isTTY ? stream.columns : undefined;
}

/**
 * Words a person reaches for when they want to stop, but which are not command spellings.
 *
 * A deliberate ceiling: the list is guessed, not measured — nobody has reported typing any of
 * them. Replace it with a measured one when a user reports a word that is not here.
 */
const STOPPING = ["disable", "stop", "quit", "uninstall", "remove", "delete"];

/** Flags people type as commands. They point to the flag rather than to a near spelling. */
const FLAG_WORDS = ["help", "version"];

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  isTTY = process.stdout.isTTY === true,
  isErrTTY = process.stderr.isTTY === true,
): Promise<number> {
  const options = {
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    version: { type: "boolean", default: false },
    color: { type: "string", default: "auto" },
    project: { type: "string" },
    check: { type: "boolean", default: false },
    explain: { type: "boolean", default: false },
    global: { type: "boolean", default: false },
    here: { type: "boolean", default: false },
    "migrate-legacy": { type: "boolean", default: false },
    auto: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    fix: { type: "boolean", default: false },
    rollback: { type: "string" },
    "quarantine-operation": { type: "string" },
    "from-operation": { type: "string" },
    "from-preset": { type: "string" },
    "restore-preset": { type: "string" },
    preset: { type: "string" },
    slug: { type: "string" },
    "accept-usage": { type: "boolean", default: false },
    lang: { type: "string" },
    commands: { type: "boolean", default: false },
    tools: { type: "string" },
  } as const;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options,
    });
  } catch (cause) {
    // `parseArgs` explains itself in terms of its own API — "place it at the end of the command
    // after '--'" is Node talking, not this tool. The flag name is the part a user can act on.
    const flag = /'(-[^']*)'/.exec((cause as Error).message)?.[1];
    // Let the same parser recognize intent despite invalid options. Its tokens distinguish
    // --json from a string option's value or a literal argument after --.
    const { tokens } = parseArgs({ args: argv, options, allowPositionals: true, strict: false, tokens: true });
    const asJson = tokens.some((token) => token.kind === "option" && token.name === "json");
    // Point to that command's own help when the first argument names one.
    const first = tokens.find((token) => token.kind === "positional")?.value;
    const command = first !== undefined && Object.hasOwn(COMMANDS, first) ? first : null;
    return fail(
      asJson,
      flag ? messages(resolvePaths(env).config, env).errors.notAnOption(asJson ? flag : humanText(flag), command) : (cause as Error).message,
      2,
      palette("never", env, false, resolveBudget(columns(env, process.stderr, isErrTTY))),
    );
  }

  const asJson = parsed.values.json === true;
  const [name, ...rest] = parsed.positionals as string[];

  // Resolved before the mode is validated, so the message about a bad `--color` is itself
  // painted the way the rest of this invocation would have been.
  const configPath = resolvePaths(env).config;
  const copy = catalogue(configLanguage(configPath) ?? detectLanguage(env));
  const say = copy.cli;
  const colour = String(parsed.values.color);
  const mode = isColourMode(colour) ? colour : "auto";
  // The line budget is settled here beside the colour, because it is the same kind of decision:
  // a terminal fact this invocation reads once and every renderer then paints through.
  const ui = palette(asJson ? "never" : mode, env, isTTY, resolveBudget(columns(env, process.stdout, isTTY)));
  // stderr is resolved separately. One palette for both means `tonedial show 2> err.txt` from a
  // terminal writes escapes into the file, and `tonedial show > out.txt` strips colour from
  // warnings that are still going to the terminal — each stream has its own answer. The width
  // splits for the same reason: a warning going to a terminal while stdout is a pipe should be
  // laid out for the terminal it is actually going to.
  const uiErr = palette(mode, env, isErrTTY, resolveBudget(columns(env, process.stderr, isErrTTY)));
  if (!isColourMode(colour)) {
    return fail(asJson, say.errors.colourMode(asJson ? colour : humanText(colour)), 2, uiErr);
  }

  if (parsed.values.version === true) {
    const payload = { version: VERSION, node: process.versions.node, schema: JSON_SCHEMA };
    process.stdout.write(
      asJson
        ? `${JSON.stringify({ ...payload, ok: true, warnings: [] }, null, 2)}\n`
        : parsed.values.verbose === true
          ? `tonedial ${payload.version} · node ${payload.node} · --json schema ${payload.schema}\n`
          : `tonedial ${payload.version}\n`,
    );
    return 0;
  }

  // `TONE.md` compiles a line telling the agent to run `tonedial --help`, so it succeeds.
  if (!name) {
    const help = parsed.values.help || parsed.values.verbose === true ? expandedUsage(say, ui) : compactUsage(say, ui);
    process.stdout.write(`${help}\n`);
    return 0;
  }
  if (parsed.values.help) {
    if (!Object.hasOwn(COMMANDS, name)) {
      return fail(asJson, say.errors.notACommand(asJson ? name : humanText(name), nearest(name, COMMAND_NAMES)), 2, uiErr);
    }
    process.stdout.write(`${commandUsage(name, copy, ui)}\n`);
    return 0;
  }

  // npx supplies no durable bare command for generated controls. Help and version stay available.
  if (installShape(resolvePaths(env), undefined, env) === "npx") {
    return fail(asJson, say.errors.npxUnsupported, 2, uiErr);
  }

  // `Object.hasOwn`, not a truthiness check on the lookup: `COMMANDS` is an object literal, so
  // `COMMANDS["toString"]` resolves to `Object.prototype.toString` and `tonedial toString` went
  // past this guard and died on `command.flags` with a raw stack trace.
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    // The intent table is consulted before the spelling match, and a word in it never reaches
    // one: `stop` is two edits from `show` and `delete` three from `reset`, so the match would
    // answer a person trying to leave with the command they were leaving.
    if (STOPPING.includes(name)) return fail(asJson, say.errors.stoppingHelp, 2, uiErr);
    if (FLAG_WORDS.includes(name)) {
      // `help doctor` asks for `doctor --help`; `version` takes no command.
      const about = name === "help" && rest[0] !== undefined && Object.hasOwn(COMMANDS, rest[0]) ? rest[0] : null;
      return fail(asJson, say.errors.isAFlag(name, about), 2, uiErr);
    }
    return fail(asJson, say.errors.notACommand(asJson ? name : humanText(name), nearest(name, COMMAND_NAMES)), 2, uiErr);
  }

  const flags: Flags = {
    verbose: parsed.values.verbose === true,
    project: typeof parsed.values.project === "string" ? parsed.values.project : null,
    check: parsed.values.check === true,
    explain: parsed.values.explain === true,
    global: parsed.values.global === true,
    here: parsed.values.here === true,
    migrateLegacy: parsed.values["migrate-legacy"] === true,
    auto: parsed.values.auto === true,
    dryRun: parsed.values["dry-run"] === true,
    fix: parsed.values.fix === true,
    rollback: typeof parsed.values.rollback === "string" ? parsed.values.rollback : null,
    quarantineOperation: typeof parsed.values["quarantine-operation"] === "string" ? parsed.values["quarantine-operation"] : null,
    fromOperation: typeof parsed.values["from-operation"] === "string" ? parsed.values["from-operation"] : null,
    fromPreset: typeof parsed.values["from-preset"] === "string" ? parsed.values["from-preset"] : null,
    restorePreset: typeof parsed.values["restore-preset"] === "string" ? parsed.values["restore-preset"] : null,
    preset: typeof parsed.values.preset === "string" ? parsed.values.preset : null,
    slug: typeof parsed.values.slug === "string" ? parsed.values.slug : null,
    acceptUsage: parsed.values["accept-usage"] === true,
    lang: typeof parsed.values.lang === "string" ? parsed.values.lang : null,
    commands: parsed.values.commands === true,
    tools: typeof parsed.values.tools === "string" ? parsed.values.tools : null,
  };
  for (const flag of FLAG_NAMES) {
    if (flags[flag] !== undefined && flags[flag] !== false && flags[flag] !== null && !command.flags.includes(flag)) {
      return fail(asJson, say.errors.flagNotAccepted(name, FLAG_SPELLING[flag]), 2, uiErr);
    }
  }
  // Two destination flags name two destinations, and `resolveAgentPaths` would silently keep the
  // home. For `eject` that is not cosmetic — it changes which files come out.
  if (Number(flags.global) + Number(flags.here === true) + Number(flags.project !== null) > 1) {
    return fail(asJson, say.errors.twoDestinations, 2, uiErr);
  }
  if (flags.project !== null && flags.project.trim() === "") {
    return fail(asJson, say.errors.projectPathRequired, 2, uiErr);
  }
  if (command.max !== null && rest.length > command.max) {
    return fail(asJson, say.errors.tooManyArguments(name, command.max, rest.length), 2, uiErr);
  }
  if (name === "doctor" && (
    (!flags.fix && (flags.quarantineOperation !== null || flags.fromOperation !== null || flags.fromPreset !== null || flags.restorePreset !== null || flags.tools !== null)) ||
    (flags.restorePreset !== null && flags.fromOperation === null) ||
    (flags.rollback !== null && (flags.quarantineOperation !== null || flags.fromOperation !== null || flags.fromPreset !== null || flags.restorePreset !== null || flags.tools !== null))
  )) {
    return fail(asJson, say.recovery.invalidOptions, 2, uiErr);
  }

  // Once resolved, the invocation names what an ownership or approval refusal ends with.
  let ctx: Ctx | null = null;
  try {
    const connection = CONNECTION_COMMANDS.includes(name);
    const scopeExplicit = flags.global || flags.here === true || flags.project !== null;
    const agent = resolveAgentPaths({ ...flags, global: flags.global || (connection && !scopeExplicit) }, env, cwd);
    const paths = resolvePaths(env);
    const t = messages(paths.config, env);
    ctx = { paths, cwd, flags, ui, agent, env, t, asJson, canPrompt: !asJson && interactive(), scopeExplicit,
      rerun: rerunCommand(name, rest, flags, connection && flags.rollback === null ? connectionScopeFlag(agent, cwd) : null) };
    // Init and doctor own recovery-first diagnosis before enforcing ordinary write intent.
    if (connection && name !== "doctor" && name !== "init" && flags.auto && !flags.dryRun && !scopeExplicit) {
      throw new ScopeRequired(t);
    }
    const scopeLabel = name === "doctor"
      ? (agent.live ? t.doctor.scopeGlobal : t.doctor.scope)
      : (agent.live ? t.wiring.scopeGlobal : t.wiring.scopeHere);
    const introduction = connection && name !== "init" && flags.rollback === null && !asJson
      ? [`  ${scopeLabel}`, `  ${humanText(agent.root)}`] : [];
    const contextExempt = name === "compile" && flags.check;
    if (command.context !== undefined && command.context !== "setup" && !contextExempt) {
      const { change, config } = planConfig(ctx);
      const layout = inspectContextLayout(paths, change, t, {
        config: change.before === null ? null : config,
        expectedArtifact: compile(toCompileInput(config)),
        instructionRoots: [agent.root, cwd, ...(env.HOME ? [env.HOME] : []),
          ...(isConfigV2(config) ? Object.values(config.wiring.registrations).map(registration => registration.destination) : [])],
      });
      if (layout.cause === "overlap") throw new ConfigError(t.errors.stateInstructionOverlap(paths.root));
      // The steps name the scope a plain `doctor` from here inspects: the command's own, or global.
      if (layout.cause === "operation") throw recoveryPendingError(paths, t,
        connectionScopeFlag(connection ? agent : resolveAgentPaths({ global: true, project: null }, env, cwd), cwd));
      if (layout.kind === "legacy" || layout.kind === "conflict" ||
          layout.kind === "fresh") {
        throw new ConfigError(t.errors.contextLayout(layout.kind, paths.root, `tonedial doctor ${connectionScopeFlag(agent, cwd)} --json`));
      }
      ctx.contextChecks = layout.checks;
    }
    // Disconnecting reads no settings, so it skips the gate above, but a held operation lock still
    // refuses its write. Say so now, with the commands for it, rather than after a preview.
    if ((name === "unwire" || name === "eject") && inspectOperations(paths).lock.state !== "none") {
      throw recoveryPendingError(paths, t, connectionScopeFlag(agent, cwd));
    }
    // The title and scope precede the command's first output, so a refusal on stderr has neither.
    // The dial draws its own live title; the receipt after it gets this one. `show` titles itself.
    const dial = name === "set" && rest.length === 0;
    const header = [...(!asJson && (TITLED_COMMANDS.includes(name) || dial) ? [ui.bold(`ToneDial · ${name}`), ""] : []), ...introduction];
    const write = process.stdout.write;
    let pending = header.length > 0;
    const flush = () => {
      if (!pending) return;
      pending = false;
      process.stdout.write = write;
      write.call(process.stdout, `${header.join("\n")}\n`);
    };
    // Prompts, pickers and previews write to stdout directly. Only text counts: a test runner's
    // binary reports share this stream.
    if (pending && !dial) {
      process.stdout.write = ((chunk: string | Uint8Array, ...more: never[]) => {
        if (typeof chunk === "string") flush();
        return write.call(process.stdout, chunk, ...more);
      }) as typeof write;
    }
    let result: CommandResult;
    try {
      result = await command.run(ctx, rest);
    } finally {
      if (pending) process.stdout.write = write;
    }
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify({ ...result.json, schema: JSON_SCHEMA, ok: true, warnings: result.warnings ?? [] }, null, 2)}\n`,
      );
    } else {
      flush();
      if (introduction.length && result.lines.length && result.lines[0] !== "") process.stdout.write("\n");
      const lines = [...result.lines];
      if (result.previewed && ctx.rerun !== undefined) {
        while (lines.at(-1) === "") lines.pop();
        lines.push(...nextStep(ctx.rerun, ui));
      }
      for (const line of lines) process.stdout.write(`${line}\n`);
      for (const w of result.warnings ?? []) process.stderr.write(notice(w, uiErr));
      // After the receipt, never instead of part of it.
      const afterStatus = await result.after?.();
      if (typeof afterStatus === "number") return afterStatus;
    }
    return 0;
  } catch (cause) {
    // A ConfigError is the user's own file or argument talking back, so it prints its message
    // and nothing else. Anything else is a defect and keeps its stack.
    // A RegionError is someone else's file talking back — a marker they moved or duplicated —
    // which is the user's situation to fix and not a defect in this tool.
    if (cause instanceof OwnershipConflict && ctx !== null) {
      const doctor = `tonedial doctor ${connectionScopeFlag(ctx.agent, cwd)}`;
      return fail(asJson, `${cause.message}\n  ${doctor}`, 1, uiErr, { reason: cause.reason, commands: [doctor] });
    }
    if (cause instanceof ScopeRequired && ctx !== null) {
      // A project scope in the home directory would refuse, so only the global one is offered there.
      const here = projectIsHome(resolveAgentPaths({ global: false, project: null, here: true }, env, cwd), env);
      const commands = (here ? ["--global"] : ["--global", "--here"]).map((scope) => `${rerunCommand(name, rest, flags, scope)} --auto`);
      return fail(asJson, cause.t.errors.scopeRequired(commands), 1, uiErr, { reason: cause.reason, commands });
    }
    if (cause instanceof ApprovalRequired && ctx?.rerun !== undefined) {
      const commands = [ctx.rerun, `${ctx.rerun} --dry-run`, `${ctx.rerun} --auto`];
      return fail(asJson, cause.t.wiring.needsApproval(ctx.rerun), 1, uiErr, { reason: cause.reason, commands });
    }
    if (cause instanceof ConfigError) return fail(asJson, cause.message, 1, uiErr, cause);
    if (cause instanceof RangeError || cause instanceof RegionError || cause instanceof OperationError) {
      return fail(asJson, (cause as Error).message, 1, uiErr);
    }
    throw cause;
  }
}

const MARKER = "  ⚠ ";
const CONTINUATION = "    ";

/** Fold warning prose without reflowing copyable paths or commands. */
function notice(message: string, ui: Palette): string {
  // A risk notice keeps the "!" its text leads with, as it does on stdout; other warnings get the sign.
  const risk = isRiskNotice(message);
  const folded = message.split("\n").flatMap(line => {
    const safe = humanText(line);
    return isCopyableLine(safe) ? [safe] : wrap(safe, ui.width - cells(MARKER));
  });
  return folded
    .map((line, i) => risk
      ? `${i === 0 ? "  " : CONTINUATION}${riskNotice(line, ui)}`
      : i === 0 ? `${ui.warn(MARKER)}${line}` : `${CONTINUATION}${line}`)
    .join("\n") + "\n";
}

/**
 * The command a person reruns to repeat this invocation: its arguments and options, the
 * effective `scope` spelled out (an unattended rerun needs it), and no approval or dry-run mode.
 */
function rerunCommand(name: string, args: string[], flags: Flags, scope: string | null): string {
  const quote = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `"${shellQuote(value)}"`;
  const options = FLAG_NAMES.flatMap((flag) => {
    if (flag === "auto" || flag === "dryRun" || scope !== null && (flag === "global" || flag === "here" || flag === "project")) return [];
    const value = flags[flag];
    return value === true ? [`--${FLAG_SPELLING[flag]}`] : typeof value === "string" ? [`--${FLAG_SPELLING[flag]} ${quote(value)}`] : [];
  });
  return ["tonedial", name, ...args.map(quote), ...options, ...(scope === null ? [] : [scope])].join(" ");
}

/** A named refusal adds its `reason` and the commands it offers; other failures carry neither. */
function fail(asJson: boolean, message: string, code: number, ui: Palette,
  refusal: { reason: string | undefined; commands: readonly string[] } = { reason: undefined, commands: [] }): number {
  if (asJson) {
    const named = refusal.reason === undefined ? {} : { reason: refusal.reason, commands: refusal.commands };
    process.stdout.write(
      `${JSON.stringify({ schema: JSON_SCHEMA, ok: false, error: message, ...named, warnings: [] }, null, 2)}\n`,
    );
  } else {
    // A standalone path is a copy target, not prose to split into unusable fragments.
    const lines = message.split("\n").flatMap((line) => {
      const safe = humanText(line);
      return isCopyableLine(safe) ? [safe] : wrap(safe, ui.width);
    });
    process.stderr.write(lines.map((line) => ui.error(line)).join("\n") + "\n");
  }
  return code;
}
