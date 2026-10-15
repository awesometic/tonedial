# Agent guidance

Use any authoring agent, model and optional skills; the product contracts and verification requirements apply equally.
Start with [CONTRIBUTING.md](./CONTRIBUTING.md), then select the relevant guide:

| Need | Owner |
|---|---|
| Product status | [README.md](./README.md) |
| Commands and user behavior | [USAGE.md](./docs/USAGE.md) |
| Checks, native trials and measurements | [TESTING.md](./docs/TESTING.md) |

## Keep the implementation small

Use the first sufficient step in this ladder, adapted from [Ponytail](https://github.com/DietrichGebert/ponytail): confirm the requirement, reuse the existing owner, use the standard library or platform, reuse an existing dependency, then write the minimum needed.
Search current callers and sibling paths before adding a new owner.
Do not add speculative abstractions, fallbacks, dependencies or duplicate state; restore intended behavior before layering a workaround.
ToneDial has no runtime dependencies and uses `node:` APIs with static imports for bundled assets.
Keep changes within the requested boundary and preserve unrelated edits.

## Preserve the product boundaries

- Keep the compiler pure, deterministic and free of LLM, filesystem, environment, clock and network access.
  Emit every axis from the single English anchor set; all twelve axes and levels 1–5 remain selectable.
  Keep address forms separate from formality's wording/distance, warmth and profanity; familiar polite and formal plain are valid combinations.
  Risk metadata and combination notices are advisory: they never clamp values, add tone approval or change host permissions.
  The safeword requests one plain answer and authorizes nothing; `reset` restores axes rather than disabling delivery.
- Bundled and custom profiles save axes, persona, address, register and safeword together.
  Applying a profile restores its full tone settings; legacy axis-only presets preserve the current separate settings.
  Role idioms and slang are not filtered; playfulness grades their frequency and theatrical intensity.
  Profanity grades swearing, while bravado grades claims about effort; neither suppresses figurative role language.
  Interface language and wiring remain outside profiles.
  State belongs to the shared state root; project scope chooses wiring, not a separate tone library.
  Tone-changing mutations recompile in the same action.
- Separate generated configuration, observed native activation, delivered context and model adherence in output and documentation.
  A written hook, successful `doctor` check or model preview proves only what was observed.
  Native preview instructions and tool flags do not establish OS filesystem isolation.
- Preserve user settings, custom presets, unknown provider settings, foreign handlers and ambiguous ownership evidence.
  Show proposed file changes and obtain the required approval before mutation; `--auto` supplies that approval without hiding the preview.
  Remove only identified owned content in the selected scope, and keep `doctor --fix`, removal and recovery consistent with new wiring.
  Do not edit project instruction files for new integrations or delete the state root to repair it.
- Keep the CLI the shared owner of human and versioned JSON output.
  JSON does not prompt; native `test --json` and dry-run paths launch and probe no provider and expose no prompt body.
  Preserve stdout/stderr boundaries, actionable errors and advisory notices.
  Show the selected scope in diagnostics without requiring verbose output.
  Group repeated UI elements and messages by their shared context; show shared paths, status text and actions once,
  while keeping distinct states, affected targets and action boundaries visible.
- When a skill-exposed command, option, setting, response or integration changes, audit `src/core/skill.ts`'s body, traits reference and optional `/tone` command in the same change.
  Update affected guidance and audit seed refresh/provenance in `src/core/seeds.ts` and the skill/CLI boundary tests; state why an unaffected part needs no change.
  Installed generated copies are not the editing source; keep shipped `SKILL.md` portable.

## Copy, checks and public artifacts

Draft revised shipped copy in English, translate it into Korean, then polish the Korean for natural wording and consistent register.
Use an available Korean polishing skill when helpful; authoring tools are optional and do not lower the copy standard.
This pipeline applies to revised user-facing sentences, not short labels or agent responses.
The CLI catalogues carry interface copy, never a second anchor set.
Write repository prose in English, except localized README/media in their declared locale, and break revised prose at sentence or clause boundaries.
README.md remains the English default; [README media conventions](./docs/media/readme/README.md) owns locale paths and translation parity.

Follow [TESTING.md](./docs/TESTING.md): inspect existing coverage, test realistic observable failures, keep checks proportional and never weaken a gate to obtain a pass.
Report passed, failed and unrun checks distinctly, with remaining limits.
For changed compiler artifacts, regenerate packs and fixtures, inspect the diff, and keep any measurement evidence tied to its exact inputs, artifact bytes, outputs and scores.
Anchor and risk changes also update the applicable measurement scenarios and rubric; generated or layout checks cannot prove model behavior.

Use disposable state and project paths for local verification.
Actual-host sessions, personal configuration changes and publication require explicit authorization; do not infer it from a passing check.
Never read credentials or copy authentication files to construct a trial or measurement control.
Follow [SECURITY.md](./SECURITY.md) for sensitive findings.
Publication checks are owned by the [release gate](./scripts/check-release.mjs) and [manual publish workflow](./.github/workflows/publish.yml).
Keep personal provider files, credentials, generated local links and execution journals out of public contributions.
Maintain current product facts in their owning documents; put task rationale, verification and review in issues and pull requests.
