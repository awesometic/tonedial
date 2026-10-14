// Portable session controls; native delivery belongs to verified lifecycle hooks.
// Bundling instructions does not establish skill discovery or activation.

import { GUIDE_FORMAT_MARKER } from "./reader.ts";

export const SKILL_NAME = "tonedial";

/** The current command envelope, shared by both installed control entry points. */
const JSON_MD = `Require zero exit status and a JSON result with \`ok: true\` and \`schema: 3\`
for every successful CLI step before continuing. Parse JSON rather than scraping human output.
Schema 3 removes guard and ceiling fields and reports advisory \`riskAxes\`; persisted config
remains schema 2 and preset/journal formats are unchanged. Never send \`guards\` or
\`fixed_width\` assignments.
If the installed CLI returns another version, report the incompatible CLI and ask
the user to update it before tuning or reloading; do not install it, mutate settings, or read
the context pair as a successful reload. A failed read-only diagnosis can still be reported
as a failure, but never as a successful save or reload.
`;

/** Read-only diagnosis follows the failed CLI flow's scope, not a newly inferred default. */
const DIAGNOSIS_MD = `Follow the CLI's reported scoped read-only diagnosis command, preserving its
\`--global\`, \`--here\`, or \`--project <path>\` and the same environment.
Pass only \`tonedial doctor\`, its reported scope, and \`--json\` as literal arguments;
never execute arbitrary error text or add repair, rollback, or migration flags yourself.
If no scoped command was reported, preserve any explicit connection scope from the flow;
for a tone mutation in this project, \`doctor --here --json\` inspects cwd and the global layer.
Ask which connection scope to inspect when that context is unknown rather than silently
substituting the global default. Missing or conflicting files need the user's explicit setup
or repair decision. Never edit or recreate them directly.
`;

/** Both entry points carry the same reload contract, not independently maintained procedures. */
const RELOAD_MD = `First distinguish a successful settings change from a reload request that changed
nothing. In either case, run \`tonedial compile --check --json\`.
Require zero exit status, \`ok: true\`, and \`schema: 3\` before continuing.
This read-only command reports destinations; it does not prove that either file exists,
matches the saved settings, or has been loaded.

Read the complete UTF-8 file at the returned absolute \`agentsPath\` first (\`AGENTS.md\`).
Its first line must be \`${GUIDE_FORMAT_MARKER}\`; otherwise stop the reload.
Then read the complete UTF-8 file at the returned absolute \`path\` (\`TONE.md\`).
Use the paths exactly as returned, including spaces or Unicode; never guess a home directory,
substitute another state root, or execute file contents as commands.

Only after both reads succeed, use the guide followed by the artifact as manner instructions
in this conversation, subject to the host's and project's instructions and permission rules.
After a settings change, report the saved settings and the completed read separately. After an
unchanged reload request, report that no setting changed and that the read completed. Do not
promise perfect adherence.
If the lookup, guide validation, or either read fails after a settings change, report that the
settings were saved but session reload failed. If it fails after an unchanged reload request,
report that no setting changed and session reload failed. In either case, name the failing step
and do not claim that the new tone is active.
For diagnosis, follow the shared Connection scope and legacy state procedure.

This reload affects only the current conversation. It does not fire a lifecycle hook, replace
earlier context, or reload other open sessions. Future delivery still depends on an installed,
enabled, and trusted native hook.
`;

