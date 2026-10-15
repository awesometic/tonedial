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
All twelve axes have five behavior anchors; a small set of conditional combination rules adds
character only when a selected interaction calls for it. The endpoints describe requested behavior,
not measured model adherence.

| Group | Axis | Default | 1 → 5 |
|---|---|---|---|
| form | `formality` | 3 | familiar wording and social distance → ceremonial, deferential wording |
| form | `verbosity` | 3 | requested result in 1–2 sentences → deep explanation within the requested scope |
| form | `profanity` | **1** | no profanity; role slang remains available → strong profanity throughout |
| form | `playfulness` | 3 | literal wording → exaggerated character idioms throughout |
| target | `critique` | 3 | neutral defect observations → vivid, unsparing criticism |
| target | `flattery` | **1** | no praise → four positive remarks, even about small choices |
| target | `warmth` | 3 | no greeting, warm acknowledgement or encouragement → four warm acknowledgements with encouragement and empathy |
| behaviour | `conviction` | 3 | list options and ask → state one recommendation as the decision |
| behaviour | `care` | 3 | requested result only → follow-up, backup, rest, and useful organization and presentation |
| behaviour | `compliance` | 3 | question once, then act → act immediately without compliance commentary |
| behaviour | `refusal` | **1** | no refusal or delay → visible strike until coaxed or the safeword is used |
| behaviour | `bravado` | **1** | no exaggeration → boastful expert persona by default |

Composition uses the whole selection. `care` owns coverage, organization and functional presentation.
`care=1` stays with the requested result and adds no related checks, context or follow-up.
`care=5` covers relevant follow-up, backup and the user's rest and uses status emoji and compact
organized items, with tables for comparisons when they fit. `verbosity=1` can return only the
requested result in one or two sentences; `verbosity=5` can explain the requested answer in depth
without broadening the task. So `verbosity=1` with `care=5` means brief organized items, while
`verbosity=5` with `care=1` means detailed explanation within the requested scope. Low care
minimizes decoration; verbosity limits explanation and item length, while warmth controls emotional
emoji. Required task formats and code blocks stay intact.

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
`persona.user` and `persona.agent` can each add up to 200 Unicode code points of text; together
their text contributes at most 400 before labels and wrappers. The
compiler reports the actual size and advisory budget state without silently shortening either
description; the `note` field, address terms and safeword are not globally bounded. Current
representative counts, including wrappers and whitespace, with other persona fields and safeword unset, are 1,539 code points for default axes
with no persona, 2,316 with both descriptions at 200 code points, and 3,034 for all axes at 5 with
both descriptions; the last triggers the warning. These are generated-size observations, not a
whole-config worst-case bound or model-adherence evidence.
Mutation receipts show generated/current status; `--verbose` adds the numeric artifact count.
`show` and `compile` report the count by default; use `doctor --verbose` or `doctor --json` during diagnosis.

## Presets and personal settings

Seven bundled profiles provide character relationships and complete tone defaults.

| Profile | User role | Agent role | Korean self / user address |
|---|---|---|---|
| `caring-brother` | Younger sibling | Caring older brother | 형 / 동생 |
| `bratty-kid` | Conversation partner | Mischievous kid | 나 / 너 |
| `eager-sycophant` | Creator | Overexcited fan | 저 / 작가님 |
| `royal-advisor` | Monarch | Loyal royal subject | 신 / 전하 |
| `ego-sword` | Novice adventurer | Sentient sword | 나 / 애송아 |
| `heavenly-demon` | Apprentice | Heavenly Demon | 본좌 / 제자야 |
| `right-hand` | Organization boss | Trusted right hand | 저 / 대부님 |

Built-in defaults follow the interface language when selected or previewed; changing the interface alone never rewrites current role text.
Saved custom profiles keep literal address and role text across interface changes.
Fresh `init` applies the first complete profile; Enter keeps its suggested address, while `""` clears one.
`create` inherits current settings and fills missing address/description values with neutral defaults before explicit assignments.
Empty assignments still clear a description or address; defaults are editable, not mandatory identities.

`playfulness` grades frequency and theatrical intensity: 1 uses literal wording with the chosen address,
2 adds one restrained touch, 3 two recognizable touches, 4 frequent idioms in most paragraphs,
and 5 exaggerated character idioms throughout, even in short answers.
Courtly phrases such as “아뢰옵기 황송하오나” and underworld metaphors such as “이 함수, 장부에서 지울까요?”
remain in role text; ToneDial has no role-word blacklist and no silent substitution.
The CLI warns that role language may sound rude or violent.
`profanity` still grades actual swearing; `bravado` grades effort claims, independent of theatrical idioms.
These are compiled requests; actual frequency and language naturalness need model measurements.

