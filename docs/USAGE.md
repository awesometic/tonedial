# Using ToneDial

Start with [README.md](../README.md) for installation and first use.
This page covers settings, commands and recovery limits.
ToneDial requires Node 24+ and remains an unpublished `0.1.0` candidate; use the candidate procedure in [TESTING.md](./TESTING.md).

## Tone and axes

ToneDial compiles saved settings into `TONE.md` using one set of English instructions.
The agent can continue answering in the conversation's language; `language` changes only ToneDial's English or Korean interface.
Native delivery reads the managed `AGENTS.md` operating guide followed by `TONE.md` from the same state root.
Tone changes recompile the artifact without rewriting the guide.

Every axis has a level from 1–5 and is always emitted.
The endpoints describe requested behavior, not measured model adherence.

| Group | Axis | Default | 1 → 5 |
|---|---|---|---|
| form | `formality` | 3 | familiar wording → ceremonious wording within chosen address forms |
| form | `verbosity` | 3 | only what was asked → conclusion, reason, alternatives, background |
| form | `profanity` | **1** | none at all → strong and constant |
| form | `playfulness` | 3 | none → roleplay as the usual register |
| target | `critique` | 3 | flat problem statements without evaluation → unsparing |
| target | `flattery` | **1** | not at all → at least four times an answer |
| target | `warmth` | 3 | no emotion or encouragement → encouragement or empathy at least twice an answer |
| behaviour | `conviction` | 3 | asks at every decision without asserting → gives the conclusion without asking |
| behaviour | `care` | 3 | requested scope only → follow-ups, backups, your rest |
| behaviour | `compliance` | 3 | argues, then does it → immediately |
| behaviour | `refusal` | **1** | never → a visible strike until coaxed or released by the safeword |
| behaviour | `bravado` | **1** | never → boasts and overplays effort as the usual register |

The four bold defaults are permission axes whose natural floor is 1: setting every axis to 3 activates them, rather than restoring defaults.
`show` marks deviations; `show --explain` describes endpoints, settings and advisory risks.
Red levels and a color-independent `!` begin at `profanity=4`, `critique=4`, `flattery=3`, `conviction=5`, `compliance=5`, `refusal=2` and `bravado=2`.
These markers do not block, clamp or require extra approval.

```bash
tonedial show --explain
tonedial set warmth=5 critique=4
tonedial reset warmth              # one axis to its default
tonedial reset                     # all axes to their defaults
```

`reset` preserves persona, safeword and other settings.
It does not disable hooks or unload instructions; there is no persistent tone-off switch.
The artifact targets 1,800 Unicode code points, with a 2,700-character budget warning.
Dial changes, `show` and `compile --check` report its size.

## Presets and personal settings

Five bundled presets provide starting points.
`list` marks the active preset and custom entries; `list --verbose` adds non-default axis values.
`show <slug>` previews a preset without applying it.

```bash
tonedial list
tonedial use tough-love
tonedial save "My Tone"
tonedial export my-tone > my-tone.json
tonedial import my-tone.json
tonedial use my-tone
```

A preset carries axes only; applying or saving one never captures or changes persona, safeword, speech level or interface language.
`import` writes the custom preset but does not activate it; follow it with `use <slug>` when you want to apply the imported axes.
Use `export <slug> --json` when a schema 3 envelope is more useful than the raw preset object.
Imports also accept HTTPS URLs with bounded downloads and guarded redirects; remote receipts identify only scheme, host and port, while the request uses the complete URL.

```bash
tonedial set "safeword=plain answer please"
tonedial set speech_level=polite    # auto (default) | polite | plain
tonedial set persona.user_ref=boss
tonedial address "guide" "friend"  # self and user; bare address asks for both
tonedial set language=ko           # en | ko; init also accepts --lang
tonedial set "persona.note="       # empty values clear the named field
```

