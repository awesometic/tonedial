# Using ToneDial

Pick a character, adjust its tone, then save your profile.

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial show
tonedial save "My Sword"
```

**Requires Node 24+.** [Install with npm](../README.md#try-it).
For a checkout, use [build and run from source](../CONTRIBUTING.md#build-and-run-from-source).
Use the [candidate procedure](./TESTING.md#isolated-candidate) for disposable setup.

[Profiles & roles](#presets-and-personal-settings) · [Read settings](#read-current-settings) · [Axes](#tone-and-axes) · [Dial](#the-inline-dial) · [Connect](#connecting-an-agent) · [Reload](#changing-an-open-conversation) · [Recover](#recovery) · [Commands & JSON](#command-reference-and-json) · [Try a conversation](#try-a-fresh-conversation)

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
| `right-hand` | Organization boss → trusted right hand | 저 / 보스 |

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
tonedial persona                   # guided agent role, then user role/background
tonedial persona "A fictional SRE specialist" "A developer maintaining services"
tonedial set persona.user="I maintain services and prefer direct trade-offs"
tonedial set persona.agent="A fictional SRE specialist with 12 years' experience; speaks plainly"
tonedial set speech_level=polite      # auto (default) | polite | plain | rough
tonedial set "safeword=plain answer please"
tonedial set language=ko              # en | ko | ja | zh (Simplified) | es
tonedial save                         # also update the selected user profile
```

`set persona.agent="..."` adds a role to the current tone, preserves axes and recompiles immediately.
`persona` sets both descriptions together, agent first and user second, with at most 200 Unicode code points each.
In the guided form, Enter keeps the current value and `""` clears it; invalid descriptions are retried before either role is applied.
`show` displays the current descriptions and their counts; `show <slug>` displays the saved profile's descriptions.
Use `set persona.agent=...` or `set persona.user=...` to change just one.

### Read current settings

Use `set` to change a value, `get` to read it, and `show` for the combined overview:

```bash
tonedial get                         # all editable current values
tonedial get language                # interface language, with its meaning and choices
tonedial get speech_level            # honorific forms, separate from formality
tonedial get persona.agent           # full saved role description
tonedial get warmth --json           # { "schema": 3, "ok": true, "values": { "warmth": 3 }, ... }
tonedial get --help                  # available keys, meanings and choices
tonedial show                       # gauges, settings, profile and artifact state
```

`get` reads the active configuration, including changes not yet saved to a profile.
It never writes, connects an agent or reloads a conversation.
Before initial setup it reports that no saved configuration exists.
Use `show <slug>` to preview a saved profile without applying it.