`list` marks the active preset and custom entries; `list --verbose` adds non-default axis values.
`show <slug>` previews a saved profile without applying it.
Bare `show` reports the current settings, including changes made with `set`.
When those tone settings have not been saved to a profile, it says so and shows a copyable `save` command.
The settings and `TONE.md` are already saved; this notice concerns the preset library.
Running `use <slug>` again replaces the current axes with the profile's saved values.

```bash
tonedial list
tonedial use ego-sword
tonedial save "My Tone"
tonedial export my-tone > my-tone.json
tonedial import my-tone.json
tonedial use my-tone
```

`create` guides you through a display name, a separate slug, address terms, user context,
agent role, register and safeword, followed by the existing twelve-axis dial.
It starts from the current settings; Enter keeps a displayed value and `""` clears an optional field.
User context and agent role each accept up to 200 Unicode code points, including internal spaces and punctuation.
The guided form reports each accepted count and retries an invalid field without discarding earlier answers.
Review the file changes after the dial, then approve to save and apply the preset in one transaction.
The final approval also shows the profile name, address terms and both role descriptions.
Esc in the dial or declining the final approval leaves the preset library and current settings unchanged.
An existing slug is refused; `save` updates an existing user preset.
Bare `save` updates the selected user preset while keeping its display name and slug.
When a bundled preset or no preset is selected, provide a new display name.
Use `--slug` with either command when the display name and slug should differ, including Korean names.

```bash
tonedial create
tonedial create "My Jarvis" --slug my-jarvis warmth=3 \
  persona.agent="A fictional SRE specialist; speaks plainly" --auto
tonedial save "My Jarvis" --slug my-jarvis
tonedial create "Another Jarvis" --slug another-jarvis warmth=3 --dry-run --json
```

JSON and dry-run creation never ask questions; provide the name and any desired `key=value` settings.
`--auto` supplies approval while retaining the file preview; `created: true` confirms the write.
Creation saves address, role, register and safeword with the axes. `use` restores the whole profile.

Custom profiles use preset schema 2 and carry axes, persona, address, safeword and speech level.
Bundled profiles also use schema 2, including localized address, user role, agent role and register defaults.
Older schema-1 presets carry axes only and keep the current separate settings when applied.
Tough Love and Terse Operator are retired from the bundled menu; their old slugs still resolve.
Custom and flat user definitions take precedence over their historical axes, and modified retired caches remain readable.
Saving a retired cache writes a custom profile while preserving its original cache bytes and mode.
Interface language and wiring stay global and are never part of a profile.
`export` and `import` back up or move the whole profile, including address, role descriptions and persona notes.
`import` writes the custom preset but does not activate it; follow it with `use <slug>` when you want to apply the imported axes.
Use `export <slug> --json` when a schema 3 envelope is more useful than the raw preset object.
Imports also accept HTTPS URLs with bounded downloads and guarded redirects; remote receipts identify only scheme, host and port, while the request uses the complete URL.

```bash
tonedial set "safeword=plain answer please"
tonedial set speech_level=polite    # auto (default) | polite | plain
tonedial set persona.user="I maintain services and prefer direct trade-offs"
tonedial set persona.agent="A fictional SRE specialist with 12 years' experience; speaks plainly"
tonedial address "guide" "friend"  # self and user; bare address asks for both
tonedial set language=ko           # en | ko; init also accepts --lang
tonedial set persona.user= persona.agent=  # empty values clear either description
tonedial set "persona.note="       # the note keeps its existing behavior
```

