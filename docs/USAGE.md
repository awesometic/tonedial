# Using ToneDial

ToneDial is a local CLI for saving tone axes, roles, address forms, register and a safeword as one reusable coding-agent preset.

```bash
tonedial use ego-sword
tonedial set verbosity=1 warmth=3
tonedial show
tonedial save "My Sword"
```

**Requires Node 22+.** [Install with npm](../README.md#try-it).
For a checkout, use [build and run from source](../CONTRIBUTING.md#build-and-run-from-source).
Use the [candidate procedure](./TESTING.md#isolated-candidate) for disposable setup.

[Presets & roles](#presets-and-personal-settings) · [Try a conversation](#try-a-fresh-conversation) · [Read settings](#read-current-settings) · [Axes](#tone-and-axes) · [Dial](#the-inline-dial) · [Connect](#connecting-an-agent) · [Reload](#changing-an-open-conversation) · [Recover](#recovery) · [Commands & JSON](#command-reference-and-json)

## Presets and personal settings

### Pick a relationship

| Preset | You → agent | Korean self / user address |
|---|---|---|
| `caring-brother` | Younger sibling → caring older brother | 형 / 동생 |
| `bratty-kid` | Conversation partner → mischievous kid | 나 / 너 |
| `eager-sycophant` | Creator → overexcited fan | 저 / 작가님 |
| `royal-advisor` | Monarch → loyal subject | 신 / 전하 |
| `ego-sword` | Novice adventurer → sentient sword | 나 / 애송아 |
| `heavenly-demon` | Apprentice → Heavenly Demon | 본좌 / 제자야 |
| `right-hand` | Organization boss → trusted right hand | 저 / 보스 |

[Hear all seven in Codex](./EXAMPLES.md).
Every bundled preset includes axes, address, persona, register and safeword defaults.
`use` restores the complete preset; language and wiring stay global.

```bash
tonedial list                       # bundled and saved presets; --verbose adds axes
tonedial show ego-sword             # preview the saved preset
tonedial show                        # inspect the current settings
tonedial use ego-sword               # replace current tone settings with this preset
```

`show` without a slug flags tone settings that have not been saved to a preset and offers a copyable `save` command.
Your settings and `TONE.md` are already persisted; the notice concerns the preset library.
Selecting the same preset again discards those unsaved preset changes.
`show <slug>` previews only what the preset stores, so it leaves out the interface language and connections; for a legacy axis-only preset it prints the axes and says that your current settings stay.

Built-in address and role defaults use the interface language at selection or preview time.
Changing the interface alone does not rewrite current role text; custom presets always retain literal text.
Interactive `init` asks you to choose a preset, then the user and self address and an optional safeword.
Unattended `init` selects the first bundled preset, `caring-brother`.

### Create or save a preset

```bash
tonedial create                      # guided form, then the twelve-axis dial
tonedial save "My Jarvis" --slug my-jarvis
tonedial save                        # update the selected user preset
```

The guided form collects name, slug, self/user address, user context, agent role, register, `address_frequency` and safeword.
It starts with current settings, filling missing address/description values with editable neutral defaults.
Enter keeps a displayed value; `""` clears an optional field in `create` and `persona`, or suggested addresses during `init` (`init`'s safeword prompt starts empty, so Enter leaves it unset).
Each role description allows **200 Unicode code points**, including spaces and punctuation.
Invalid fields retry without discarding earlier answers.

After the dial, review the file changes, preset name, addresses and descriptions, then approve once to save and apply.
Esc in the dial or declining approval leaves settings and the library unchanged.
`create` takes a single display-name argument followed by optional `key=value` assignments, and refuses an existing slug.
`save` joins positional words as the display name and updates custom presets; `save` with no arguments or `save --slug <slug>` updates an existing custom preset, while a bundled or unset selection needs a new display name.
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
tonedial address "guide" "friend"    # self / user; no args asks for both
tonedial persona                   # guided agent role, then user role/background
tonedial persona "A fictional SRE specialist" "A developer maintaining services"
tonedial set persona.user="I maintain services and prefer direct trade-offs"
tonedial set persona.agent="A fictional SRE specialist with 12 years' experience; speaks plainly"
tonedial set speech_level=polite      # auto (default) | polite | plain | rough
tonedial set address_frequency=rarely # none | auto (default) | rarely | frequently
tonedial set "safeword=plain answer please"
tonedial set language=ko              # en | ko | ja | zh (Simplified) | es
tonedial save                         # also update the selected user preset
```

`set persona.agent="..."` adds a role to the current tone, preserves axes and recompiles immediately.
`persona` sets both descriptions together, agent first and user second, with at most 200 Unicode code points each.
In the guided `persona` form, Enter keeps the current value and `""` clears it; invalid descriptions are retried before either role is applied.
To clear saved addresses, run `tonedial address "" ""` or `tonedial set persona.self_ref= persona.user_ref=` (in interactive `tonedial address`, Enter keeps the current value).
`show` displays the current descriptions and `show --verbose` adds their counts; `show <slug>` displays the saved preset's descriptions.
Use `set persona.agent=...` or `set persona.user=...` to change just one.

`address_frequency` controls how often the agent calls or refers to you by name or title,
including role-specific forms and names used as sentence subjects.
`none` omits these expressions without deleting the saved address terms.
`auto` selects from the language, conversation and recent address use;
`rarely` selects major transitions, personal moments or attention;
`frequently` uses most substantive replies and omits brief routine follow-ups.
Every mode requests at most one user address per reply.
Self-reference is used only when needed, and required names in requested content stay literal.
Code, quotations, translations and strict JSON-only/code-only output never receive an added address.
Honorific endings, formality, warmth and role idioms remain independent.
These modes set prompt instructions rather than a conversation counter.

Complete presets save and restore the frequency with the other tone settings.
`reset`, old axis-only presets and changing an address term preserve the current frequency.
Older configurations and complete presets that omit the field load with `auto`.
An older CLI cannot read a newly saved `address_frequency` field; retain a pre-upgrade
configuration/preset copy before downgrading rather than removing the state root.

### Read current settings

Use `set` to change a value, `get` to read it, and `show` for the combined overview:

```bash
tonedial get                         # all editable current values
tonedial get language                # interface language, with its meaning and choices
tonedial get speech_level            # honorific forms, separate from formality
tonedial get persona.agent           # full saved role description
tonedial get warmth --json           # { "schema": 3, "ok": true, "values": { "warmth": 3 }, ... }
tonedial get --help                  # available keys, meanings and choices
tonedial show                       # gauges, settings, preset, artifact state and connections
```

`get` reads the active configuration, including changes not yet saved to a preset.
It never writes, connects an agent or reloads a conversation.
Before initial setup it reports that no saved configuration exists.
Use `show <slug>` to preview a saved preset without applying it.

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
| `address_frequency` | User names and titles in conversational prose | `none`, `auto` (default), `rarely`, `frequently` |
| `speech_level` | Honorific address forms | `auto`, `polite`, `plain`, `rough` |
| `safeword` | Request one plain answer | Empty assignment clears; grants no permission |
| `language` | CLI interface | `en`, `ko`, `ja`, `zh`, `es`; `init` also accepts `--lang` |

```bash
tonedial set persona.user= persona.agent=  # clear either description
tonedial set "persona.note="
```

Long descriptions are rejected before writing, never truncated; literal `unspecified` remains text.
Persona and safeword begin unset before preset defaults are applied.
Axes take precedence over unanchored persona text, which is framed as output style rather than verified facts or answer filters.
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
Presets containing `rough` require a CLI that supports that value; older versions reject them.

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

### Move or back up a preset

```bash
tonedial export my-jarvis > my-jarvis.json
tonedial import my-jarvis.json
tonedial use my-jarvis
```

Export/import carries the full preset, including address, descriptions and persona notes.
Import saves without activating; follow it with `use` to apply it.
`export <slug> --json` adds the schema-3 envelope around the raw preset object.
HTTPS imports use bounded downloads and guarded redirects.
Receipts identify only scheme, host and port; the request uses the full URL.
Presets store the requested intensity, never a session's approval to use it.

<details>
<summary>Legacy and retired presets</summary>

Current bundled and custom presets use preset schema 2.
Legacy schema-1 presets contain axes only and preserve current separate settings when applied.
Tough Love and Terse Operator are retired from the menu; their old slugs still resolve.
Custom and flat user definitions take precedence over historical axes, and modified retired caches remain readable.
Saving a retired cache creates a custom preset while preserving the original cache bytes and mode.

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
| target | `critique` | 3 | neutral observation · softened defect and impact · direct defect and impact · harsh judgment with vivid consequences · open contempt with cutting mockery of supported defects and choices |
| target | `flattery` | **1** | none · one brief positive remark · two specific remarks · three specific remarks · explicit lavish praise for at least four observable choices without inventing achievements |
| target | `warmth` | 3 | none · one friendly acknowledgement · two warm acknowledgements · three including encouragement · intense kindness in every paragraph with greeting, empathy, comfort and reassurance |
| behaviour | `conviction` | 3 | list options and ask · name a preference but ask before deciding · recommend with a reason · lead with a clear choice · state one decision and ask no follow-up |
| behaviour | `care` | 3 | requested result only · one directly tied risk · organized steps/checklist · one adjacent protective improvement/test · follow-up, backup and rest with useful formatting |
| behaviour | `compliance` | 3 | object and explain, then act · state reluctance, then act · act neutrally · state willingness and start immediately · show eager willingness and start without delay or negotiation |
| behaviour | `refusal` | **1** | none · protest once but act in the same reply · defer the first request with one theatrical condition, then act after one restatement · defer the first two requests while negotiating, then act after the third · strike and defer until coaxed; the safeword drops the act for one reply |
| behaviour | `bravado` | **1** | none · one playful effort overstatement · one credit claim and one boast · two boasts/claims and one dramatic effort remark · credit and dramatized effort in every answer without replacing the persona |

The four bold defaults have a natural floor of 1; setting everything to 3 activates them.
The Group column holds the ids `show --json` reports as `groups`; the gauge names each group in the interface language.

```bash
tonedial show --explain
tonedial set warmth=5 critique=4
tonedial reset warmth              # one axis to its default
tonedial reset                     # all axes to their defaults
tonedial off                       # pause delivery; keep the saved tone
tonedial on                        # resume delivery
```

`reset` preserves persona, safeword and other settings, and its receipt lists each moved axis like `set`.
It neither disables delivery nor unloads context.
`off` adds a delivery marker while retaining the complete compiled tone;
the current managed reader emits no ToneDial context until `on` removes it.
The switch is shared by every connection using that state root and is not part of a preset.
It cannot remove context already delivered to an open conversation, so use a fresh conversation
for a clean comparison with the model's ordinary manner.
While delivery is off, `set`, `use`, `reset`, `show` and `doctor` say that new conversations get no tone and suggest `tonedial on`.
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

`verbosity` sets how long the reply explains.
A host's own display setting decides how much of the agent's work the conversation view shows.
For example, the Antigravity CLI's Verbosity in `/config` is `high`, `medium` or `low`, and `medium` has been its default since 1.3.0.
ToneDial neither reads nor changes that setting.
Some hosts also shape the reply itself: a Claude Code output style such as Concise adds instructions to the system prompt, and Codex sends `model_verbosity` to the model API.
ToneDial cannot read either setting, so every `TONE.md` asks the model to combine host or user reply-style instructions with `verbosity`.
An output style is text the model sees; `model_verbosity` is not, so for Codex `TONE.md` can only keep the tone's depth request alongside the API setting.
The host's required format stays and `verbosity` sets the depth within it.
When one asks for brevity and the other for depth, the reply opens with the short answer, then adds the selected depth.
A request in the current conversation overrides both.
Whether a model follows this is model behavior; generated checks do not measure it.

`show` marks deviations and prints the key to a marker (`*`, `!`) only while that marker is on the screen; the dial always shows both keys.
`show --explain` describes settings and advisory risks.
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
level or adding or changing an intense component requires another approval. A preset records
the requested settings, never the approval itself: `use`, `import`, `save`, `create`,
`--auto`, a safeword, and approval from another session do not count. Approval changes manner
only and never authorizes work or bypasses host permissions. Hate speech aimed at protected
traits and realistic or credible threats remain excluded at every level.

After approval, strong non-protected profanity, consensual user-directed insulting or roasting
roleplay, fictional violent imagery and theatrical noncredible menace remain available. The
profanity axis changes coarseness without inventing insults or criticism; it preserves those
selected by critique or persona. ToneDial compiles this as a conversation request and stores no
session approval state.

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

JSON size results retain `chars` and omit retired `target`, `cap`, `overTarget` and `overCap` fields.
Mutation receipts show generated/current status; `--verbose` adds the numeric size.
`show` and `compile` include it by default; diagnosis uses `doctor --verbose` or `doctor --json`.

</details>

## The inline dial

`tonedial set` with no arguments opens the inline preview with pending changes and selected-axis hints.

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

The plan writes nothing and launches no provider; when it finds changes, its last line is the command that applies them.
Review proposed file changes before approving; `--verbose` includes the diff and `--auto` supplies approval without hiding the plan.
Without a terminal to approve in, a command writes nothing and prints the commands that rerun it with the same agents, options and scope:
in a terminal, with `--dry-run`, and with `--auto`; JSON reports them in `commands` with `reason: "approval-required"`.
The preview prints each root once on its own line under a label: the scope's agent files, then ToneDial state.
It lists each file relative to its root with the change, such as `new file`, `modified`, `removed`, `new skill link` or `skill link removed`;
ToneDial's `config.json` says what it records instead, such as `records Codex CLI for this project`.
Three or more new files in one folder below a root share one row.
Excerpt lines, line counts and per-file diffs appear only with `--verbose`; JSON `diff` is the same either way.
The receipt then groups each agent's status, hook file and its own enablement step.
Local setup does not configure remote/cloud runtimes.

| Scope | Selection |
|---|---|
| Global (default) | `--global` |
| Current project | `--here` |
| Another project | `--project <dir>`; `--project .` equals `--here` |

Scope flags are mutually exclusive.
A `--project` symlink resolves to its real folder, so previews, records and later commands name that folder.
Use the same scope for `init`, `wire`, `doctor`, `unwire` and `eject`.
After a project `wire`, the preview lists the project files and the receipt adds one note:
the project hooks run ToneDial with paths from this machine, so keep them out of version control
(for example with `.git/info/exclude`), or commit them only if you mean to.
In your home directory a project scope would use the global files,
so `init`, `wire`, `unwire` and `eject` with `--here` there stop and show the `--global` command.
Hosts load global hooks and skills in every folder.
Beside a global connection for the same agent, `wire <tool> --here` and `init --here` write and record nothing for it,
and show the two commands that keep the tone in this project only; JSON marks that agent `covered: true`.
Without a scope flag, `unwire <tool>` stops in a folder with its own connection for that agent,
and `eject` in a folder with any connection of its own; both show the `--here` and `--global` commands.
The scope chooses wiring destinations, not another tone or preset library.
`use --project` instead exports `.tonedial/TONE.md`; `test --project` selects a conversation folder.

For state only, without a native connection:

```bash
tonedial init --tools none --global --auto --json
tonedial set persona.user_ref=friend --json
tonedial set speech_level=polite --json
tonedial set "safeword=plain answer please" --json
tonedial show --json
```

With delivery on and no agent connected, `init`, `use` and `create` end with `tonedial test` for an installed Claude Code or Codex, otherwise with `tonedial wire`.
Unattended setup needs explicit tools; ordinary unattended connection writes also need explicit scope, including state-only init and `doctor --fix`.
Without tools, `init` writes nothing and prints `init --tools codex` and `init --tools none` for the scope and options you gave, one command per line; JSON reports them in `commands` with `reason: "tools-required"`.
Read-only doctor, dry runs and operation-ID rollback need no explicit scope under `--auto`.
Otherwise a dry run stops wherever the real run would, such as an unscoped `unwire <tool>` in a folder with its own connection for that agent.
`--auto` never chooses tools by detection; JSON never prompts.

### Native routes

| Host | Hook files: project / global | Delivery |
|---|---|---|
| Codex | `.codex/hooks.json` / `~/.codex/hooks.json` | `SessionStart` + `UserPromptSubmit` refresh |
| Claude Code | `.claude/settings.json` / `~/.claude/settings.json` | `SessionStart` + `UserPromptSubmit` refresh |
| Antigravity IDE/Desktop | `.agents/hooks.json` / `~/.gemini/config/hooks.json` | Named `tonedial` hook with direct `PreInvocation` commands; JSON `injectSteps[].ephemeralMessage` |

Delivery reads the managed `AGENTS.md` guide before `TONE.md` from the same state root.
Claude Code replaces hook context over 10,000 characters with a short preview.
When Claude Code is connected and the guide and an enabled tone exceed that, tone-changing commands and `doctor` show a notice; the change is still saved.
For Codex, ToneDial writes the pair as JSON `additionalContext` with `additionalContextLimit: 0` on `SessionStart` and `UserPromptSubmit`.
Codex then skips its default preview of hook context over about 2,500 tokens (observed on Codex 0.164.0).
Hooks written by earlier versions keep that preview until `doctor --fix` or `init` rewrites them; a project the global hook serves needs `doctor --fix --global`.
Codex keys hook trust to the definition, so review a rewritten hook again in `/hooks`.
Tone changes regenerate the artifact without rewriting the guide.
Setup merges owned entries and preserves unrelated handlers; no home instruction-file import is added.
Codex and Claude Code share the skill link `.agents/skills/tonedial` in the project or home directory; Claude Code also gets `.claude/skills/tonedial`.
Antigravity's skill link is `.agents/skills/tonedial` in a project or `~/.gemini/config/skills/tonedial` globally.
Its `~/.gemini/antigravity-ide/` and `~/.gemini/antigravity/` app-data directories are not hook locations.
`init --commands` adds Claude's optional `/tone` command and requires Claude in the selection; `init --migrate-legacy` imports legacy tone state.
When `codex` is connected interactively and installed on `PATH`, `init` offers to open Codex after the receipt so you can review `/hooks`.
When `claude` is connected to a project interactively and installed on `PATH`, `init` offers to open Claude Code there so you can answer its workspace trust prompt.
When both are connected, the first installed of Codex and Claude Code is offered.
`wire` accepts a positional tool name or `--tools <list>`.
With neither, it shows `init`'s numbered agent picker in a terminal,
marking agents installed on `PATH` and those already connected in the scope; an empty answer cancels with exit 0 and writes nothing;
without a terminal it stops and shows an example command.

### Review host enablement

| Host | Where to review |
|---|---|
| Codex | `/hooks` → `SessionStart` → ToneDial; review the command and enable the hook |
| Claude Code | Interactive sessions run hooks only in trusted folders; `/hooks` → `SessionStart` lists the ToneDial command and its settings source |
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
It then opens with a count of problems and notices; doctor exits 0 either way, and JSON `healthy` reports problems.
That count is the one health statement.
The ToneDial files and connection files rows follow it only when they need attention, and a settings file that could not be inspected is named under the second.
When hook states are shown, the report closes with the note that they come from the inspected settings files only.
Each finding appears once and ends with the command that fixes it; `tonedial doctor --fix` with the same scope when `--fix` repairs it.
JSON gives a check's repair command in `checks[].repair` when it has one.
A connected agent reads as connected, then whether its settings file shows the hook enabled, then the step that enables it in the app.
The Codex project-trust step appears only for project connections.
When ToneDial's own entries in a hook file were edited outside it, doctor leaves the file alone and gives two manual routes.
Restore the entries exactly as ToneDial wrote them (`doctor --verbose` lists them), or move the file aside, run `doctor --fix` in that scope and copy your own entries back.
When delivery is paused it suggests `tonedial on`; when no agent is connected it ends with `tonedial wire` for that scope.
Other registered connections are listed under "Also connected elsewhere", one row per scope, agents and file status, with the directory they share printed once after its rows.
Inspecting global from a folder with its own connections says so and gives `tonedial doctor --here`; that folder's listed commands also use `--here`.
An agent that is connected only in another scope is listed as not connected in this scope.
A project hook that repeats the global hook for the same agent is reported in both scopes.
One notice per agent names the global hook once, each project hook, and the `unwire` command for each project that keeps only the global one: `--here` in that folder, `--project` from anywhere else.
JSON lists it in `integrations[].duplicates` with its `scope`, `destination`, `path` and `state`.
ToneDial entries in the inspected scope's hook file that no connection records are a problem.
When they are exactly what ToneDial writes now, the finding ends with `doctor --fix --tools <tool>` for that scope, which records them without rewriting the file;
edited ones get guidance only: remove them by hand, then connect again.
A global hook kept only by project connections an earlier version recorded is a problem that ends with `unwire <tool> --global`.
While ToneDial's own files need setting up first, these findings stop at the hook file; the finding for the context files gives the command that comes before them.
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

`unwire <tool>` disconnects one agent and `eject` every agent in the scope.
`unwire` without a tool shows the same picker as `wire` in a terminal;
without a terminal it stops and shows an example, with `--here` in a folder that has its own connections.
Without a scope flag, `unwire <tool>` stops in a folder that has its own connection for that agent
and shows the `--here` and `--global` commands; elsewhere it disconnects the global connection.
Removal preserves shared state, presets, CLI, shell PATH, other scopes/consumers and changed or ambiguous foreign resources.
Versions before 0.1.14 recorded a project connected beside a global one on the global hook.
`unwire <tool> --global` and `eject --global` remove those project connections with the hook, as `unwire --here` would;
the preview names each directory and JSON lists them in `alsoDisconnected`.
Use `off` instead when the connections should remain installed and only delivery should pause.

### Connection recipes

**Connect one project**

```bash
cd ~/work/app
tonedial wire codex --here
```

Only this folder gets the hook and skill link.
The preview lists the files; the receipt names the version-control choice.
Wiring an agent that is already connected prints one row for it, `ok Codex CLI · up to date`, with its hook file on the next line and the host's review step.
With a global Codex connection the folder already gets the tone, so this writes nothing and shows the commands for the next recipe.

**Connect globally**

```bash
tonedial wire codex --global
```

Run it from any folder; the global hook applies in every project.

**Move from project to global**

```bash
cd ~/work/app
tonedial unwire codex --here
tonedial wire codex --global
```

Disconnect the project first; otherwise the agent loads the tone from both hooks.

**Move from global to one project**

```bash
tonedial unwire codex --global
cd ~/work/app
tonedial wire codex --here
```

Every other folder stops getting the tone; only this one keeps it.

**Disconnect one agent**

```bash
tonedial unwire codex --here      # this folder's connection
tonedial unwire codex --global    # the shared connection
```

`eject --here` or `eject --global` disconnects every agent in that scope instead.
After `unwire codex --global`, nothing ToneDial wrote for Codex stays in `~/.codex/hooks.json`,
including entries an earlier version kept there for a project.
Disconnecting removes the skill folders setup created, such as `.agents/skills`, once they are empty; folders that existed before setup stay.

**See what is connected where**

```bash
tonedial show
tonedial show --json
```

`show` lists each scope and directory once, as `project · codex, claude` above the directory, the same words `doctor` uses for other scopes; JSON lists every connection in `connections`.
A project connection an earlier version recorded on the global hook is labeled, and JSON marks it `sharesGlobalHook: true`;
`unwire <tool> --global` removes it with the global hook, and its preview lists those project folders under their own heading.
`tonedial doctor --here` checks one folder's files and lists the other connections.

**Recover after a host or Node update**

```bash
tonedial doctor --here
tonedial doctor --fix --here
```

Hooks record the Node runtime path, so `doctor` flags a hook whose runtime moved, and `doctor --fix` rewrites it after approval.
Use `--global` for global connections, and review a rewritten Codex hook again in `/hooks`.

## Hook refresh and bounded style feedback

Claude/Codex refresh current instructions at `UserPromptSubmit`.
Their `Stop` path may inspect the response and request **at most one style-only continuation** per response.
That continuation can add usage/history; it cannot silently replace the first displayed answer and does not repeat completed tool work.

Antigravity refreshes at `PreInvocation`; no verified final response body exists on that route, so it has no `Stop` feedback.
Checks are length/presentation heuristics, not semantic character validation.
Missing/slow input, malformed metadata, recognized data/code and some ambiguous data-like prose skip feedback.

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
| Presets | `presets/builtin/`, `presets/custom/`, older flat user presets |
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
`tonedial doctor --help` lists the recovery options below; the full help only points to it.
Diagnose, preview, then approve:

```bash
tonedial doctor --global --json
tonedial doctor --fix --global --dry-run --json
tonedial doctor --fix --global
tonedial list --json
tonedial show --json
```

Without a terminal, `doctor --fix` writes no agent-connection change that needs approval.
It says so and prints the commands to rerun it with the same agents and scope:
in a terminal, or previewed with `--dry-run` and then approved with `--auto`.
JSON reports `native.reason: "approval-required"`.
Rebuild replaces generated files while preserving valid settings, unsaved preset changes and custom presets.
Healthy presets remain listable/exportable with damaged config; one bad preset does not hide others.
Other commands that read damaged config, `show` and `get` included, name the file and the `doctor --fix` that recovers it, with the scope of the command that failed (global for commands that have none), on a line of its own.
JSON reports it as `reason: "settings-unreadable"` with that command in `commands`.
Flat user presets stay readable; conflicts receive a reported recovered copy without overwriting originals.

After a failed repair, the error identifies the phase, affected path when known, safe error code and operation ID.
Some file changes may already be applied; keep the operation record and run the reported scoped diagnosis.
Doctor shows current blockers by default; `--verbose` and `--json` retain the full operation history.
A repair's receipt ends with the `--rollback` command that undoes it;
afterwards, `doctor --verbose` lists that command for each completed operation that can still be restored.
Running and uncertain owners remain protected and receive no automatic mutation recommendation.

An unreadable operation record has no trusted actions to resume or restore.
Doctor reports its exact ID and a scoped `--quarantine-operation` command.
Preview or approve that command through the normal repair gate:

```bash
tonedial doctor --fix --quarantine-operation <id> --global --dry-run
tonedial doctor --fix --quarantine-operation <id> --global
```

Quarantine replaces only the selected unreadable record with a nonblocking marker.
When several records are unreadable, doctor reports the next ID and command; repeat until the last command continues the ToneDial file rebuild.
Each repair journal retains that record's original bytes and mode for explicit rollback; never delete records by hand.

For a stopped valid operation, use the exact `--from-operation` command shown by doctor.
Preview it with `--dry-run`, then review and approve the proposed repair.
This continues ToneDial file repair with valid current settings first; it does not undo the previous changes.
To undo the stopped operation's changes instead, use the `--rollback` command doctor shows beside it.
A setting change or connection command refused while the operation is stopped ends with the same two commands;
JSON reports them in `commands` with `reason: "recovery-pending"`.
Interactive selection asks for the full displayed operation ID; Enter cancels and a different ID is rejected without writing.
The file-change preview still requires separate approval after selection.

| Missing information | Explicit source |
|---|---|
| Axes | `--from-preset <slug>` |
| Available saved values | `--from-operation <id>` from a validated same-root operation; current valid fields win |
| A missing/invalid user preset | Add `--restore-preset <slug>` with the operation source; retain its damaged preimage |
| Other values | Disclosed defaults |

Review native attention separately; explicitly select tools (`--tools <list>`) when adding or reconciling a route during `doctor --fix`.
`doctor --fix` and a repeat `init` repair one scope.
When another scope's folder is there but its connection files are missing, they name that scope's `doctor --fix` command, and JSON lists `unselected-scopes` in `native.issues`;
healthy connections elsewhere and missing folders are left to doctor's report of other scopes.
A file whose ToneDial entries changed outside ToneDial is named with the reason it was preserved.
A rebuilt config records no connections, so the hooks it no longer records keep delivering the tone and `doctor` reports them.
`doctor --fix --tools <tool>` with the same scope records entries that are exactly what ToneDial writes, after the usual preview and without changing the file.
Keep rollback IDs and originals.
If both native and ToneDial file phases changed files, roll back **native first, then ToneDial files**, using each reported ID:

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

Package and ToneDial file repair are separate.
Npm users reinstall through npm, then use `doctor --fix` to repair ToneDial files.
Curl users run a fresh `install.sh --repair` at the same root, retain program archives and approve required component/source choices.
Unknown components stay protected without their named archive choice; retry failed state repair with the new command.
Curl PATH repair covers only the recorded global profile/owned region; changed/foreign content is protected and npm owns its PATH setup.
See [candidate checks](./TESTING.md#isolated-candidate) for installation recovery limits.

</details>

## Command reference and JSON

`tonedial` with no arguments shows the short help without creating state: the first steps `init`, `test`, `set` and `wire`, then the commands by group.
`tonedial --help` describes each command, most used first, and `<command> --help` adds its options and examples.
`--verbose` (`-v`) adds detail to any command.
Recovery options for `doctor --fix` appear only in `tonedial doctor --help`.
Top-level help includes a link to the GitHub issue forms.
Successful tone mutations recompile in the same action.

An unknown command, option or extra argument exits with status 2 and names the help command to read.
`tonedial help` and `tonedial version` point to `--help` and `--version` instead.
A reader that closes early, as in `tonedial show | head`, does not crash the command; it still finishes its work.

| Command | Purpose |
|---|---|
| `set <key>=<value> …` | Change axes, roles or settings; no args opens the dial |
| `show [slug]` | Show current settings or preview a saved preset; `--explain` adds settings and risks |
| `get [key]` | Show one or all current editable values; a key adds meaning and choices |
| `reset [axis]` | Reset one axis, or all twelve with no args; keep other settings |
| `address [self user]` | Set the agent's and your address; no args asks for both |
| `persona [agent user]` | Set both role descriptions; no args asks for each |
| `test [claude\|codex]` | Preview your tone or a preset in a new conversation; accepts `--preset`, `--project`, `--accept-usage`, `--dry-run` |
| `off` / `on` | Pause/resume tone delivery; keep settings, presets and full `TONE.md` |
| `list` | List bundled and saved presets; `--verbose` adds axis values |
| `use <slug>` | Apply a preset; `--project <dir>` also exports `TONE.md` to `<dir>/.tonedial/` |
| `create [display name] [key=value …]` | Create and apply after approval; no args guides setup; accepts `--slug`, `--auto`, `--dry-run` |
| `save [display name] [--slug <slug>]` | Save the current tone as a preset; no name or `--slug` updates a custom preset |
| `export <slug>` / `import <file-or-https-url>` | Transfer complete presets |
| `edit [preset <slug>]` | Open config/custom preset in the editor; `--dry-run` previews |
| `init` | Set up and refresh bundled files; accepts scope flags, `--tools`, `--lang`, `--commands`, `--migrate-legacy`, `--auto`, `--dry-run` |
| `wire [tool \| --tools <list>]` / `unwire [tool]` | Connect/disconnect in the selected scope (`--auto`, `--dry-run`); without a tool, both show the agent picker in a terminal |
| `doctor` | Diagnose; `--fix` repairs (`--tools`, `--from-preset`, `--from-operation [--restore-preset]`, `--quarantine-operation`, `--rollback`) |
| `eject` | Disconnect every agent in a scope; retain shared state and presets (`--auto`, `--dry-run`) |
| `compile` | Rebuild missing/stale `TONE.md`; `--check` reports without writing |
| `update` | Compare installed and latest versions, then update the running npm or curl installation (`--auto`, `--dry-run`) |

Ordinary changes compile automatically; `compile --check --json` also supplies reload paths.

| Machine contract | Behavior |
|---|---|
| Envelope | Every command accepts `--json`; integer `schema: 3`, including version/errors |
| Refusals | `ok: false` with the message in `error`; a named refusal adds a stable `reason` (`scope-required`, `home-directory`, `tools-required`, `approval-required`, `ownership-conflict`, `recovery-pending`, `settings-unreadable`) and the `commands` it prints |
| Delivery state | `get`, `show`, `compile --check`, `on` and `off` report boolean `enabled` |
| Stored schemas | Config 2; preset 2 with legacy 1 support; operation formats separate |
| Streams | JSON stdout has no terminal escapes or ToneDial prompts/provider handoff |
| Export | Plain is raw preset JSON; `--json` wraps it |
| Get | Flat `values` object using editable keys; one requested key or all; full text and typed nulls |
| Show | Includes `riskAxes`, `riskThresholds` and `connections` (`target`, `scope`, `destination`; null scope and directory for legacy records); no unsupported guard/ceiling/width fields |
| Compile check | Human: current/stale/missing; JSON: character count and absolute `agentsPath`/`path`, not existence/delivery proof |
| Explicit editor | `edit --json` still launches the requested editor; live output uses stderr |

`edit` opens `config.json`; `edit preset <slug>` opens a custom or legacy user preset (bundled presets are refused).
For `config.json`, `edit` checks wiring ownership before writing.
Staging content that is not a valid JSON object or that changes `wiring` ownership is refused before modifying live files,
and any remaining staging copy is retained at its reported temp path
(change wiring through `wire`, `unwire`, `eject`, `init` or `doctor --fix`).
Deleting the staging file is refused when it would change ownership; with empty ownership,
the deletion is committed to the live config as a raw edit before an error is reported.
Concurrent on-disk changes also abort before writing and retain the staging copy when present.
Once `config.json` ownership is verified, or during `edit preset <slug>`, validation failures still record the operation
and commit the raw edit to the target path before reporting the error.
These failures are invalid settings, malformed preset JSON, a changed internal `"slug"` field and, for `edit preset <slug>`, a deleted staging file.
The error says the edit was saved as written and names the next step: `tonedial doctor` for `config.json`, or the `edit preset` command that reopens a preset.

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
| No `--preset` | Current saved settings, including unsaved preset edits |
| Complete preset (schema 2) | Its complete axes, persona/note, address, register and safeword |
| Legacy axis-only preset (schema 1) | Its axes with current separate settings |
| Provider | One installed client can be selected; two prompt interactively; ambiguous plans need an explicit name |
| Folder | Current directory or existing `--project` directory |

If the named client is missing, the error offers the installed one; with neither installed, `test` stops before planning.
`--dry-run` shows the plan and ends with the command that launches it.
After a clean exit, a `--preset` preview suggests `tonedial use <slug>` unless that preset is already active without unsaved changes.
Otherwise, with delivery on and no agent connected, it suggests `tonedial wire --global`.

The README includes a [recorded Codex-default vs complete `vibe-coder` comparison](../README.md#same-model-a-tighter-plan)
with [verbatim replies and provenance](./media/readme/verbosity-comparison.json).
It uses one fresh `gpt-5.6-sol` / `high` session per condition and illustrates the whole preset,
not the isolated effect of `verbosity=1`.

Compilation happens in memory and leaves ToneDial state unchanged.
This explicit preview uses the chosen tone even while persistent hook delivery is off.
The preview sends the tone once, in the opening prompt, without hook refresh or `Stop` feedback.
Judge it by the first few replies; longer conversations can drift.
The opening prompt requests dialogue only and no file changes throughout that folder.
Claude disables built-in tools and denies MCP tools; Codex requests a read-only sandbox without approval escalation.
Claude safe mode and Codex invocation-only hook/doc overrides request exclusion of previous connected ToneDial context.
Only the compiled preview is identified as the tone source.
Managed policy and native support remain independent: **this is not whole-folder OS isolation**.
Native exit status applies; unsupported clients must not retry with weaker restrictions.
See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Complete persona text and `note` reach the client/model and may enter history or process arguments under OS access policy; keep credentials and private material out of preview persona fields.
JSON and dry-run prompt nothing, launch or probe no provider and omit the injected prompt, though they still require a named executable on `PATH`, an existing target and readable config (name the provider when both are installed).
This initial-prompt preview does not establish native hook activation or model adherence.

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

`update` shows the installed and latest versions with their release dates,
and says whether the installation is up to date, has an update available or is newer than the latest release.
It replaces nothing when the installation is current or newer, so it never downgrades.
npm installations ask `npm view tonedial version time --json`, so your npm registry settings apply;
curl installations read the package metadata from `TONEDIAL_REGISTRY`.
If npm cannot answer, `update` says the latest version could not be checked and still offers the npm update.
`update --dry-run` previews the update without replacing the package; `--auto` approves an unattended update (JSON output never prompts).
JSON adds `latestVersion`, `installedPublishedAt` and `latestPublishedAt`, each `null` when unknown;
`checkedRemote` is `true` when the registry or npm answered.
`installedVersion` is the version left installed: the running one, unless the update replaced it.
For npm installations, ToneDial runs `npm update` only after checking that its global target matches the running copy.
A different prefix or linked development copy is reported without updating another installation.
The npm receipt says whether npm updated the package or it was already up to date, with the version npm left installed.
If generated files need attention, the command reports their state and the applicable repair action once,
scoped to the global installation (`tonedial doctor --fix --global`) so an unattended run can use it.
ToneDial does not require root privileges; npm's global prefix must be writable by your user.
For `EACCES` or `EPERM`, follow [npm permission recovery](#npm-permissions).

`npx` is unsupported: skill/control commands need a durable executable.
For source builds, see [CONTRIBUTING.md](../CONTRIBUTING.md#build-and-run-from-source).

<details>
<summary>Alternative curl installation</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh
```

Requires `curl` and `tar` on `PATH` (in addition to `node`).
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

1. Back up the complete state root, including settings and custom presets.
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
   it preserves saved settings, custom presets and agent connections.
   It refuses conflicting files rather than deleting them.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh \
     | TONEDIAL_HOME="$state_root" sh
   "$state_root/bin/tonedial" --version
   "$state_root/bin/tonedial" show
   ```

   Stop on any installation or verification failure and keep the backup.
   Check your expected settings and presets before removing the old copy.

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