Persona fields are `self_ref`, `user_ref`, `age`, `gender` and `note` under `persona.`.
Age accepts `unspecified`, `teens`, `20s`, `30s`, `40s`, `50s+` or a number stored as a band; gender accepts `unspecified`, `masculine`, `feminine` or `neutral`.
Persona and safeword start unset; empty values clear them.
Persona has no fixed anchors: the requested order is axes, persona, then model defaults, and `show` warns when unanchored persona fields are set.
`speech_level` selects honorific address forms; `formality` grades wording and distance within them.
Auto chooses forms for the current relationship/scene, consistent within each reply; polite/plain retain their forms.
Warmth and profanity remain independent: familiar polite, formal plain and affectionate swearing are valid combinations.
These are prompt requests, not measured language adherence.
Bratty Kid uses the `bratty-kid` preset slug.

The safeword requests one plain answer without persona, flattery or jokes, after which the saved tone resumes.
It authorizes no action and may not be followed by the model.
ToneDial adds no factuality, visible-refusal, flattery-honesty or emergency-register guard; host permissions and file-change consent still apply.

## The inline dial

Bare `tonedial set` opens one inline preview with pending changes and selected-axis hints.
Up/down or `j/k` selects an axis; left/right or `h/l` changes its level, and digits 1–5 set it directly.
Tab selects the next axis, `?` opens help, Enter applies, and Esc, `q` or Ctrl+C discards.
The complete preview needs at least 60 columns and 24 rows; help and too-small views cannot edit or apply hidden values.
Raw input and cursor state are restored on exit, handled signals and stream errors; suspend/resume uses the same lifecycle.
Resizing can leave previous dial rows in preserved scrollback.
The unsupported `--full-screen` option refuses before writing.

Human output measures stdout and stderr separately and stacks detail in narrower terminals.
Unknown width uses a 100-cell prose fallback; non-terminal output is linear, non-animated and non-prompting.
Paths, commands, JSON and exports remain intact; human displays escape control characters without changing stored values.
`--color=auto|always|never` overrides environment settings; `NO_COLOR` otherwise beats `FORCE_COLOR`.
There is no saved width setting or universal output cap.
`fixed_width` and `guards` are not active settings. Assignments fail without writes; valid boolean values have no effect and are removed only by an authorized canonical write.
Read-only inspection preserves their bytes; malformed values require diagnosis or disclosed recovery.

## Connecting an agent

Installation alone creates no state, hook, skill or shell setup.
Select `codex`, `claude`, `gemini`, a comma-separated list, or `none` for state-only setup:

```bash
tonedial init --tools none --global --auto --json
tonedial set persona.user_ref=friend --json
tonedial set speech_level=polite --json
tonedial set "safeword=plain answer please" --json
tonedial show --json
```

This state-only sequence writes shared settings and artifacts without selecting a native tool.
`--json` never prompts, and `--auto` supplies approval for the explicit global initialization.
For a project connection, preview the selected native changes before approving them:

```bash
tonedial init --tools codex --project "$PWD" --dry-run --json
```

The project plan writes nothing and does not launch Codex; it still describes the selected project scope and intended files.

Typical setup and inspection commands are:

```bash
tonedial init --tools claude --global --dry-run --verbose
tonedial init --tools claude --global
tonedial wire codex --here
tonedial doctor --here
tonedial eject --here
```

`init`, `wire`, `doctor`, `unwire` and `eject` default to global wiring.
`--global` names it explicitly, `--here` selects the current project, and `--project <dir>` selects another directory; the three cannot be combined and `--project .` equals `--here`.
Use the same scope when inspecting, repairing or removing a connection.
Scope changes wiring destinations, never the shared dial or preset library.
`use <slug> --project <dir>` is a separate `.tonedial/TONE.md` export, not wiring; `test --project` selects its conversation folder.

Setup merges owned `SessionStart` entries into `.codex/hooks.json`, `.claude/settings.json` or `.gemini/settings.json`, preserving unrelated handlers.
Supported hook display fields identify ToneDial and describe loading the saved response tone; existing document descriptions are preserved.
Codex and Claude use one matcher; Gemini owns a three-entry set for startup, resume and clear.
Native selection adds `reader.mjs`, the shared skill source and host skill links.
`init --commands` also installs Claude's optional `/tone` command and requires `claude` in the selection.
Antigravity routes remain refused; local setup does not configure remote or cloud runtimes.