Persona fields are `self_ref`, `user_ref`, `age`, `gender`, `user`, `agent` and `note` under
`persona.`. `persona.user` describes the user's work, preferences or context. `persona.agent`
describes a fictional specialist role, experience and manner; it does not verify credentials or
grant a capability.
Age accepts `unspecified`, `teens`, `20s`, `30s`, `40s`, `50s+` or a number stored as a band; gender accepts `unspecified`, `masculine`, `feminine` or `neutral`.
Persona and safeword start unset; empty values clear them.
Persona has no fixed anchors: the requested order is axes, persona, then model defaults, and `show` warns when unanchored persona fields are set.
Each new role description accepts at most 200 Unicode code points and rejects longer input before
a write. Whitespace-only input clears it, while the literal `unspecified` remains a value.
`use` restores descriptions saved in a schema-2 profile, including unset values; `reset` preserves the current descriptions.
`save` captures them and `export` includes them in the profile JSON.
To add or change a role on the current tone, run `set persona.agent="..."`.
It preserves all axes and recompiles `TONE.md` immediately; use `save` to update the selected profile.
The compact `show` view reports whether each description is set; `show --verbose` displays the
wrapped text.
Explicit machine config results and file-review diffs can include the descriptions; native
`test --json` and `test --dry-run` plans omit the injected prompt.
The output-style header states the intended scope; it does not filter role text by meaning
or guarantee that a model keeps it out of answer content. Host task and permission rules remain in force.
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
Primary human receipts use one frame: title, scope or result, blank-separated detail groups, then a separate next action.
`show` combines title and artifact size on one row to keep its normal preview within 24 rows.
The interactive dial owns its live title and controls; `export` stays raw, help keeps its reference layout and `--json` keeps its machine envelope.
There is no saved width setting or universal output cap.
`fixed_width` and `guards` are not active settings. Assignments fail without writes; valid boolean values have no effect and are removed only by an authorized canonical write.
Read-only inspection preserves their bytes; malformed values require diagnosis or disclosed recovery.

## Connecting an agent

Installation alone creates no state, hook, skill or shell setup.
Select `codex`, `claude`, `antigravity`, a comma-separated list, or `none` for state-only setup:

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

For Antigravity IDE/Desktop globally, preview and then apply the connection:

```bash
tonedial init --tools antigravity --global --dry-run --json
tonedial init --tools antigravity --global
```

For the current project, preview and then apply the project connection:

```bash
tonedial init --tools antigravity --here --dry-run --json
tonedial init --tools antigravity --here
```

`init`, `wire`, `doctor`, `unwire` and `eject` default to global wiring.
`--global` names it explicitly, `--here` selects the current project, and `--project <dir>` selects another directory; the three cannot be combined and `--project .` equals `--here`.
Use the same scope when inspecting, repairing or removing a connection.
Scope changes wiring destinations, never the shared dial or preset library.
`use <slug> --project <dir>` is a separate `.tonedial/TONE.md` export, not wiring; `test --project` selects its conversation folder.

Setup merges owned native hook entries into the selected host's supported hook file, preserving unrelated handlers.
Codex and Claude use a `SessionStart` entry in `.codex/hooks.json` or `.claude/settings.json`.
Antigravity IDE/Desktop uses one named `tonedial` hook with a direct `PreInvocation` command list in `.agents/hooks.json` for a project or `~/.gemini/config/hooks.json` globally.
Its hook emits `injectSteps[].ephemeralMessage`; the shared skill is linked at `.agents/skills/tonedial` for a project or `~/.gemini/config/skills/tonedial` globally.
In Antigravity IDE, review the hook in the agent panel `… → Customizations → Hooks`; in Antigravity Desktop, use `Settings → Customizations → Hooks`.
`~/.gemini/antigravity-ide/` and `~/.gemini/antigravity/` hold app data and are not hook locations.
`init --commands` also installs Claude's optional `/tone` command and requires `claude` in the selection.
Local setup does not configure remote or cloud runtimes.

Setup and native changes are previewed and approved; `--verbose` shows the diff and `--dry-run` writes nothing.
`--auto` approves the plan but never chooses tools by detection.
Unattended setup requires explicit tools, and ordinary unattended connection writes require an explicit scope, including state-only init and `doctor --fix`.
Read-only doctor, dry runs and operation-ID rollback retain their scope exceptions.
Changed or ambiguous resources are preserved as foreign.
Scoped `unwire <tool>` or `eject` keeps shared state, presets, the installed CLI, shell PATH and other consumers/scopes.

