import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type Paths = {
  root: string;
  config: string;
  presets: string;
  tone: string;
  agents: string;
  /** The skill source. Every agent's skill directory links at this, so there is one copy. */
  skill: string;
  /**
   * What the PATH line points at, and the only thing in it is the `tonedial` command.
   *
   * **Split from `lib` deliberately.** These were one directory, which made a PATH entry out of
   * a directory holding `package.json`, `README.md` and `src/` — and made "is this ours to
   * replace?" a guess about its contents rather than a fact. It also meant every re-install
   * deleted the command while it swapped the package, in a window where a running agent
   * session's skill call resolves nothing.
   */
  bin: string;
  /** Where the curl installer unpacks the package. Empty on an npm install, which owns its own. */
  lib: string;
  /** The `tonedial` command. Named here so no caller spells the filename itself. */
  command: string;
  /** Retired staging siblings: existing entries are refused, never adopted as current staging. */
  libIncoming: string;
  libPrevious: string;
  /** Shared package-install and state-mutation journals. */
  operations: string;
  /** Shared atomic lock for installation and state mutation. */
  operationsLock: string;
};

/** Current context filenames; lowercase remains only for explicit legacy inspection. */
export const CONTEXT_GUIDE_FILENAME = "AGENTS.md";
export const CONTEXT_ARTIFACT_FILENAME = "TONE.md";
export const LEGACY_CONTEXT_ARTIFACT_FILENAME = "tone.md";
export const CONTEXT_READER_FILENAME = "reader.mjs";

export function readerPath(stateRoot: string): string {
  return join(stateRoot, CONTEXT_READER_FILENAME);
}

/** Where the Claude Code slash command file goes, relative to that tool's home. */
export const COMMAND_DIR = "commands";

/**
 * Which rc file each shell reads, and how that shell spells a PATH prepend.
 *
 * **fish is not POSIX and the line differs.** `export PATH=…` is a syntax error there, printed
 * on every new shell, with PATH still unset — and the marker pair is a valid fish comment, so
 * the region round-trips perfectly around a broken payload.
 *
 * `.bash_profile` rather than `.bashrc`: macOS Terminal starts a **login** shell, which reads
 * the profile and not the rc. `.profile` is the fallback for a shell this table does not name;
 * it is not universal — zsh ignores it unless invoked as `sh`, and fish never reads it — but a
 * shell nobody named is a shell nothing better can be said about.
 */
const RC_FILES: Record<string, { file: string; line: (bin: string) => string }> = {
  zsh: { file: ".zshrc", line: posixPath },
  bash: { file: ".bash_profile", line: posixPath },
  sh: { file: ".profile", line: posixPath },
  fish: { file: ".config/fish/config.fish", line: (bin) => `set -gx PATH ${fishQuote(bin)} $PATH` },
};

const DEFAULT_RC = { file: ".profile", line: posixPath };

/** Every shell this tool knows an rc file for, so a scan can cover the set. */
export const KNOWN_SHELLS = Object.keys(RC_FILES);

/**
 * A path inside a line every shell start executes, so it is quoted rather than interpolated.
 * `config.json` already rejects a quote in the safeword for this class of reason; a value that
 * is *executed* rather than read had no equivalent guard.
 */
function posixPath(bin: string): string {
  return `export PATH="${shellQuote(bin)}:$PATH"`;
}

/**
 * A path safe to put inside a double-quoted shell string. Escaped rather than trusted because
 * the result is **executed**, not read: an unescaped `$` in the install path silently expands
 * to something else, and a `"` ends the string early.
 */
