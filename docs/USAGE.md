# Using ToneDial

Pick a character, adjust its tone, then save your profile.

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial show
tonedial save "My Sword"
```

**Early preview · Node 24+ · unpublished 0.1.0.**
Start with the [source quickstart](../README.md#try-it); in a checkout, replace `tonedial` with `node dist/bin.js`.
For disposable setup, use the [candidate procedure](./TESTING.md#isolated-candidate).

[Profiles & roles](#presets-and-personal-settings) · [Axes](#tone-and-axes) · [Dial](#the-inline-dial) · [Connect](#connecting-an-agent) · [Reload](#changing-an-open-conversation) · [Recover](#recovery) · [Commands & JSON](#command-reference-and-json) · [Try a conversation](#try-a-fresh-conversation)

## Presets and personal settings

### Pick a relationship

| Profile | You → agent | Korean self / user address |
|---|---|---|
| `caring-brother` | Younger sibling → caring older brother | 형 / 동생 |
| `bratty-kid` | Conversation partner → mischievous kid | 나 / 너 |
| `eager-sycophant` | Creator → overexcited fan | 저 / 작가님 |
| `royal-advisor` | Monarch → loyal subject | 신 / 전하 |
| `ego-sword` | Novice adventurer → sentient sword | 나 / 애송아 |
| `heavenly-demon` | Apprentice → Heavenly Demon | 본좌 / 제자야 |
| `right-hand` | Organization boss → trusted right hand | 저 / 대부님 |

[Hear all seven in Codex](./EXAMPLES.md).
Every bundled profile includes axes, address, persona, register and safeword defaults.
`use` restores the complete profile; language and wiring stay global.

```bash
tonedial list                       # active and custom profiles; --verbose adds axes
tonedial show ego-sword             # preview the saved profile
tonedial show                        # inspect the current settings
tonedial use ego-sword               # replace current tone settings with this profile
```

Bare `show` flags tone settings that have not been saved to a profile and offers a copyable `save` command.
Your settings and `TONE.md` are already persisted; the notice concerns the profile library.
Selecting the same profile again discards those unsaved profile changes.

Built-in address and role defaults use the interface language at selection or preview time.
Changing the interface alone does not rewrite current role text; custom profiles always retain literal text.
Fresh `init` selects the first complete profile.

### Create or save a profile

```bash
tonedial create                      # guided form, then the twelve-axis dial
tonedial save "My Jarvis" --slug my-jarvis
tonedial save                        # update the selected user profile
```

The guided form collects name, slug, self/user address, user context, agent role, register and safeword.
It starts with current settings, filling missing address/description values with editable neutral defaults.
Enter keeps a displayed value; `""` clears an optional field, including suggested addresses during `init`.
Each role description allows **200 Unicode code points**, including spaces and punctuation.
Invalid fields retry without discarding earlier answers.

After the dial, review the file changes, profile name, addresses and descriptions, then approve once to save and apply.
Esc in the dial or declining approval leaves settings and the library unchanged.
`create` refuses an existing slug; `save` updates user profiles.
Bare `save` keeps the selected user profile's name and slug; a bundled or unset selection needs a new display name.
Use `--slug` to choose an identifier separately from the name, including for Korean names.

For scripted creation:

```bash
tonedial create "My Jarvis" --slug my-jarvis warmth=3 \
  persona.agent="A fictional SRE specialist; speaks plainly" --auto