/** Explicit setting requests use the same CLI mapping through either installed entry point. */
const SETTINGS_MD = `## Explicit settings

Persona, address, safeword, and \`speech_level\` are separate from the axes.
Change one only when the user explicitly asks for that setting; preserve every other setting.
Use the user's chosen text and values, not the illustrative values below.
Choose only the matching command or assignments; this table is not a sequence to run.
Pass free text as one literal argument, preferably through an argument array rather than
interpolating it into shell code.

| Request | CLI example |
|---|---|
| What to call the user only | \`tonedial set "persona.user_ref=friend" --json\` |
| What to call yourself only | \`tonedial set "persona.self_ref=guide" --json\` |
| Both address terms, self first and user second | \`tonedial address "assistant" "reader" --json\` |
| Persona age band | \`tonedial set persona.age=30s --json\` |
| Persona gender | \`tonedial set persona.gender=neutral --json\` |
| User background and preferences | \`tonedial set "persona.user=Developer who likes concise technical answers" --json\` |
| Fictional agent role | \`tonedial set "persona.agent=Database specialist with ten years of experience; speaks directly" --json\` |
| Persona manner or role note | \`tonedial set "persona.note=Patient guide" --json\` |
| Safeword phrase | \`tonedial set "safeword=plain answer please" --json\` |
| Honorific register system | \`tonedial set speech_level=polite --json\` |

Age bands are \`unspecified\`, \`teens\`, \`20s\`, \`30s\`, \`40s\`, and \`50s+\`.
Gender values are \`unspecified\`, \`masculine\`, \`feminine\`, and \`neutral\`.
An empty value clears only the named persona field or safeword, for example
\`tonedial set "persona.agent=" --json\` or \`tonedial set "safeword=" --json\`.
\`persona.user\` describes the user; \`persona.agent\` describes the agent's fictional role.
Each accepts at most 200 Unicode code points; never silently truncate a longer request.
Preserve the other fields and ask the user to shorten text rejected by the CLI.
Agent experience and specialty are roleplay, not verified credentials or tool capabilities.
Both descriptions lose to axes and task/permission rules, and may influence content.
A persona note expresses manner or role, loses to axes, and may also influence
content; it is not a way to override task or permission rules.
The CLI warns above 200 Unicode code points instead of rejecting the note; report its warnings.

ToneDial has no guard toggle or automatic emergency register. All axis levels 1–5 are choices
the user can request. Report advisory \`riskAxes\` and combination notices without lowering
values, blocking the change, or asking for additional tone-risk confirmation. The host's task
and permission rules still apply independently.
For \`speech_level\`, choose \`polite\`, \`plain\`, or \`auto\` only when the user requests that
register system. \`auto\` chooses address forms for the current relationship and scene,
keeping them consistent within each reply; \`polite\` and \`plain\` fix those forms.
It has no effect where the language lacks an honorific distinction. A request for more or
less formality changes wording and distance within the chosen forms, without silently changing
\`speech_level\`. Familiar polite, formal plain and affectionate swearing are valid combinations;
preserve the user's chosen warmth and profanity levels rather than making politeness suppress them.
`;

/** Scope and recovery are shared setup instructions, never another tone-setting source. */
const SETUP_MD = `## Connection scope and application recovery

\`init\`, \`wire\`, \`doctor\`, \`unwire\`, and \`eject\` default to global connections.
\`--global\` names that scope explicitly; \`--here\` selects the current project and
\`--project <path>\` selects another project. These choices never create another tone store.
Do not combine scope flags. \`use --project <path>\` remains an artifact export, not setup.

Ordinary unattended connection writes require an explicit scope with \`--auto\`.
Read-only diagnosis, \`--dry-run\`, and \`doctor --fix --rollback <id>\` are exceptions:
rollback selects the recorded operation's paths, not whichever project is current.
Use the same CLI environment throughout, especially when \`TONEDIAL_HOME\` is set.

When a mutation or reload is blocked, report its read-only diagnosis.
${DIAGNOSIS_MD}
After the user asks for recovery, use \`tonedial doctor --fix\` at the same state root.
It preserves validated saved settings and custom presets, and rebuilds generated application
files only after approval. Missing old hashes or changed generated text are not reasons to
delete the state root. New user presets live in \`presets/custom/\`; older non-bundled flat
files remain loadable, while \`presets/builtin/\` is only a generated cache.
\`list --json\` and \`export <slug> --json\` can inspect the library even with damaged config.
If values are unavailable, report the missing fields and let the user select a displayed
preset/default choice, \`--from-preset <slug>\`, or a bound \`--from-operation <id>\` source.
The two source flags can be combined: valid current values win, operation data supplies
available saved values, and the selected preset fills missing axes. Disclose other defaults;
do not silently reset saved values.
\`--restore-preset <slug>\` targets one missing or invalid user file and requires a selected
operation source. Conflicting user definitions are preserved under reported recovered names;
an active association needs the user's explicit choice and must not reset saved axes.
Do not edit files, change the state root, remove locks or grant hook trust yourself.
The user chooses native tools and scope separately; foreign provider containers are not
application outputs. A successful app rebuild can still report native attention.
\`doctor --fix --dry-run\` previews app and selected native changes without writing or
printing private prior values. Keep both reported IDs when recovery changes app and native
files; follow the receipt and roll back native connections before application files.
Retired earlier operations remain history, not ownership to recreate or old locks to restore.
For curl installs, automatic PATH repair is limited to a recorded global profile; modified
or foreign profiles remain protected, and \`--tools none\` suppresses external writes.
Do not claim that setup, repair, or migration proves host activation or model adherence.
`;