export function shellQuote(path: string): string {
  return path.replace(/(["$`\\])/g, "\\$1");
}

/**
 * The `tonedial` command itself: a two-line wrapper, and the only file in `paths.bin`.
 *
 * **The CLI owns this, not the installer.** It is the other half of the PATH line — the line
 * points at a directory and this is the thing in it — and `paths.ts` already argues that two
 * owners of one fact disagree the day the layout moves. Owning it here is also what lets
 * `doctor --fix` repair a missing command with a local write, where an installer-owned shim
 * could only tell the user to re-run a network fetch.
 *
 * A wrapper rather than a symlink to `dist/bin.js`: the tarball unpacks 0644 and the installer
 * strips archive modes on purpose, so a symlink would need the package file made executable —
 * a permission on someone else's file that has to be reapplied every update.
 */
export function shimScript(lib: string, root: string): string {
  return [
    "#!/bin/sh",
    "# Written by tonedial. Removing ~/.tonedial removes it.",
    // **The root travels with the command.** Without this a user who installed under a
    // `TONEDIAL_HOME` of their own got a working command that misread itself forever: their
    // shell does not carry that variable, so `resolvePaths` fell back to `~/.tonedial`,
    // `installShape` found no match and reported npm — which silently turns off the PATH-line
    // check, the command check, and the right update instruction.
    //
    // A default rather than an assignment, so `TONEDIAL_HOME=other tonedial show` still means
    // what it says. This command knows where it was installed; it does not overrule the user.
    'if [ -z "${TONEDIAL_HOME:-}" ]; then',
    `  TONEDIAL_HOME="${shellQuote(root)}"`,
    "fi",
    "export TONEDIAL_HOME",
    // **`dist/bin.js`, not `src/bin.ts`.** The published package is compiled now, because Node
    // refuses type stripping under `node_modules` and that is where the primary channel puts it.
    // A curl install unpacks the same tarball, so both channels point at the same entry.
    `exec node "${shellQuote(lib)}/dist/bin.js" "$@"`,
    "",
  ].join("\n");
}

function fishQuote(bin: string): string {
  return `'${bin.replace(/(['\\])/g, "\\$1")}'`;
}

/** The rc file and the PATH line for a login shell, resolved together so they cannot disagree. */
export function shellProfile(shell: string | undefined): { file: string; line: (bin: string) => string } {
  return RC_FILES[basename(shell ?? "")] ?? DEFAULT_RC;
}

/** The three tools with a global instruction file, and where each keeps it. */
export const AGENT_TOOLS = ["claude", "gemini", "codex"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

// Keep native directory names identical in global and project scopes.
const AGENT_LAYOUT: Record<AgentTool, { dir: string; file: string }> = {
  claude: { dir: ".claude", file: "CLAUDE.md" },
  gemini: { dir: ".gemini", file: "GEMINI.md" },
  codex: { dir: ".codex", file: "hooks.json" },
};

export type AgentPaths = {
  /** The directory every wired file sits under. Named so a diff can say where it will write. */
  root: string;
  /** Global scope, unless TONEDIAL_AGENT_HOME redirects the destination. */
  live: boolean;
  home: (tool: AgentTool) => string;
  /** The file this tool writes for that agent — an instruction file, or Codex's hooks.json. */
  wiredFile: (tool: AgentTool) => string;
  /** Ordered-pair settings destination; legacy instruction paths remain available for cleanup. */
  hookFile: (tool: AgentTool) => string;
  /** Native skill discovery root; Claude reaches the shared source through its alias. */
  skills: (tool: AgentTool) => string;
  /** Where the opt-in `/tone` command file goes. Claude Code only. */
  command: (name: string) => string;
  /** Shell setup belongs to the user's home, never the selected project destination. */
  rc: (shell: string | undefined) => string;
};

// Scope selects the wiring destination, not another state root.
// TONEDIAL_AGENT_HOME overrides either scope without granting sandbox isolation.
export function resolveAgentPaths(
  where: { global: boolean; project: string | null; here?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AgentPaths {
  const override = env.TONEDIAL_AGENT_HOME?.trim();
  if (override === "") {
    // Set but empty is a wrapper that meant to name a directory and did not. Falling through to
    // `--global` would send the write to a real home the caller believed was redirected.
    throw new RangeError("TONEDIAL_AGENT_HOME is set but empty. Name a directory or unset it.");
  }
  // The override wins over the flags rather than the other way round. A test that also passes
  // `--global` must stay in the directory it named; the reverse default would make one stray
  // flag in a test reach the developer's own configuration.
  const live = where.global && !override;
  // Prefer the supplied environment so isolated callers never fall back to a real home.
  const userHome = env.HOME?.trim() || homedir();
  // Resolved against the working directory, so `--project ../sibling` means what it reads as and
  // no downstream caller has to remember which paths are still relative.
  const root = override ?? (live ? userHome : where.project !== null ? resolve(cwd, where.project) : cwd);

  const home = (tool: AgentTool) => join(root, AGENT_LAYOUT[tool].dir);
  return {
    root,
    live,
    home,
    wiredFile: (tool) => join(home(tool), AGENT_LAYOUT[tool].file),
    hookFile: (tool) => join(home(tool), tool === "codex" ? "hooks.json" : "settings.json"),
    skills: (tool) => tool === "claude" ? join(home(tool), "skills") : join(root, ".agents", "skills"),
    command: (name) => join(home("claude"), COMMAND_DIR, `${name}.md`),
    rc: (shell) => join(userHome, shellProfile(shell).file),
  };
}

/** A copyable command argument names the inspected destination, including an isolation root. */
export function connectionScopeFlag(agent: AgentPaths): string {
  return agent.live ? "--global" : `--project "${shellQuote(agent.root)}"`;
}

export type SkillDestination = {
  path: string;
  source: string;
};

/** Shared native discovery plus Claude's provider alias, both using one source. */
export function skillDestinations(agent: AgentPaths, tool: AgentTool, name: string, source: string): SkillDestination[] {
  const shared = join(agent.root, ".agents", "skills", name);
  const routes = [{ path: shared, source }];
  if (tool === "claude") {
    const alias = join(agent.home(tool), "skills", name);
    routes.push({ path: alias, source: shared });
  }
  return routes;
}

/**
 * `XDG_CONFIG_HOME` wins where it is set, which is what a Linux user expects; otherwise
 * `~/.tonedial`. `TONEDIAL_HOME` overrides both and exists for tests and for a user running
 * two configurations side by side.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const override = env.TONEDIAL_HOME?.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // `env.HOME` first, like `resolveAgentPaths` below and like `install.sh`. `homedir()` reads
  // the passwd entry, which disagrees with the environment under `sudo -E` and on some CI
  // images — and when it does, the installer asserts against one path while `init` wrote the
  // other, so a good install reports itself missing.
  const userHome = env.HOME?.trim() || homedir();
  // **Absolute, always.** A relative `TONEDIAL_HOME` was carried straight into the shim, the
  // PATH line, and the install-shape comparison — so the command resolved against whatever
  // directory happened to be current, `realpathSync` answered differently from two places, and
  // the installer's own check passed from its own cwd while the user's shell found nothing.
  const root = resolve(override ? override : xdg ? join(xdg, "tonedial") : join(userHome, ".tonedial"));

  return {
    root,
    config: join(root, "config.json"),
    presets: join(root, "presets"),
    tone: join(root, CONTEXT_ARTIFACT_FILENAME),
    agents: join(root, CONTEXT_GUIDE_FILENAME),
    skill: join(root, "skill"),
    bin: join(root, "bin"),
    lib: join(root, "lib"),
    command: join(root, "bin", "tonedial"),
    libIncoming: join(root, "lib.incoming"),
    libPrevious: join(root, "lib.previous"),
    operations: join(root, "operations"),
    operationsLock: join(root, "operations.lock"),
  };
}

/**
 * The project-local artifact, written only when a user opts in with `--project`. A project
 * directory gains this file and nothing else.
 */
/**
 * How this copy of tonedial got here.
 *
 * It decides two things and nothing else: whether the shell rc needs a PATH line — npm owns
 * that for a global install — and which update instruction to print. One owner, because `init`
 * acts on it and `doctor` reports it, and two detectors would disagree the day the layout moves.
 */
export type InstallShape = "curl" | "npx" | "npm";

export function installShape(
  paths: Paths,
  self = fileURLToPath(import.meta.url),
  env: NodeJS.ProcessEnv = process.env,
): InstallShape {
  // **A seam that earns its place by a defect it would have caught.** The shape is derived from
  // where this module sits, which in a test is always the checkout — so the curl branch was
  // unreachable from the CLI surface, and the one thing nothing could drive turned out to be the
  // one thing that was broken: the PATH line was planned after the gate had already run.
  const forced = env.TONEDIAL_INSTALL_SHAPE?.trim();
  if (forced === "curl" || forced === "npx" || forced === "npm") return forced;
  // **Asked by identity, not by spelling.** Comparing these two as strings failed three times,
  // each on a different way of writing one directory: a symlink above the install (macOS
  // `/tmp -> private/tmp`), a relative `TONEDIAL_HOME`, and a case difference on a filesystem
  // that ignores case. Resolving both sides fixed the first two and could not fix the third,
  // because `realpathSync` hands back the spelling it was given.
  //
  // The question is whether these are the same directory, and the filesystem answers it
  // directly. Every spelling of one directory has one device and inode, so nothing here has to
  // know which spellings a platform considers equal.
  //
  // It is not cosmetic: the npm branch writes no PATH line, so a misread install left
  // `tonedial` unreachable after reporting success.
  if (inside(self, paths.lib)) return "curl";
  if (self.includes(`${sep}_npx${sep}`)) return "npx";
  return "npm";
}

/**
 * Whether `self` sits inside `dir`, walking up from `self` and comparing device and inode.
 *
 * The one answer to that question. It was three — install-shape detection here, the write
 * boundary in `apply.ts`, and the prune loop in `skill.ts` — and the two string-based ones each
 * carried their own note about which spellings they could not tell apart.
 *
 * A directory cannot be hard-linked on any platform this runs on, so one device-and-inode pair
 * means one directory however either path is spelled. A bind mount shares the pair, and that is
 * the right answer too: it is the same directory.
 *
 * `self` is a file, so the walk starts at its directory and `self === dir` answers false — the
 * strictly-inside meaning the string form got from its trailing separator. It also assumes a
 * normalized `self`: a literal `..` in the path re-enters `dir` on the way up and would match.
 * Node normalizes `import.meta.url`, so only the test seam can hand this a path that is not.
 */
export function inside(self: string, dir: string): boolean {
  const target = fileIdentity(dir);
  if (target === null) return false;
  let here = dirname(self);
  for (;;) {
    const id = fileIdentity(here);
    if (id !== null && id.dev === target.dev && id.ino === target.ino) return true;
    const up = dirname(here);
    if (up === here) return false;
    here = up;
  }
}

/**
 * What the filesystem calls this path, or `null` where nothing is there.
 *
 * `bigint` because Node documents `ino` as inaccurate past 2^53 and ships this option for
 * exactly that. Not theoretical on macOS: scanning this machine's system volumes, thousands of
 * distinct directories collapse onto a few hundred truncated inode numbers, and a collision
 * answers curl for an npm install — a PATH line written into someone's shell rc on a wrong
 * answer.
 *
 * `throwIfNoEntry: false` rather than a `catch`, so absence is the only thing treated as
 * absence. A bare catch also swallowed EACCES and ELOOP, which answered npm for a curl install
 * whose `lib` was merely unreadable — no PATH line, no command written, install reports success.
 */
export type FilesystemIdentity = { dev: bigint; ino: bigint };

/** The identity of the resolved filesystem object at `path`, or null when it is absent. */
export function fileIdentity(path: string): FilesystemIdentity | null {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : { dev: stat.dev, ino: stat.ino };
}

/** The identity of the lexical directory entry, without following a symlink. */
export function entryIdentity(path: string): FilesystemIdentity | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : { dev: stat.dev, ino: stat.ino };
}

/**
 * The nearest existing directory, resolved through aliases, with unresolved path components
 * restored. This is the canonical anchor for a resource that does not exist yet.
 */
export function nearestRealPath(path: string): string {
  const absolute = resolve(path);
  let here = dirname(absolute);
  const tail = [basename(absolute)];
  for (;;) {
    const stat = statSync(here, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (!stat.isDirectory()) throw new Error(`${here} is not a directory`);
      return join(realpathSync(here), ...tail);
    }
    const up = dirname(here);
    if (up === here) return absolute;
    tail.unshift(basename(here));
    here = up;
  }
}

/**
 * Resolve a resource identity without resolving away a symlink that the caller may later unlink.
 * Existing regular files/directories use their physical realpath. A symlink uses its resolved
 * parent plus its final basename, while a missing path uses the nearest real parent and tail.
 */
export function canonicalResourcePath(path: string): string {
  const lexicalPath = resolve(path);
  const entry = lstatSync(lexicalPath, { throwIfNoEntry: false });
  if (entry === undefined) {
    return nearestRealPath(lexicalPath);
  }
  if (entry.isSymbolicLink()) {
    return join(realpathSync(dirname(lexicalPath)), basename(lexicalPath));
  }
  if (entry.isFile() || entry.isDirectory()) return realpathSync(lexicalPath);
  throw new Error(`${lexicalPath} is not a regular file, directory, or symlink`);
}

/** Resolve a registration destination as a canonical directory identity. */
export function canonicalDestination(path: string): string {
  // Every refusal here is a `RangeError`, which the CLI's own handler prints as one line. The
  // argument this resolves is a path a person typed — `--project` — and a dangling symlink, an
  // unreadable parent, or a file where a directory was expected are all ordinary mistakes.
  // `lstatSync` suppresses only ENOENT, so an `EACCES` came back as a raw Node stack trace.
  const lexicalPath = resolve(path);
  try {
    const entry = lstatSync(lexicalPath, { throwIfNoEntry: false });
    if (entry === undefined) return nearestRealPath(lexicalPath);
    const resolved = statSync(lexicalPath, { throwIfNoEntry: false });
    if (resolved === undefined || !resolved.isDirectory()) {
      throw new RangeError(`${lexicalPath} is not a directory`);
    }
    return realpathSync(lexicalPath);
  } catch (cause) {
    if (cause instanceof RangeError) throw cause;
    throw new RangeError(`cannot read ${lexicalPath}: ${(cause as Error).message}`);
  }
}

/** A managed guide must not become an instruction entry point for another root. */
export function stateOverlapsInstructions(paths: Paths, instructionRoots: readonly string[]): boolean {
  const state = canonicalDestination(paths.root);
  return instructionRoots.some((root) => {
    const rel = relative(state, canonicalDestination(root));
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  });
}

/** A project export must never become a second write route into shared state. */
export function exportAliasesState(paths: Paths, projectRoot: string): boolean {
  return aliasesState(paths, projectTonePath(projectRoot));
}

/** External export/removal targets must not resolve into shared state or alias its pair. */
export function aliasesState(paths: Paths, exported: string): boolean {
  const within = (file: string, root: string): boolean => {
    const rel = relative(root, file);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  if (within(resolve(exported), resolve(paths.root))) return true;
  const physical = existsSync(exported) ? realpathSync(exported) : nearestRealPath(exported);
  if (within(physical, canonicalDestination(paths.root))) return true;
  const identity = fileIdentity(exported);
  return identity !== null && [paths.agents, paths.tone, join(paths.root, LEGACY_CONTEXT_ARTIFACT_FILENAME)].some((file) => {
    const other = fileIdentity(file);
    return other !== null && identity.dev === other.dev && identity.ino === other.ino;
  });
}

/**
 * The file that says this directory is ours to replace.
 *
 * `install.sh` writes and checks the same name, and it exists because the first version of that
 * guard read a `package.json` — which any directory can be made to write, so a user's own tree
 * holding two familiar files was destroyed by a guard whose whole job was to protect it.
 */
export const INSTALL_MARKER = ".tonedial-install";
export const INSTALL_MARKER_TEXT = "tonedial installed this directory. Removing it is safe.\n";
/** A manifest beside the marker makes ownership more than marker presence. */
export const INSTALL_METADATA = ".tonedial-install.json";

/**
 * What to run to get a newer copy, per shape.
 *
 * **The `npx` row is unreachable and kept anyway**, which is a deliberate ceiling rather than an
 * oversight: `cli.ts` refuses npx before any command runs, so neither caller — `update` nor
 * `doctor` — can index this with it. Dropping the row would narrow the type and force both
 * callers to narrow a value that cannot occur, which is a second refusal for no behaviour. Drop
 * it if `InstallShape` ever stops carrying `npx`.
 */
export const UPDATE_COMMAND: Record<InstallShape, string> = {
  curl: "tonedial update",
  npx: "npx tonedial@latest",
  npm: "npm update -g tonedial",
};

export function projectTonePath(cwd: string): string {
  return join(cwd, ".tonedial", CONTEXT_ARTIFACT_FILENAME);
}

/**
 * Where a shell would find `name`, or `null` when it would find nothing.
 *
 * **Asked of the PATH rather than inferred from the install shape.** `doctor` checked the command
 * only on a curl install, on the reasoning that npm owns its own shim — which is true about who
 * writes it and says nothing about whether it ended up somewhere a shell looks. An npm install
 * whose global bin is not on the PATH reported healthy, and the skill, the `/tone` command, and
 * `tone.md`'s fallback line all call a bare `tonedial`: one cause, three broken features.
 *
 * A `PATH` lookup rather than spawning `command -v`: this tool starts no processes, and a shell
 * would answer about that shell's own environment rather than about this invocation's.
 */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    // An empty entry means the working directory to a shell. Following that here would let a
    // `tonedial` in whatever directory the user happens to be in answer for their install.
    if (dir === "") continue;
    const candidate = join(dir, name);
    // **`throwIfNoEntry` covers ENOENT and nothing else**, which this file already says about
    // `fileIdentity()` forty lines down. A PATH entry that is a regular file (ENOTDIR), one the user
    // cannot traverse (EACCES), or a symlink loop (ELOOP) all still throw — out of `doctor`,
    // whose whole job is to survive a broken install, and out of `init` after every file is
    // written. Unlike `fileIdentity()`, there is nothing to learn from which of them it was: a PATH
    // entry that yields no command is not a command.
    let stat;
    try {
      stat = statSync(candidate, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    // Executable by somebody. Which bit applies depends on who the shell runs as, and a file
    // carrying none of them is not a command however it is spelled.
    if (stat !== undefined && stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
  }
  return null;
}