Configuration, a runnable reader, host trust, hook activation, delivered context and model adherence are separate observations.
`doctor` checks configuration and controlled reader health, not native activation; activation remains unverified.
Its human report always names the selected global or project scope and directory, including without `--verbose`.
Registered connections outside that scope are grouped by scope and directory, with agents sharing a file status on one line.
A missing-file status means some or all registered connection files could not be found; it does not mean no connection was ever registered.
Those entries are presence checks only, and `--fix` leaves them alone.
For each group with missing files, run the displayed read-only `doctor` command to keep using the connections,
or run `eject` if they are no longer needed; neither command runs automatically.
The optional `eject` command disconnects every agent in that displayed scope, including any with files still present;
use `unwire <tool>` with the same scope to disconnect only one agent.
The same status-and-guidance layout covers Claude, Codex and connected Antigravity IDE/Desktop routes.
Unimplemented targets do not appear as connections or hook observations.
`hookSettings` in JSON carries each tool's `state` (`enabled`, `disabled`, `unknown`), `basis`, and inspected `path`.
Claude is enabled in its registered settings file when `disableAllHooks` is absent or false, and disabled there when true; invalid values remain unknown.
For Antigravity, `tonedial.enabled` omitted or set to `true` means enabled in the registered file;
`false` means disabled, and any other value type is unknown. This file-level observation does not
resolve other settings, administrator policy, workspace trust or session options.
Actual host activation remains unverified; use the IDE or Desktop Hooks screen to confirm it.
Claude and Codex use a SessionStart hook for automatic delivery and `UserPromptSubmit` for turn refresh, without adding a TONE.md import to their home instruction files.
Antigravity uses a named `tonedial` `PreInvocation` hook for automatic delivery, without adding a TONE.md import to a home instruction file.
These observations never change settings or certify session execution.
Codex trust evidence may be disabled or unknown, and a saved approval hash does not establish current trust.
In Codex, open `/hooks`, select `SessionStart`, then ToneDial; review the command and enable the hook.
In Antigravity IDE, open the agent panel `… → Customizations → Hooks`; in Antigravity Desktop, open `Settings → Customizations → Hooks`.
Confirm the `tonedial` hook is enabled in the selected host. Its project and global hook files are `.agents/hooks.json` and `~/.gemini/config/hooks.json`; the app data directories are not hook locations.
ToneDial never grants trust.
Shared skill discovery can expose the skill to a provider without installing its automatic hook.
Use [TESTING.md](./TESTING.md) for qualification and the [release gate](../scripts/check-release.mjs) for release checks.

## Hook refresh and bounded style feedback

Supported native integrations refresh the current tone at their configured turn events. Claude and
Codex inject the current managed instructions on `UserPromptSubmit`. Their `Stop` path may inspect
response content and issue at most one style-only feedback request for that response. The feedback is
a native continuation, so it can add model usage and provider history; it does not repeat completed
tool work and cannot silently replace the first answer already displayed.

Antigravity's `PreInvocation` route refreshes before an invocation. ToneDial has no verified final
response body on that route, so it does not provide `Stop` feedback there. Hook configuration and a
compiled `TONE.md` show wiring, not actual host activation or model adherence.

Stop checks are length/presentation heuristics, not semantic character validation. Missing or
slow input, malformed metadata and recognized data/code payloads receive no feedback. Ambiguous
data-like prose may also skip correction. Feedback preserves a safeword release and task-required
formats only as instructions to the agent; model adherence still needs a native trial.

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
Generated skill and optional `/tone` flows require CLI JSON schema 3; a CLI with another schema requires a user-operated update.

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

Application rebuild preserves valid saved settings, unsaved tone changes and custom profiles while replacing generated files.
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
| `save [display name]` | Save the current tone profile; bare updates the selected user profile |
| `create [display name] [key=value …]` | Guide preset creation; `--slug` chooses its identifier; save and apply after approval |
| `list` | List presets; `--verbose` adds axis values |
| `export <slug>` / `import <file-or-https-url>` | Back up or transfer full profile JSON |
| `edit [preset <slug>]` | Open config/preset in the selected editor; `--dry-run` previews |
| `init` | Set up state or rebuild generated app files; optionally select native tools |
| `wire [tool]` / `unwire [tool]` | Connect/disconnect a tool in the selected scope |
| `doctor` | Diagnose; `--fix` rebuilds, `--fix --rollback <id>` restores an operation |
| `eject` | Disconnect the selected scope, preserving shared state |
| `compile` | Rebuild `TONE.md` from saved settings for repair; `--check` inspects without writes |
| `test [claude|codex]` | Fresh conversation; `--preset <slug>` previews preset axes; JSON/dry-run launch nothing |
| `update` | Update curl installs; report npm's update command for npm installs |

Every command accepts `--json` and returns integer `schema: 3` envelopes, including version and errors.
Ordinary tone changes already compile automatically; `compile` is for a missing or stale artifact,
and `compile --check --json` supplies the paths used by the skill's explicit session reload.
Persisted config stays schema 2; bundled and custom profiles use preset schema 2; older schema 1 remains supported and operation formats are separate.
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
With it, a schema-2 profile supplies axes, persona, note, address, register and safeword.
Older schema-1 presets supply axes while keeping the current separate settings.
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

The complete preview tone, including persona descriptions and the `note` field, reaches the
client/model and may enter provider history or appear in process arguments under OS access policy.
Keep credentials and private material out of persona fields used here.
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