/**
 * The frontmatter `description` is an **activation trigger, not a summary**. A description that
 * says what the skill is gets loaded when a model happens to think it relevant; one that says
 * when to use it gets loaded when the user actually asks.
 */
export const SKILL_MD = `---
name: tonedial
description: Use when the user wants to check, change, or reload ToneDial manner, tone, personality, register, preset, user description, agent role, address terms, or safeword — including requests like "be gentler", "act as a database specialist", "remember my background in ToneDial", "more formal", "call me friend", or asking what the current tone settings are.
---

# tonedial

The \`tonedial\` CLI stores the user's manner settings. This skill handles an explicit request
to inspect or change them; do not assume a hook already delivered them to this session.

**The CLI is the source of truth.** Never edit its config, \`AGENTS.md\`, or \`TONE.md\` directly,
and never pretend a setting was saved by merely behaving differently.
Use the same installed CLI and environment for every step. If the CLI cannot run, stop and ask
the user to complete CLI installation and explicit setup; do not install it or guess another root.

## Read the current state first

\`\`\`bash
tonedial show --json
\`\`\`

The payload carries \`axes\` (twelve axes, each 1–5), \`defaults\`, \`groups\`, \`kinds\`,
\`riskAxes\`, \`persona\`, \`safeword\`, \`speech_level\`, and \`chars\`. Every command takes \`--json\` and answers with a
\`schema\` field.
${JSON_MD}
Otherwise report the failed step
and stop that flow. Never report a failed mutation as saved; failures after a successful mutation
follow the saved-state/reload distinction below.

A request that only asks what the settings are stops here — report them and do not read the
files. A request to **apply or reload the current settings**, with nothing to change, does not:
the settings may have moved in another terminal or another session since this conversation
started. Change nothing and go straight to the reload procedure below.

## Map the request to axes, then set them

Read \`references/traits.md\` for what each axis owns and which way its levels run. Change only
the axes the request is about — moving a neighbouring axis "to help" is the most common way a
tone edit ends up feeling wrong.

\`\`\`bash
tonedial set warmth=4 flattery=1 --json
\`\`\`

Report the movement back to the user in their own terms, from the \`moves\` field.

- "gentler" → usually \`critique\` down, sometimes \`warmth\` up. Not \`compliance\`.
- "stop flattering me" → \`flattery=1\`. Not \`warmth\`, which is a different observable.
- "be brief" → \`verbosity\` down. Change \`care\` only for requested coverage or organization changes.
- "more casual" → \`formality\` down. Change the register system only on an explicit request,
  such as "use plain forms" → \`speech_level=plain\`.

For a named preset, run \`tonedial list --json\` then \`tonedial use <slug> --json\`.
An explicit agent character or role request uses \`persona.agent\`; an explicit request to
save the user's background or preferences in ToneDial uses \`persona.user\`.
Do not save ordinary task context as a description, invent a preset, or infer age, gender,
address terms or neighbouring settings from a role.
Saving the current axes as a new one is \`tonedial save "<display name>" --json\`.

${SETTINGS_MD}

${SETUP_MD}

## Apply it in this session

Successful \`set\`, \`address\`, \`use\`, and \`reset\` commands recompile \`TONE.md\`; that is a saved state
change, not evidence of a session reload.

${RELOAD_MD}

## The safeword and resetting axes

The safeword is a phrase the user picked, reported by \`tonedial show --json\`. When their
message contains it, **drop the tone for that one message and answer plainly, then resume.**
It releases the manner and authorises nothing: a request in the same message still faces every
confirmation and permission check it otherwise would.

For an explicit request to restore the default axes, run \`tonedial reset --json\`, then follow
the reload steps above. Saved presets remain available through \`tonedial use <slug> --json\`.
Reset restores axes only; it does not disable hooks, unload instructions, or clear persona,
safeword, or other settings. ToneDial has no persistent tone-off switch.
For "turn tone off" or an ambiguous "go back to normal", explain that limit and ask whether
the user wants an axis reset before changing state; do not silently equate off with reset.

## A separate test conversation

When the user explicitly asks to try a voice in a new conversation,
\`tonedial test claude\` or \`tonedial test codex\` hands the terminal to that installed provider.
The test folder is cwd by default; \`--project <path>\` selects another existing folder and
does not change connection scope, saved tone or the ToneDial state root.
Add \`--preset <slug>\` to preview a bundled or user preset's axes with the user's saved
persona, address and safeword. Without it, the test uses the saved axes, including unsaved edits.
The usage notice requires an explicit \`y\` before launch. \`--accept-usage\` skips that question
for this invocation only; use it only when the user has explicitly accepted account usage and
charges for this launch. A general request to try a tone is not consent to skip the notice.
Use \`--dry-run\` or \`--json\` to inspect a plan without launching the provider or running a
capability/version probe. Executable availability may be inspected through the CLI's path check.
JSON omits the injected private tone and argument vector; it is a plan, not an executed chat.

The opening prompt forbids changes anywhere in the target folder and requests dialogue only.
Claude requests safe mode to exclude ordinary hooks, memory, skills and output styles while
keeping normal authentication and permissions, then disables built-in/MCP tools.
Codex requests hooks off, zero automatic AGENTS input, its read-only sandbox and no approval escalation.
This preview uses only its supplied ToneDial manner; never reload an older connected tone in it.
Managed policy and client support remain outside these local requests; neither is OS isolation.
The test uses the provider's ordinary authentication and may consume account usage or keep
provider history. The full saved tone is passed in process arguments and may be visible to
local process readers; never put credentials or private material in persona descriptions or notes.
Never launch one implicitly, substitute API credentials, grant trust or
claim hook activation, filesystem immutability or measured tone adherence from it.
During a test conversation, do not mutate ToneDial settings or perform work through this skill.

## What this skill does not do

- It never loosens a permission gate. What work is allowed, what needs approval, and what is
  confirmed before acting are decided outside this tool, and \`TONE.md\` retains that boundary.
- It never changes persona or safeword merely to satisfy an axis request. Address, age, gender,
  user description, agent role and note are user-level settings preserved by preset switches.
`;