Setup and native changes are previewed and approved; `--verbose` shows the diff and `--dry-run` writes nothing.
`--auto` approves the plan but never chooses tools by detection.
Unattended setup requires explicit tools, and ordinary unattended connection writes require an explicit scope, including state-only init and `doctor --fix`.
Read-only doctor, dry runs and operation-ID rollback retain their scope exceptions.
Changed or ambiguous resources are preserved as foreign.
Scoped `unwire <tool>` or `eject` keeps shared state, presets, the installed CLI, shell PATH and other consumers/scopes.

Configuration, a runnable reader, host trust, hook activation, delivered context and model adherence are separate observations.
`doctor` checks configuration and controlled reader health, not native activation; activation remains unverified.
Codex trust evidence may be disabled or unknown, and a saved approval hash does not establish current trust.
In Codex, open `/hooks`, select `SessionStart`, then ToneDial; review the command and enable the hook.
ToneDial never grants trust.
Shared skill discovery can expose the skill to a provider without installing its automatic hook.
Use [TESTING.md](./TESTING.md) for qualification and the [release gate](../scripts/check-release.mjs) for release checks.

## Changing an open conversation

The generated skill saves a requested change through the CLI, runs `compile --check --json`, then reads `AGENTS.md` followed by `TONE.md` into the current conversation.
Where the host exposes skills as commands, use `/tonedial`; otherwise ask in ordinary language.

```text
/tonedial drop the flattery
/tonedial be blunter about the code
/tonedial reload the current settings
```

Reload changes no setting, runs no lifecycle hook and reaches only this conversation.
A settings-only question reports state without reading the pair.
Existing open conversations keep their context until they reload; new conversations depend on their configured delivery route.
A successful save and a later failed read are reported separately.
Skill discovery remains unverified; `TONE.md` carries a CLI fallback instruction.
Generated skill and optional `/tone` flows require CLI JSON schema 3; a CLI with an older schema requires a user-operated update.

Package updates do not refresh installed generated skill sources.
Refresh with the actual existing tool selection and scope, without adding a new route:

```bash
tonedial init --tools codex --global --dry-run --verbose
tonedial init --tools codex --global
tonedial doctor --global --verbose
```

Approved existing-state init and `doctor --fix` rebuild generated families and privately retain replaced entries.
Foreign provider files and external skill links remain protected.
State-only setup adds no native resources; recovery can restore missing companions of present or recorded runtime families.

## State and recovery

One state root resolves from `TONEDIAL_HOME`, then `$XDG_CONFIG_HOME/tonedial`, then `~/.tonedial`.
It holds `config.json`, `AGENTS.md`, `TONE.md`, generated `presets/builtin/`, user `presets/custom/`, flat user presets and recovery operations.
Native setup adds reader/skill files; curl installation keeps its package and shim in `lib/` and `bin/`.
Use the real state-root directory for writes and recovery: a symlink root is not supported.
Moving an installed curl root breaks its command/PATH references and is not a repair procedure.

Other variables are `VISUAL` then `EDITOR` for editing, `COLUMNS` for unmeasured width, and `LC_ALL` / `LC_MESSAGES` / `LANG` for first-init interface language detection.
`TONEDIAL_AGENT_HOME` overrides the wiring destination even with a scope flag; it is a tool override, not a host setting.
`SHELL` selects curl PATH syntax; `TONEDIAL_REGISTRY` selects the install/update registry and `TMPDIR` supplies private installation staging.

### Recovery

For an existing installation, use its installed command with the same `TONEDIAL_HOME` used by native delivery.
Diagnose, preview the rebuild, then approve it:

```bash
tonedial doctor --global --json
tonedial doctor --fix --global --dry-run --json
tonedial doctor --fix --global
tonedial list --json
tonedial show --json
```