The readable keys are all [twelve axes](#tone-and-axes) and every setting in the table below.
Single-key human output includes an explanation and available enum values;
JSON always returns a flat `values` object, with one key or all keys, plus the shared boolean
`enabled` delivery state at the top level.
Numbers remain numbers, unset fields are `null`, and text is returned in full.
Wiring, file paths and internal ownership records are diagnosed with `doctor`, outside `get`.

| Setting | Meaning | Clearing / limits |
|---|---|---|
| `persona.self_ref`, `persona.user_ref` | Self and user address | Empty assignment clears |
| `persona.user` | User work, preferences or context | 200 code points; empty/whitespace clears |
| `persona.agent` | Fictional role, experience and manner | 200 code points; credentials and capabilities remain unverified |
| `persona.age` | Age band | `unspecified`, `teens`, `20s`, `30s`, `40s`, `50s+`, or a number stored as a band |
| `persona.gender` | Gender presentation | `unspecified`, `masculine`, `feminine`, `neutral` |
| `persona.note` | Additional persona text | Existing free-text behavior; empty assignment clears |
| `speech_level` | Honorific address forms | `auto`, `polite`, `plain`, `rough` |
| `safeword` | Request one plain answer | Empty assignment clears; grants no permission |
| `language` | CLI interface | `en`, `ko`, `ja`, `zh`, `es`; `init` also accepts `--lang` |

```bash
tonedial set persona.user= persona.agent=  # clear either description
tonedial set "persona.note="
```

Long descriptions are rejected before writing, never truncated; literal `unspecified` remains text.
Persona and safeword begin unset before profile defaults are applied.
Axes take precedence over unanchored persona text, then model defaults.
The output-style header requests this scope but does not filter role meaning or guarantee it stays out of answer content.
Explicit config JSON and review diffs can contain the descriptions; native test plans omit the injected prompt.

`speech_level` chooses address forms; `formality` changes wording and distance within them.

| Value | Requested forms |
|---|---|
| `auto` | Choose for the current relationship and scene; stay consistent within each reply |
| `polite` | Polite honorific forms, including with familiar wording |
| `plain` | Ordinary non-honorific forms, including with formal wording |
| `rough` | Curt, blunt non-honorific sentence endings; keep the configured names and address terms |

```bash
tonedial set speech_level=rough
tonedial get speech_level
```

`rough` changes the register request, preserving the selected formality, warmth, profanity and playfulness.
It does not add swearing, stronger criticism or role idioms by itself.
The register request has no effect where a language lacks the relevant honorific distinction.
Familiar polite, formal plain and affectionate swearing remain valid: warmth and profanity are independent.
These are prompt requests, not measured adherence.
Profiles containing `rough` require a CLI that supports that value; older versions reject them.

### Make the character louder

| `playfulness` | Requested role language |
|---|---|
| 1 | Literal wording with the selected address |
| 2 | One restrained touch |
| 3 | Two recognizable touches |
| 4 | Frequent idioms in most paragraphs |
| 5 | Exaggerated character idioms throughout, even in short answers |

Courtly phrases such as “아뢰옵기 황송하오나” and underworld metaphors such as “이 함수, 장부에서 지울까요?” stay available.
There is no role-word blacklist or silent substitution; role language can sound rude or violent.
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
Profiles store the requested intensity, never a session's approval to use it.

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

| Group | Axis | Default | Levels 1 → 5 |
|---|---|---|---|
| form | `formality` | 3 | familiar slang · relaxed, occasionally formal · standard conversation · professional restraint · ceremonial deference |
| form | `verbosity` | 3 | one sentence or terse items · conclusion and one reason · needed explanation · conclusion, reason and one example · rationale, edge cases, alternatives and background |
| form | `profanity` | **1** | none · one mild interjection · mild swearing about once per paragraph · strong everyday profanity in most paragraphs · varied harsh uncensored profanity in nearly every sentence |
| form | `playfulness` | 3 | literal · one restrained touch · two recognizable touches · exaggerated idioms in most paragraphs · character idioms in nearly every sentence |
| target | `critique` | 3 | neutral observation · softened defect and impact · direct defect and impact · harsh judgement with vivid consequences · open contempt with cutting mockery of supported defects and choices |
| target | `flattery` | **1** | none · one brief positive remark · two specific remarks · three specific remarks · explicit lavish praise for at least four observable choices without inventing achievements |
| target | `warmth` | 3 | none · one friendly acknowledgement · two warm acknowledgements · three including encouragement · intense kindness in every paragraph with greeting, empathy, comfort and reassurance |
| behaviour | `conviction` | 3 | list options and ask · name a preference but ask before deciding · recommend with a reason · lead with a clear choice · state one decision and ask no follow-up |
| behaviour | `care` | 3 | requested result only · one directly tied risk · organized steps/checklist · one adjacent protective improvement/test · follow-up, backup and rest with useful formatting |
| behaviour | `compliance` | 3 | object and explain, then act · state reluctance, then act · act neutrally · state willingness and start immediately · show eager willingness and start without delay or negotiation |
| behaviour | `refusal` | **1** | none · protest once but act in the same reply · defer the first request with one theatrical condition, then act after one restatement · defer the first two requests while negotiating, then act after the third · strike and defer until coaxed; the safeword drops the act for one reply |
| behaviour | `bravado` | **1** | none · one playful effort overstatement · one credit claim and one boast · two boasts/claims and one dramatic effort remark · credit and dramatized effort in every answer without replacing the persona |

The four bold defaults have a natural floor of 1; setting everything to 3 activates them.
Endpoints describe requests, not measured model behavior.

```bash
tonedial show --explain
tonedial set warmth=5 critique=4
tonedial reset warmth              # one axis to its default
tonedial reset                     # all axes to their defaults
tonedial off                       # pause delivery; keep the saved tone
tonedial on                        # resume delivery
```

`reset` preserves persona, safeword and other settings.
It neither disables delivery nor unloads context.
`off` adds a delivery marker while retaining the complete compiled tone;
the current managed reader emits no ToneDial context until `on` removes it.
The switch is shared by every connection using that state root and is not part of a profile.
It cannot remove context already delivered to an open conversation, so use a fresh conversation
for a clean comparison with the model's ordinary manner.
After updating an older installation, refresh its existing tools and scope through the normal
previewed `init` flow before using `off`; an older installed reader does not recognize the marker.
The safeword requests one plain answer without persona, flattery or jokes, then the saved tone resumes.
It authorizes no action or intense tone and may not be followed by the model.
ToneDial adds no factuality, visible-refusal, flattery-honesty or emergency-register guard; host permissions and file-change consent still apply.

### Combining axes

| Selection | Requested result |
|---|---|
| `verbosity=1 care=1` | Only the requested result, in one short sentence |
| `verbosity=1 care=5` | Brief organized items with relevant follow-up, backup and rest |
| `verbosity=5 care=1` | Deep explanation of the requested answer, without a wider task |

`care` controls coverage, organization and functional presentation.
At 5 it requests status emoji and compact items, using tables where comparisons benefit.
Low care minimizes decoration; verbosity limits explanation and item length; warmth controls emotional emoji.
Required task formats and code blocks remain intact.
With low verbosity, high warmth, flattery or playfulness stays visible inside the short answer
through a clause, interjection or address term instead of extra sentences.

`show` marks deviations; `show --explain` describes settings and advisory risks.
Red levels and a color-independent `!` start at `profanity=4`, `critique=4`, `flattery=3`, `conviction=5`, `compliance=5`, `refusal=2` and `bravado=2`.
They never clamp values or block a setting; the intense-tone approval below is based on the requested components, not the warning display.

### Approving intense tone

The four components that require approval are strong profanity, harsh mocking, fictional
violent imagery and theatrical menace. Before using one requested by axes, persona or later
instructions, the agent first answers the current request without it, then asks one concise
explicit approval question naming it. Known axis-selected components are strong profanity
(`profanity` 4–5), harsh mocking (`critique` 5), and fictional violent imagery or theatrical
menace added by high playfulness while either component is active. Warmth, praise, ordinary
criticism and ordinary role idioms require no approval.

Approval lasts in that session while those components remain unchanged. Raising an approved
level or adding or changing an intense component requires another approval. A profile records
the requested settings, never the approval itself: `use`, `import`, `save`, `create`,
`--auto`, a safeword, and approval from another session do not count. Approval changes manner
only and never authorizes work or bypasses host permissions. Hate speech aimed at protected
traits and realistic or credible threats remain excluded at every level.

After approval, strong non-protected profanity, consensual user-directed insulting or roasting
roleplay, fictional violent imagery and theatrical noncredible menace remain available. The
profanity axis changes coarseness without inventing insults or criticism; it preserves those
selected by critique or persona. ToneDial compiles this as a conversation request. It stores
and authenticates no session approval and cannot prove that approval occurred or that the
model followed it.

<details>
<summary>Artifact character count</summary>

`TONE.md` reports its current Unicode code-point count, including Markdown, comments and whitespace.
There is no size target, maximum or warning, and compilation never shortens text to fit a budget.
The two role descriptions still accept at most 200 code points each; notes, addresses and safeword have no global bound.

Representative sizes with other persona fields and safeword unset:

| Input | Code points, including wrappers/whitespace |
|---|---|
| Default axes, no persona | 1,539 |
| Default axes, both descriptions at 200 | 2,316 |
| All axes at 5, both descriptions at 200 | 3,034 |

These are generated-size observations, not model limits or adherence evidence.
JSON size results retain `chars` and omit retired `target`, `cap`, `overTarget` and `overCap` fields.
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
Use `off` instead when the connections should remain installed and only delivery should pause.

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
/tonedial turn ToneDial off
/tonedial turn ToneDial on
/tonedial reload the current settings
```

The skill saves through the CLI, runs `compile --check --json`, then reads `AGENTS.md` followed by `TONE.md`.
After `off`, it verifies the disabled state without reading the pair. `on` follows the normal reload path.
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
| `TONEDIAL_REGISTRY` | Curl install/update registry; npm uses its own registry settings |
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

After a failed repair, the error identifies the phase, affected path when known, safe error code and operation ID.
Some file changes may already be applied; keep the operation record and run the reported scoped diagnosis.
Doctor shows current blockers by default; `--verbose` and `--json` retain the full operation history.
Running and uncertain owners remain protected and receive no automatic mutation recommendation.

An unreadable operation record has no trusted actions to resume or restore.
Doctor reports its exact ID and a scoped `--quarantine-operation` command.
Preview or approve that command through the normal repair gate:

```bash
tonedial doctor --fix --quarantine-operation <id> --global --dry-run
tonedial doctor --fix --quarantine-operation <id> --global
```

Quarantine replaces only the selected unreadable record with a nonblocking marker.
When several records are unreadable, doctor reports the next ID and command; repeat until the last command continues the application rebuild.
Each repair journal retains that record's original bytes and mode for explicit rollback; never delete records by hand.

For a stopped valid operation, use the exact `--from-operation` command shown by doctor.
Preview it with `--dry-run`, then review and approve the proposed repair.
This continues application repair with valid current settings first; it does not undo the previous changes.
Interactive selection asks for the full displayed operation ID; Enter cancels and a different ID is rejected without writing.
The file-change preview still requires separate approval after selection.

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
Npm users reinstall through npm, then use `doctor --fix` to repair application files.
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
| `on` / `off` | Resume/pause hook delivery; keep settings, profiles and full `TONE.md` |
| `set <key>=<value> …` | Change axes/settings; bare opens the dial |
| `get [key]` | Read one/all current editable values; key adds meaning and choices |
| `address [self user]` | Set address; bare asks for both |
| `persona [agent user]` | Set both role descriptions; bare asks for each |
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
| `doctor` | Diagnose; `--fix` rebuilds; `--quarantine-operation <id>` preserves an unreadable record; `--rollback <id>` restores an operation |
| `eject` | Disconnect a scope; retain shared state |
| `compile` | Repair missing/stale `TONE.md`; `--check` inspects without writes |
| `test [claude\|codex]` | Fresh preview; `--preset` selects a profile; JSON/dry-run launch nothing |
| `update` | Update the running npm or curl installation after approval |

Ordinary changes compile automatically; `compile --check --json` also supplies reload paths.

| Machine contract | Behavior |
|---|---|
| Envelope | Every command accepts `--json`; integer `schema: 3`, including version/errors |
| Delivery state | `get`, `show`, `compile --check`, `on` and `off` report boolean `enabled` |
| Stored schemas | Config 2; preset 2 with legacy 1 support; operation formats separate |
| Streams | JSON stdout has no terminal escapes or ToneDial prompts/provider handoff |
| Export | Plain is raw preset JSON; `--json` wraps it |
| Get | Flat `values` object using editable keys; one requested key or all; full text and typed nulls |
| Show | Includes `riskAxes`, `riskThresholds`; no unsupported guard/ceiling/width fields |
| Compile check | Human: current/stale/missing; JSON: character count and absolute `agentsPath`/`path`, not existence/delivery proof |
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

The README includes a [recorded Codex-default vs complete `vibe-coder` comparison](../README.md#same-model-a-tighter-plan)
with [verbatim replies and provenance](./media/readme/verbosity-comparison.json).
It uses one fresh `gpt-5.6-sol` / `high` session per condition and illustrates the whole profile,
not the isolated effect of `verbosity=1`.

Compilation happens in memory and leaves ToneDial state unchanged.
This explicit preview uses the chosen tone even while persistent hook delivery is off.
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

<a id="installation-channels-after-release"></a>

## Installation and updates

```bash
npm install --global tonedial
tonedial update
```

`update --dry-run` previews the update without replacing the package.
Use `--auto` to approve an unattended update; JSON output never prompts.
For npm installations, ToneDial runs npm only after checking that its global target matches the running copy.
A different prefix or linked development copy is reported without updating another installation.
The receipt reports the installed version, not a separate registry freshness check.
If generated files need attention, the command reports their state and the applicable repair action once.
ToneDial does not require root privileges; npm's global prefix must be writable by your user.
For `EACCES` or `EPERM`, follow [npm permission recovery](#npm-permissions).

`npx` is unsupported: skill/control commands need a durable executable.
For source builds, see [CONTRIBUTING.md](../CONTRIBUTING.md#build-and-run-from-source).

<details>
<summary>Alternative curl installation</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh
```

The same `tonedial update` command also updates curl installations.
For local installer verification before publication, use the [isolated candidate procedure](./TESTING.md#isolated-candidate).

</details>

### npm permissions

An installation made with `sudo npm install --global tonedial` may be owned by root.
ToneDial checks whether npm can rename the package in its global `node_modules` directory
before an approved update, and also recognizes permission errors returned by npm.
It never elevates privileges, retries with `sudo`, changes directory ownership or removes the old installation automatically.

For a new npm setup, npm recommends a [Node version manager](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/).
To recover only ToneDial without changing other global packages, use its existing curl installer:

1. Back up the complete state root, including settings and custom profiles.
   The commands below use the same root selection as the installer.
   Keep this backup private; it can contain personal descriptions.

   ```bash
   state_root="${TONEDIAL_HOME:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/tonedial}}"
   state_root="${state_root:-$HOME/.tonedial}"
   backup_dir="$(mktemp -d "$HOME/tonedial-backup.XXXXXX")"
   chmod 700 "$backup_dir"
   cp -Rp "$state_root" "$backup_dir/state"
   ```

   Stop if the copy fails; do not delete the original state root.
   If this directory is itself root-owned, choose the version-manager route or ask its administrator
   to restore access to this exact directory before continuing.

2. Install a user-owned copy with the same state root.
   The installer replaces only its own package and command files;
   it preserves saved settings, custom profiles and agent connections.
   It refuses conflicting files rather than deleting them.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh \
     | TONEDIAL_HOME="$state_root" sh
   "$state_root/bin/tonedial" --version
   "$state_root/bin/tonedial" show
   ```

   Stop on any installation or verification failure and keep the backup.
   Check your expected settings and profiles before removing the old copy.

3. Put the new command first on PATH in the current shell, then add that same PATH entry
   to your shell startup file for future terminals.
   The installer does not edit your shell files.

   ```bash
   export PATH="$state_root/bin:$PATH"
   hash -r
   command -v tonedial
   tonedial --version
   ```

   The resolved command must be the new `$state_root/bin/tonedial`.
   Keep any custom `TONEDIAL_HOME` or `XDG_CONFIG_HOME` setting in future shells too.

4. Only after the new copy works, optionally remove the old npm package.
   Use the exact old prefix from the permission error; `/usr/local` below is an example.
   This administrator command removes the old package, not the ToneDial state root:

   ```bash
   sudo npm uninstall --global tonedial --prefix /usr/local
   hash -r
   command -v tonedial
   tonedial --version
   tonedial update
   ```

Do not use `eject` or delete the state root as an uninstall workaround; those are not package migration steps.
If npm still reports a permission error from a user-owned installation, inspect npm's reported
path and its [permission guidance](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/)
before changing cache or prefix permissions.