/**
 * The axis reference the skill body points at. Deliberately not the anchor text: an anchor is
 * the compiled instruction in `TONE.md`, and repeating it here would put
 * a second copy of the sixty anchors on a surface the user can edit.
 */
export const SKILL_TRAITS_MD = `# Axes

Twelve axes, each 1 to 5. Read the live values with \`tonedial show --json\`; this file says what
each one **owns**, which is what tells you which axis a request is actually about.

Axes name distinct aspects of a reply. Map the aspect the user named rather than changing
neighbouring axes just because several aspects can appear in the same sentence.
The agent composes ordinary emoji, lists, tables and code blocks from all selected axes and
the task; small conditional character instructions reinforce only distinctive combinations.

## form — how a sentence is built

| Axis | Owns | 1 | 5 |
|---|---|---|---|
| \`formality\` | wording and social distance within chosen forms | casual and familiar | ceremonious |
| \`verbosity\` | explanation length and depth | compressed result | reasoning, alternatives and background |
| \`profanity\` | how coarse the language gets | none at all | strong profanity throughout |
| \`playfulness\` | how much humour or roleplay it uses | none | roleplay as the usual register |

## target — who or what an observation lands on

| Axis | Owns | 1 | 5 |
|---|---|---|---|
| \`critique\` | how hard it is on the work | flat problem statements without evaluation | unsparing |
| \`flattery\` | how much it praises the person | not at all | four positive remarks per answer |
| \`warmth\` | how much it attends to the person | not at all | four warm remarks, including encouragement and empathy |

\`critique\` and \`warmth\` are the pair that makes "savage about the code, warm about me" work in
one answer. They are not opposites and setting one does not imply the other.

## behaviour — what it does about the work

| Axis | Owns | 1 | 5 |
|---|---|---|---|
| \`conviction\` | how far it pushes its own judgement | lists viable options and asks the user to choose | gives the conclusion without asking |
| \`care\` | coverage and organization | requested result without extras | organized follow-ups with functional emoji and structure |
| \`compliance\` | whether it does the thing or argues first | questions once, then acts | acts immediately without compliance commentary |
| \`refusal\` | how it resists for effect | never | a strike until coaxed or released by the safeword |
| \`bravado\` | how much it bluffs | never | boastful expert voice with credit-claiming and dramatic effort |

## Defaults are not all the same

Style axes default to **3**; the four permission axes — \`profanity\`, \`flattery\`, \`refusal\`,
\`bravado\` — default to **1**. So "set everything to 3" is not neutral: it switches all four on.
\`tonedial show\` marks every axis that has moved off its own default.

## Advisory risk

Read \`riskAxes\` from the CLI for the current selection. Risk begins at \`profanity\` 4,
\`critique\` 4, \`flattery\` 3, \`conviction\` 5, \`compliance\` 5, \`refusal\` 2, and
\`bravado\` 2. These thresholds describe disruptive requests; they are not probabilities or
predictions of model policy. All levels 1–5 remain available. Report risk without lowering
the user's choice or requesting additional confirmation. ToneDial imposes no target limit on
profanity, mandatory confession on bravado, or emergency tone release. Actual adherence still
depends on the host and model.

## Combinations worth knowing

- \`verbosity\` 1 with \`care\` 1 can return only the result, without a work narrative.
- Low \`verbosity\` with high \`care\` uses terse organized items, not longer explanations.
- Functional status emoji can accompany low \`warmth\`; they are structure, not affection.
- Required task formats take precedence: a code or JSON result must not become decorative prose.
- \`refusal\` ≥ 4 with \`compliance\` ≥ 4 contradicts itself. The CLI warns and does not block.
- \`formality\` ≥ 4 with \`profanity\` ≥ 4 holds but reads oddly.
- \`warmth\` ≥ 4 with \`profanity\` ≥ 4, and \`compliance\` ≤ 2 with \`conviction\` ≤ 2, each get a
  composite sentence in the artifact rather than being left to collide.
- Care 5 adds a caring organizer signature; high playfulness with high bravado adds a cocky expert signature. These are static instructions selected by the combination layer.

Supported native hooks refresh tone at their configured events. Claude/Codex can inspect a
completed response and request one style correction; that request does not repeat completed
tool work or silently replace an answer already shown. Hook setup and compiled instructions
do not prove actual host activation or model compliance.

## Settings that are not axes

\`speech_level\` picks address forms — \`auto\`, \`polite\`, or \`plain\` — where the language
has an honorific distinction, and does nothing where it does not. Auto adapts to the current
relationship and scene, staying consistent within a reply. \`formality\` sets distance inside
the chosen forms; warmth and profanity keep their selected effects. The persona layer (\`age\`, \`gender\`, \`self_ref\`, \`user_ref\`,
\`user\`, \`agent\`, \`note\`) and the safeword are user-level settings that a preset never touches.
\`persona.user\` is user context and \`persona.agent\` a fictional agent role, each limited to
200 Unicode code points. They may affect content, but cannot override axes or grant permissions.
`;