Application rebuild preserves valid saved settings, unsaved axes and custom presets while replacing generated files.
Healthy presets remain listable/exportable with a damaged config; one bad preset does not hide the others.
Flat user presets remain loadable, and conflicting definitions receive a reported recovered copy without overwriting either original.
Missing information requires a visible choice: `--from-preset <slug>` supplies missing axes, `--from-operation <id>` supplies available saved values from a validated same-root operation, and current valid fields win.
Other missing values require disclosed defaults.
`--restore-preset <slug>` with an operation source restores only that missing/invalid user file and retains its damaged preimage.
Review native attention separately and select tools explicitly when adding or reconciling a route.

Keep the receipt's rollback IDs and originals.
If both native and application phases changed files, restore native first, then application files, with each reported ID:

```bash
printf 'Reported mutation operation ID: '
read -r operation_id
tonedial doctor --fix --rollback "$operation_id" --dry-run
tonedial doctor --fix --rollback "$operation_id"
```

Rollback uses the same state root and recorded paths, not a scope flag's destination.
It restores entries and modes only while evidence matches; independently changed targets and ambiguous/live owners remain protected.
Unreadable config does not prevent operation-ID rollback.
Never delete a lock to manufacture eligibility or the whole state root to repair an update.
Any `operations.lock` entry suppresses native reader delivery; externally removing it can leave a pending journal only doctor diagnoses.