tonedial create "Another Jarvis" --slug another-jarvis warmth=3 --dry-run --json
```

JSON and dry-run never ask questions: provide the name and desired assignments.
`--auto` supplies approval without hiding the file preview; `created: true` confirms a write.

### Set address, roles and language

```bash
tonedial address "guide" "friend"    # self / user; bare address asks for both
tonedial set persona.user="I maintain services and prefer direct trade-offs"
tonedial set persona.agent="A fictional SRE specialist with 12 years' experience; speaks plainly"
tonedial set speech_level=polite      # auto (default) | polite | plain
tonedial set "safeword=plain answer please"
tonedial set language=ko              # en | ko | ja | zh (Simplified) | es
tonedial save                         # also update the selected user profile
```

`set persona.agent="..."` adds a role to the current tone, preserves axes and recompiles immediately.
`show` reports whether descriptions are set; `show --verbose` displays their wrapped text.

| Setting | Meaning | Clearing / limits |
|---|---|---|
| `persona.self_ref`, `persona.user_ref` | Self and user address | Empty assignment clears |
| `persona.user` | User work, preferences or context | 200 code points; empty/whitespace clears |
| `persona.agent` | Fictional role, experience and manner | 200 code points; credentials and capabilities remain unverified |
| `persona.age` | Age band | `unspecified`, `teens`, `20s`, `30s`, `40s`, `50s+`, or a number stored as a band |
| `persona.gender` | Gender presentation | `unspecified`, `masculine`, `feminine`, `neutral` |
| `persona.note` | Additional persona text | Existing free-text behavior; empty assignment clears |
| `speech_level` | Honorific address forms | `auto`, `polite`, `plain` |
| `safeword` | Request one plain answer | Empty assignment clears; grants no permission |
| `language` | CLI interface | `en`, `ko`, `ja`, `zh`, `es`; `init` also accepts `--lang` |

```bash
tonedial set persona.user= persona.agent=  # clear either description
tonedial set "persona.note="
```

Long descriptions are rejected before writing, never truncated; literal `unspecified` remains text.
Persona and safeword begin unset before profile defaults are applied.
Axes take precedence over unanchored persona text, then model defaults; `show` warns when persona fields are set.
The output-style header requests this scope but does not filter role meaning or guarantee it stays out of answer content.
Explicit config JSON and review diffs can contain the descriptions; native test plans omit the injected prompt.

`speech_level` chooses address forms; `formality` changes wording and distance within them.
Auto adapts to the relationship/scene between replies and requests consistent forms within each reply.
Familiar polite, formal plain and affectionate swearing remain valid: warmth and profanity are independent.
These are prompt requests, not measured adherence.

### Make the character louder

| `playfulness` | Requested role language |
|---|---|
| 1 | Literal wording with the selected address |
| 2 | One restrained touch |
| 3 | Two recognizable touches |
| 4 | Frequent idioms in most paragraphs |
| 5 | Exaggerated character idioms throughout, even in short answers |

Courtly phrases such as “아뢰옵기 황송하오나” and underworld metaphors such as “이 함수, 장부에서 지울까요?” stay available.
There is no role-word blacklist or silent substitution; the CLI warns that role language can sound rude or violent.
`profanity` grades swearing and `bravado` grades effort claims independently.
Actual frequency and naturalness require model measurements.

### Move or back up a profile

```bash
tonedial export my-jarvis > my-jarvis.json
tonedial import my-jarvis.json
tonedial use my-jarvis
```

Export/import carries the full profile, including address, descriptions and persona notes.
Import saves without activating; follow it with `use` to apply it.
`export <slug> --json` adds the schema-3 envelope around the raw preset object.
HTTPS imports use bounded downloads and guarded redirects.
Receipts identify only scheme, host and port; the request uses the full URL.

<details>
<summary>Older profiles and retired presets</summary>

Current bundled and custom profiles use preset schema 2.
Schema-1 profiles contain axes only and preserve current separate settings when applied.
Tough Love and Terse Operator are retired from the menu; their old slugs still resolve.
Custom and flat user definitions take precedence over historical axes, and modified retired caches remain readable.
Saving a retired cache creates a custom profile while preserving the original cache bytes and mode.

</details>

## Tone and axes

All twelve axes remain selectable at levels 1–5 and are emitted from one English anchor set.
The agent can answer in the conversation's language; the CLI language does not translate the anchors.
Compilation is local and deterministic, with no model call.

| Group | Axis | Default | 1 → 5 |
|---|---|---|---|
| form | `formality` | 3 | familiar wording and distance → ceremonial, deferential wording |
| form | `verbosity` | 3 | result in 1–2 sentences → deep explanation within the requested scope |
| form | `profanity` | **1** | no swearing; role slang available → strong profanity throughout |
| form | `playfulness` | 3 | literal wording → exaggerated character idioms throughout |
| target | `critique` | 3 | neutral defect observations → vivid, unsparing criticism |
| target | `flattery` | **1** | no praise → four positive remarks, even about small choices |
| target | `warmth` | 3 | no greeting or encouragement → four warm acknowledgements with encouragement and empathy |
| behaviour | `conviction` | 3 | list options and ask → state one recommendation as the decision |
| behaviour | `care` | 3 | requested result only → follow-up, backup, rest and useful organization |
| behaviour | `compliance` | 3 | question once, then act → act immediately without compliance commentary |
| behaviour | `refusal` | **1** | no refusal or delay → visible strike until coaxed or released by the safeword |
| behaviour | `bravado` | **1** | no exaggeration → boastful expert persona by default |

The four bold defaults have a natural floor of 1; setting everything to 3 activates them.
Endpoints describe requests, not measured model behavior.

```bash
tonedial show --explain
tonedial set warmth=5 critique=4
tonedial reset warmth              # one axis to its default
tonedial reset                     # all axes to their defaults
```

`reset` preserves persona, safeword and other settings.
It neither disables delivery nor unloads context; there is no persistent tone-off switch.
The safeword requests one plain answer without persona, flattery or jokes, then the saved tone resumes.
It authorizes no action and may not be followed by the model.
ToneDial adds no factuality, visible-refusal, flattery-honesty or emergency-register guard; host permissions and file-change consent still apply.

### Combining axes

| Selection | Requested result |
|---|---|
| `verbosity=1 care=1` | Only the requested result, in 1–2 sentences |
| `verbosity=1 care=5` | Brief organized items with relevant follow-up, backup and rest |
| `verbosity=5 care=1` | Deep explanation of the requested answer, without a wider task |

`care` controls coverage, organization and functional presentation.
At 5 it requests status emoji and compact items, using tables where comparisons benefit.
Low care minimizes decoration; verbosity limits explanation and item length; warmth controls emotional emoji.
Required task formats and code blocks remain intact.

`show` marks deviations; `show --explain` describes settings and advisory risks.
Red levels and a color-independent `!` start at `profanity=4`, `critique=4`, `flattery=3`, `conviction=5`, `compliance=5`, `refusal=2` and `bravado=2`.
They never clamp values, block a setting or add approval requirements.

<details>
<summary>Artifact size and budget</summary>

`TONE.md` targets 1,800 Unicode code points and warns above a 2,700-character budget.
The two role descriptions contribute at most 400 code points before labels/wrappers.
Neither is silently shortened; notes, addresses and safeword have no global bound.

Representative sizes with other persona fields and safeword unset:

| Input | Code points, including wrappers/whitespace |
|---|---|
| Default axes, no persona | 1,539 |
| Default axes, both descriptions at 200 | 2,316 |
| All axes at 5, both descriptions at 200 | 3,034; warning |

These are generated-size observations, not a whole-config maximum or adherence evidence.
Mutation receipts show generated/current status; `--verbose` adds the numeric size.
`show` and `compile` include it by default; diagnosis uses `doctor --verbose` or `doctor --json`.

</details>

## The inline dial

Bare `tonedial set` opens the inline preview with pending changes and selected-axis hints.

| Key | Action |
|---|---|
| ↑/↓ or `j/k`, Tab | Select an axis |
| ←/→ or `h/l`, `1`–`5` | Change the selected level |
| `?` | Help |
| Enter | Apply |
| Esc, `q`, Ctrl+C | Discard |

The full preview needs **60 columns × 24 rows**; help and too-small views cannot edit/apply hidden values.
Raw input and cursor state are restored on exit, handled signals and stream errors, including suspend/resume.
Resize may leave previous rows in scrollback.
Unsupported `--full-screen` refuses before writing.

<details>
<summary>Output layout, color and retired settings</summary>

Human output measures stdout/stderr separately and stacks detail in narrower terminals.
Unknown width uses a 100-cell prose fallback; non-terminal output is linear, non-animated and non-prompting.
Paths, commands, JSON and exports remain intact; displays escape controls without changing stored values.
`--color=auto|always|never` overrides the environment; otherwise `NO_COLOR` beats `FORCE_COLOR`.

Primary receipts group title, scope/result and detail, then show a separate next action.
`show` puts title and artifact size on one row to fit its normal preview within 24 rows.
The dial owns live controls; export stays raw, help stays a reference, and JSON keeps its envelope.
There is no saved width or universal output cap.

`fixed_width` and `guards` are inactive: assignments fail without writes.
Valid legacy booleans have no effect and are removed only by an authorized canonical write.
Read-only inspection preserves bytes; malformed values need diagnosis or disclosed recovery.

</details>

## Connecting an agent

Installation alone creates no state, hook, skill or shell setup.
Choose `codex`, `claude`, `antigravity`, a comma-separated list, or `none`.

### Preview, then connect

```bash
tonedial init --tools codex --here --dry-run --json
tonedial init --tools codex --here
tonedial doctor --here
```

The plan writes nothing and launches no provider.
Review proposed file changes before approving; `--verbose` includes the diff and `--auto` supplies approval without hiding the plan.
Local setup does not configure remote/cloud runtimes.

| Scope | Selection |
|---|---|
| Global (default) | `--global` |
| Current project | `--here` |
| Another project | `--project <dir>`; `--project .` equals `--here` |

Scope flags are mutually exclusive.
Use the same scope for `init`, `wire`, `doctor`, `unwire` and `eject`.
The scope chooses wiring destinations, not another tone or profile library.
`use --project` instead exports `.tonedial/TONE.md`; `test --project` selects a conversation folder.

For state only, without a native connection:

```bash
tonedial init --tools none --global --auto --json
tonedial set persona.user_ref=friend --json
tonedial set speech_level=polite --json
tonedial set "safeword=plain answer please" --json
tonedial show --json
```

Unattended setup needs explicit tools; ordinary unattended connection writes also need explicit scope, including state-only init and `doctor --fix`.
Read-only doctor, dry runs and operation-ID rollback retain their scope exceptions.
`--auto` never chooses tools by detection; JSON never prompts.

### Native routes

| Host | Hook files: project / global | Delivery |
|---|---|---|
| Codex | `.codex/hooks.json` / `~/.codex/hooks.json` | `SessionStart` + `UserPromptSubmit` refresh |
| Claude Code | `.claude/settings.json` / `~/.claude/settings.json` | `SessionStart` + `UserPromptSubmit` refresh |
| Antigravity IDE/Desktop | `.agents/hooks.json` / `~/.gemini/config/hooks.json` | Named `tonedial` hook with direct `PreInvocation` commands; JSON `injectSteps[].ephemeralMessage` |

Delivery reads the managed `AGENTS.md` guide before `TONE.md` from the same state root.
Tone changes regenerate the artifact without rewriting the guide.
Setup merges owned entries and preserves unrelated handlers; no home instruction-file import is added.
Antigravity's skill link is `.agents/skills/tonedial` in a project or `~/.gemini/config/skills/tonedial` globally.
Its `~/.gemini/antigravity-ide/` and `~/.gemini/antigravity/` app-data directories are not hook locations.
`init --commands` adds Claude's optional `/tone` command and requires Claude in the selection.

### Review host enablement

| Host | Where to review |
|---|---|
| Codex | `/hooks` → `SessionStart` → ToneDial; review the command and enable the hook |
| Antigravity IDE | Agent panel `… → Customizations → Hooks` |
| Antigravity Desktop | `Settings → Customizations → Hooks` |

ToneDial never grants trust; a saved approval hash does not establish current Codex trust.
Skill discovery can expose the skill without installing its automatic hook.
Configuration, reader health, trust, activation, delivered context and model adherence are separate observations.
**`doctor` checks configuration and controlled reader health; actual native activation remains unverified.**
Use [actual-host trials](./TESTING.md#actual-host-and-one-day-trial) for delivery evidence and the [release gate](../scripts/check-release.mjs) for release checks.

<details>
<summary>Doctor connection and enablement details</summary>

Human diagnosis always shows the selected scope/directory, without needing `--verbose`.
Other registered connections are grouped by scope/directory and shared file status.
Missing files mean some or all recorded files were absent, not that no connection was registered.
These are presence checks; `--fix` leaves other scopes alone.
Use the displayed read-only `doctor` command to inspect them, or `eject` if no longer needed.
Eject disconnects every agent in that displayed scope, including those with present files; use scoped `unwire <tool>` for one.
Unimplemented targets do not appear as connections or hook observations.

JSON `hookSettings` records each tool's `state` (`enabled`, `disabled`, `unknown`), `basis` and inspected `path`.
Claude's registered file is enabled when `disableAllHooks` is absent/false, disabled when true and unknown for invalid values.
Antigravity's `tonedial.enabled` is enabled when absent/true, disabled when false and unknown for other types.
These file-level observations do not resolve administrator policy, other settings, trust or session options, change settings or certify execution.
Confirm actual Antigravity enablement in the selected IDE/Desktop Hooks screen.

</details>

### Disconnect

```bash
tonedial unwire codex --here
tonedial eject --here
```

Removal preserves shared state, profiles, CLI, shell PATH, other scopes/consumers and changed or ambiguous foreign resources.

## Hook refresh and bounded style feedback

Claude/Codex refresh current instructions at `UserPromptSubmit`.
Their `Stop` path may inspect the response and request **at most one style-only continuation** per response.
That continuation can add usage/history; it cannot silently replace the first displayed answer and does not repeat completed tool work.

Antigravity refreshes at `PreInvocation`; no verified final response body exists on that route, so it has no `Stop` feedback.
Checks are length/presentation heuristics, not semantic character validation.
Missing/slow input, malformed metadata, recognized data/code and some ambiguous data-like prose skip feedback.
Safeword release and required formats are preserved as instructions, not guaranteed model behavior.
Wiring and a compiled artifact prove neither activation nor adherence.

## Changing an open conversation

Use the generated skill as `/tonedial` where the host exposes it as a command; otherwise ask in ordinary language.

```text
/tonedial drop the flattery
/tonedial be blunter about the code
/tonedial reload the current settings
```

The skill saves through the CLI, runs `compile --check --json`, then reads `AGENTS.md` followed by `TONE.md`.
Reload changes no setting, runs no lifecycle hook and reaches only this conversation.
A settings question reports state without reading the pair.
Open conversations retain existing context until reload; new ones depend on their delivery route.
Save success and a later read failure are reported separately.
Skill discovery remains unverified; `TONE.md` includes a CLI fallback.
The generated skill and optional `/tone` require CLI JSON schema 3; other schemas need a user-operated update.

Package updates do not refresh installed generated skill sources.
Refresh with the **existing** tools/scope, previewing before approval:

```bash
tonedial init --tools codex --global --dry-run --verbose
tonedial init --tools codex --global
tonedial doctor --global --verbose
```

Approved existing-state init and `doctor --fix` rebuild generated families and privately retain replaced entries.
Foreign provider files/external skill links stay protected.
State-only setup adds no native resources; recovery can restore missing companions of present or recorded runtime families.

## State and recovery

State-root precedence: **`TONEDIAL_HOME` → `$XDG_CONFIG_HOME/tonedial` → `~/.tonedial`**.
Use a real directory for writes/recovery; a symlink root is unsupported.
Moving an installed curl root breaks command/PATH references and is not repair.

| Stored content | Location in the state root |
|---|---|
| Settings and compiled instructions | `config.json`, `AGENTS.md`, `TONE.md` |
| Profiles | `presets/builtin/`, `presets/custom/`, older flat user presets |
| Recovery evidence | Operation records and originals |
| Native setup | Generated reader/skill files |
| Curl installation | Package in `lib/`, shim in `bin/` |

<details>
<summary>Other environment variables</summary>

| Variable | Purpose |
|---|---|
| `VISUAL`, then `EDITOR` | Editor selection |
| `COLUMNS` | Fallback for unmeasured width |
| `LC_ALL`, `LC_MESSAGES`, `LANG` | First-init interface detection |
| `TONEDIAL_AGENT_HOME` | Wiring-destination override even with scope flags; not a host profile setting |
| `SHELL` | Curl PATH syntax |
| `TONEDIAL_REGISTRY` | Install/update registry |
| `TMPDIR` | Private installation staging |

</details>

### Recovery

Use the installed command and the same state root as native delivery.
Diagnose, preview, then approve:

```bash
tonedial doctor --global --json
tonedial doctor --fix --global --dry-run --json
tonedial doctor --fix --global
tonedial list --json
tonedial show --json
```

Rebuild replaces generated files while preserving valid settings, unsaved profile changes and custom profiles.
Healthy profiles remain listable/exportable with damaged config; one bad profile does not hide others.
Flat user presets stay readable; conflicts receive a reported recovered copy without overwriting originals.

| Missing information | Explicit source |
|---|---|
| Axes | `--from-preset <slug>` |
| Available saved values | `--from-operation <id>` from a validated same-root operation; current valid fields win |
| A missing/invalid user profile | Add `--restore-preset <slug>` with the operation source; retain its damaged preimage |
| Other values | Disclosed defaults |

Review native attention separately; explicitly select tools when adding/reconciling a route.
Keep rollback IDs and originals.
If both native and app phases changed files, roll back **native first, then app**, using each reported ID:

```bash
printf 'Reported mutation operation ID: '
read -r operation_id
tonedial doctor --fix --rollback "$operation_id" --dry-run
tonedial doctor --fix --rollback "$operation_id"
```

Rollback uses recorded paths in the same root, not a scope destination.
It restores bytes/modes only while evidence matches; changed targets and ambiguous/live owners stay protected.
Unreadable config does not prevent operation-ID rollback.
Never delete a lock to force eligibility or delete the state root to repair an update.
Any `operations.lock` entry suppresses native reader delivery; removing it externally may leave a pending journal only doctor diagnoses.

<details>
<summary>If the command itself cannot run</summary>

Package and application repair are separate.
Npm users reinstall/update through npm, then use `doctor --fix`; ToneDial never spawns npm.
Curl users run a fresh `install.sh --repair` at the same root, retain program archives and approve required component/source choices.
Unknown components stay protected without their named archive choice; retry failed state repair with the new command.
Curl PATH repair covers only the recorded global profile/owned region; changed/foreign content is protected and npm owns its PATH setup.
See [candidate checks](./TESTING.md#isolated-candidate) for installation recovery limits.

</details>

## Command reference and JSON

Bare `tonedial` shows first-use help without initializing state.
Use `--help`, `<command> --help` or `--verbose` (`-v`) for details.
Successful tone mutations recompile in the same action.

| Command | Purpose |
|---|---|
| `set <axis>=<level> …` | Change axes/settings; bare opens the dial |
| `address [self user]` | Set address; bare asks for both |
| `reset [axis]` | Restore one/all axes; keep other settings |
| `show [slug]` | Inspect current/saved tone; `--explain` adds settings/risks |
| `use <slug>` | Apply a profile; `--project <dir>` also exports the artifact |
| `save [display name]` | Save current profile; bare updates the selected user profile |
| `create [display name] [key=value …]` | Create/apply after approval; `--slug` selects the identifier |
| `list` | List profiles; `--verbose` adds axis values |
| `export <slug>` / `import <file-or-https-url>` | Transfer complete profiles |
| `edit [preset <slug>]` | Open config/profile in the editor; `--dry-run` previews |
| `init` | Initialize/rebuild app files; optionally connect tools |
| `wire [tool]` / `unwire [tool]` | Connect/disconnect in the selected scope |
| `doctor` | Diagnose; `--fix` rebuilds; `--fix --rollback <id>` restores an operation |
| `eject` | Disconnect a scope; retain shared state |
| `compile` | Repair missing/stale `TONE.md`; `--check` inspects without writes |
| `test [claude\|codex]` | Fresh preview; `--preset` selects a profile; JSON/dry-run launch nothing |
| `update` | Update curl installs or show npm's update command |

Ordinary changes compile automatically; `compile --check --json` also supplies reload paths.

| Machine contract | Behavior |
|---|---|
| Envelope | Every command accepts `--json`; integer `schema: 3`, including version/errors |
| Stored schemas | Config 2; preset 2 with legacy 1 support; operation formats separate |
| Streams | JSON stdout has no terminal escapes or ToneDial prompts/provider handoff |
| Export | Plain is raw preset JSON; `--json` wraps it |
| Show | Includes `riskAxes`, `riskThresholds`; no unsupported guard/ceiling/width fields |
| Compile check | Human: current/stale/missing; JSON: size and absolute `agentsPath`/`path`, not existence/delivery proof |
| Explicit editor | `edit --json` still launches the requested editor; live output uses stderr |

`edit` refuses to apply config if the wiring ownership graph changes or cannot be proved unchanged, including invalid JSON.
Live config/artifact/native files remain intact; an extant edited copy is privately retained at its reported temp path.
Change ownership through scoped disconnect or approved setup/recovery.

## Try a fresh conversation

```bash
tonedial test codex --preset my-jarvis
tonedial test claude
tonedial test codex --project .       # current existing folder
tonedial test codex --accept-usage    # accept usage/charges for this launch
tonedial test claude --json           # plan only; executable still required
```

**Uses your installed client, normal authentication and account usage/history.**
The notice covers tokens, charges and possibly excessive reasoning/explanation before provider selection.
Enter `y` to accept; Enter or `n` cancels.
`--accept-usage` skips consent only for this launch and never persists it.

| Choice | Preview input |
|---|---|
| No `--preset` | Current saved settings, including unsaved profile edits |
| Schema-2 profile | Its complete axes, persona/note, address, register and safeword |
| Schema-1 profile | Its axes with current separate settings |
| Provider | One installed client can be selected; two prompt interactively; ambiguous plans need an explicit name |
| Folder | Current directory or existing `--project` directory |

Compilation happens in memory and leaves ToneDial state unchanged.
The opening prompt requests dialogue only and no file changes throughout that folder.
Claude disables built-in tools and denies MCP tools; Codex requests a read-only sandbox without approval escalation.
Claude safe mode and Codex invocation-only hook/doc overrides request exclusion of previous connected ToneDial context.
Only the compiled preview is identified as the tone source.
Managed policy and native support remain independent: **this is not whole-folder OS isolation**.
Native exit status applies; unsupported clients must not retry with weaker restrictions.
See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Complete persona text and `note` reach the client/model and may enter history or process arguments under OS access policy.
Keep credentials/private material out of preview persona fields.
JSON/dry-run prompt nothing, launch/probe no provider and omit the injected prompt.
They still need a named executable on `PATH`, an existing target and readable config; name the provider when both are installed.
This initial-prompt preview proves neither native activation nor model adherence.

## Limits

- Models can interpret, ignore or decline requests at any level; risk markers are not output guarantees or model ceilings.
- This is for fun, not recommended for production: work-state, result and risk statements may contain falsehoods, omissions or exaggeration.
- Config/reader checks establish neither trust, activation, delivered context nor behavior.

Use [TESTING.md](./TESTING.md) for evidence and [CONTRIBUTING.md](../CONTRIBUTING.md) for reproducible reports.

## Current dial example

The README dial is a synthetic 80-column Tough Love preview: warmth moves from 5 to 4, then is discarded.
It uses the current renderer, not a native response; fonts/colors can differ.
Width belongs to the synthetic stream, not a saved setting or runtime option.
See the [media recipes and locale provenance](./media/readme/README.md#dial-images) to regenerate it.

## Installation channels after release

<details>
<summary>Npm/curl commands — not live for this unpublished candidate</summary>

```bash
npm i -g tonedial
curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh
```

Update npm installs with `npm update -g tonedial`; curl installs with `tonedial update`.
`npx` is unsupported: skill/control commands need a durable executable.
Until release, use the [source quickstart](../README.md#try-it).

</details>