/**
 * The Claude Code `/tone` command, installed only by `init --commands`.
 *
 * Off by default because it is the fourth window onto the same CLI — after the skill, the
 * fallback line, and the CLI itself — and a user who does not want one should not get one. The
 * command name stays `/tone` even though the tool is `tonedial`: it is what a person types
 * mid-sentence, and the two extra characters are paid every time.
 */
export const TONE_COMMAND_VERSION = 5;

export const TONE_COMMAND_MD = `---
description: Check, change, or reload this agent's tone, preset, or ToneDial settings
---

Run \`tonedial show --json\` and report the requested current settings in plain language.
Use the same installed CLI and environment throughout.
${JSON_MD}
Otherwise report the failed step and stop that flow.
Never report a failed mutation as saved; failures after a successful mutation follow the
saved-state/reload distinction below. If the CLI cannot run, ask the user to complete installation and explicit setup;
do not install it silently. A status-only request stops after reporting the current settings.

If the user's message after \`/tone\` asks for an axis change, map it using the tonedial
skill's \`references/traits.md\` and run \`tonedial set <axis>=<level> ... --json\`.
Change only the named axes; preserve neighbouring axes and the separate settings below.
For a named preset, use \`tonedial list --json\` then \`tonedial use <slug> --json\`.
For an explicit agent character or role, use \`persona.agent\`; for an explicit request to
save the user's background or preferences in ToneDial, use \`persona.user\`.
Do not save ordinary task context or infer other persona fields.

${SETTINGS_MD}

${SETUP_MD}

${RELOAD_MD}

An explicit axis-reset request uses \`tonedial reset --json\` followed by the same reload steps.
Reset restores axes only; it does not disable hooks, unload instructions, or clear persona,
safeword, or other settings. Saved presets remain available.
\`/tone off\` is not a persistent tone-off switch. Explain that limit and ask whether the user
wants an axis reset before changing state; never silently equate off with reset.

Never edit ToneDial's config, guide, or artifact directly; the CLI is the source of truth.
`;