Package repair is separate from application repair.
If the command cannot run, npm users reinstall/update with npm, then run `doctor --fix`; ToneDial does not spawn npm.
Curl users run a fresh `install.sh --repair` at the same root, retaining program archives and approving required component/source choices.
Unknown components remain protected without their named archive choice; failed state repair can be retried with the new command.
Curl PATH repair is limited to the recorded global profile and owned region; changed/foreign content remains protected, and npm owns its PATH setup.
See [the candidate checks](./TESTING.md#isolated-candidate) for installation recovery limits.

## Command reference and JSON

Bare `tonedial` shows first-use help without initializing state.
Use `tonedial --help`, `tonedial <command> --help`, or `--verbose` (`-v`) for details.
Successful tone mutations recompile in the same action.

| Command | Purpose |
|---|---|
| `set <axis>=<level> …` | Change axes or settings; bare opens the dial |
| `address [self user]` | Set terms of address; bare asks for both |
| `reset [axis]` | Restore one or all axes to defaults |
| `show [slug]` | Inspect state or a preset; `--explain` describes settings and risks |
| `use <slug>` | Apply a preset; `--project <dir>` also exports the artifact |
| `save <display name>` | Save current axes as a custom preset |
| `list` | List presets; `--verbose` adds axis values |
| `export <slug>` / `import <file-or-https-url>` | Exchange axis-only preset JSON |
| `edit [preset <slug>]` | Open config/preset in the selected editor; `--dry-run` previews |
| `init` | Set up state or rebuild generated app files; optionally select native tools |
| `wire [tool]` / `unwire [tool]` | Connect/disconnect a tool in the selected scope |
| `doctor` | Diagnose; `--fix` rebuilds, `--fix --rollback <id>` restores an operation |
| `eject` | Disconnect the selected scope, preserving shared state |
| `compile` | Generate the artifact; `--check` inspects without writes |
| `test [claude|codex]` | Fresh conversation; `--preset <slug>` previews preset axes; JSON/dry-run launch nothing |
| `update` | Update curl installs; report npm's update command for npm installs |

Every command accepts `--json` and returns integer `schema: 3` envelopes, including version and errors.
Persisted config stays schema 2; preset and operation formats are separate.
`show` includes `riskAxes` and `riskThresholds`, omitting unsupported guard, ceiling and width fields.
JSON stdout has no terminal escapes; JSON mode has no ToneDial-owned prompt or after-receipt provider handoff.
An explicitly requested editor in `edit --json` still runs with live output on stderr.
Plain `export` emits raw preset JSON; `export --json` wraps it.
Human `compile --check` compares current/stale/missing artifact state; JSON check reports size and absolute `agentsPath` / `path` without proving existence or delivery.

`edit` protects managed wiring: an edited config is not applied if its ownership graph changes or cannot be proved unchanged, including invalid JSON.
Live config, artifact and native files remain intact; the edited copy is privately retained at its reported temporary path when it still exists.
Use scoped disconnect or approved setup/recovery to change wiring ownership.

## Try a fresh conversation

```bash
tonedial test claude
tonedial test codex --project .     # current existing folder
tonedial test codex --preset my-tone # bundled or user preset; saved settings stay intact
tonedial test codex --accept-usage  # accept usage and charges for this launch
tonedial test claude --json         # plan only; claude must be on PATH; no launch
```

The command uses an installed Claude or Codex client and normal authentication, compiling saved settings in memory without changing ToneDial state.
Before the provider choice, a notice covers account tokens, charges, possible excessive reasoning or long explanations, and history.
Enter `y` to accept responsibility and start; Enter or `n` cancels.
`--accept-usage` skips only this invocation's consent question and never persists consent.
Without `--preset`, the preview uses saved axes, including unsaved edits.
With it, a bundled or user preset supplies axes; saved persona, address, register and safeword stay in effect.
With one provider it can select it; with both it asks interactively, while ambiguous JSON/dry-run plans require an explicit provider.
The target is the current folder or an existing `--project` directory.
The opening prompt requests dialogue only and forbids file changes throughout that folder.
Claude disables built-in tools and denies MCP tools; Codex requests a read-only sandbox and no approval escalation.
Claude safe mode and Codex's invocation-only hook/doc overrides request a preview without previous connected ToneDial context.
The initial prompt identifies only this compiled preview as its ToneDial manner source.
Managed policy and native-client support remain independent; this is not whole-folder OS isolation.
Provider costs, history and native exit status still apply; unsupported clients must not retry without restrictions.
See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for the native controls.

The complete preview tone, including persona notes, reaches the client/model and may enter provider history or appear in process arguments under OS access policy.
Keep credentials and private material out of persona notes used here.
`--json` and `--dry-run` ask nothing, launch nothing, run no capability probe and omit the prompt body.
They still require the named provider executable on `PATH`, an existing target directory and a readable ToneDial config; with both providers installed, name one explicitly in a plan.
This initial-prompt preview proves neither native activation nor model adherence.

## Limits

A model may interpret, ignore or decline tone requests, even at low levels.
Risk markers describe requested settings, not model ceilings or guaranteed unrestricted output.
This is for fun and is not recommended for production use: work-state, result and risk statements may contain falsehood, omission or exaggeration.
Configuration or reader self-tests prove neither host trust, activation, delivered context nor model behavior.
Use [TESTING.md](./TESTING.md) for verification and [CONTRIBUTING.md](../CONTRIBUTING.md) to report reproducible observations.

## Current dial example

The README image is a synthetic 80-column Tough Love preview with warmth moved from 5 to 4 and discarded rather than saved.
It uses the current dial renderer, not a native-agent response; terminal fonts and colors can differ.
Per-locale [English metadata](./media/readme/en/dial-example.json) and [Korean metadata](./media/readme/ko/dial-example.json) record input/frame/image hashes; update the affected image when the renderer changes.
Width belongs to the synthetic stream, not a saved setting or runtime flag.
From the repository root, generate the frame without reading saved settings or starting a provider:

```bash
node scripts/dial-frame.ts en 80 > frame.ansi
node scripts/dial-frame.ts ko 120 > frame-ko.ansi
node scripts/dial-svg.ts ko 80 > dial-ko.svg
```

Rasterization is optional development tooling; render the frame with an ANSI-to-image tool and inspect glyph/cell alignment.
`node scripts/demo.ts --list`, then `node scripts/demo.ts <scene> <language>`, renders isolated 80-column CLI scenes without a native client.
Demo rendering uses no authenticated capture or provider; unknown options refuse before rendering or starting a child.
README.md is the English default; README.ko.md adds Korean. Follow the [README media conventions](./media/readme/README.md) for locale folders and names.
Follow [TESTING.md](./TESTING.md).

## Installation channels after release

These channels are not live for the unpublished `0.1.0` candidate; use README's candidate path.

```bash
npm i -g tonedial
curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh
```

Use `npm update -g tonedial` for npm installs and `tonedial update` for curl installs.
`npx` is unsupported because skill/control commands need a durable executable.
