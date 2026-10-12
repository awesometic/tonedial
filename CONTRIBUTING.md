# Contributing to ToneDial

Bug fixes, documentation, native integrations and model measurements are welcome.
Start with [README.md](./README.md) for the current candidate status and [USAGE.md](./docs/USAGE.md) for user behavior.
The npm and curl channels and native acceptance remain release work;
[TESTING.md](./docs/TESTING.md) records verification requirements and their limits.

Search existing issues and pull requests before starting.
Small fixes may come directly as a PR; discuss larger features, new hosts, bundled presets and anchor changes in an issue first.
Report security-sensitive findings through [SECURITY.md](./SECURITY.md), without private details in a public issue.
Use a topic branch or fork for the change and keep one coherent purpose per PR.
Exclude personal configuration, provider files, credentials and generated local links from the contribution.
Use the bug, integration and bundled-preset forms when they fit;
a blank issue remains available when none of them describes the work.

## Setup and checks

Use Node 24+ and npm from the repository root:

```bash
npm ci
npm test
```

ToneDial has no runtime dependencies.
Reuse existing code and standard `node:` APIs before proposing a dependency or another implementation path.
Authoring agents, models, plugins and skills are your choice; [AGENTS.md](./AGENTS.md) records the same project obligations for agent-assisted work.

```bash
npm run typecheck    # src, test and scripts
npm run build        # emit src into dist, the shipped JavaScript
npm run packs        # regenerate pack artifact blocks from fixture inputs and compiler
npm run fixtures     # extract generated fixtures from packs
node --test --experimental-strip-types test/compile.test.ts
```

`npm test` runs typecheck, build, fixture drift, pack drift, then `node:test`, in that order.
Keep all gates: build alone does not typecheck tests/scripts, and the drift checks protect the compiler → packs → fixtures chain.
For compiler or anchor edits, run `npm run packs` then `npm run fixtures` and inspect the generated diff.
For a new pack or changed pack inputs, supply valid complete frontmatter/compiler inputs and a valid artifact block before the initial `npm run fixtures`, then run packs → fixtures.
Generate artifact text from the compiler; do not hand-edit existing artifact blocks or generated fixtures.
Changed artifact bytes require new measurement evidence; existing evidence applies only to the bytes it records.

Use focused existing checks during development and the relevant full suite after runtime/build changes settle.
Documentation changes need checks that can reveal failures in the edited material, such as link resolution or validation of an example.
For changed issue forms, parse the YAML with an available parser and check GitHub's form schema or preview.
Record passed, failed, not-run and unavailable checks in the PR;
a documentation check does not prove runtime behavior.
[TESTING.md](./docs/TESTING.md) owns test selection, existing-test audits, required gates and reporting; skipped checks are never passes.

## Code and contracts

[README.md](./README.md) introduces the product and current status, [USAGE.md](./docs/USAGE.md) owns commands, state and privacy limits, and [TESTING.md](./docs/TESTING.md) owns checks, trials and model measurements.

- `src/core/` owns axes, presets, configuration, deterministic compilation, generated seeds/skill, paths and recovery state.
- `src/cli.ts` owns parsing, dispatch and output envelopes; `src/commands/` owns command behavior.
- `src/ui/` owns terminal measurement, formatting, prompts and the inline dial.
- `src/wiring/` owns native delivery, file planning, approval, ownership, scoped removal and recovery integration.
- `scripts/` owns development generation; `test/fixtures/` is generated. Runtime code never reads documentation.

Compilation uses no LLM or external state and produces identical bytes for identical inputs.
All twelve axes use one English anchor set at levels 1–5; risk notices are advisory and tone never changes permission or approval requirements.
Presets carry axes only; persona, address, register and safeword remain user settings.
All ordinary tone changes recompile the artifact, while project scope chooses connections to the shared state.
Preserve user data and foreign settings/handlers; generated files and ownership markers do not authorize overwriting unrelated content.
Generated configuration, observed host activation, delivered context and model adherence are separate claims.
Audit generated skill guidance and seed provenance with any change to its exposed CLI contract, as required in [AGENTS.md](./AGENTS.md).

## New native hosts

Use the checklist below with the [connection reference](./docs/USAGE.md#connecting-an-agent) to distinguish implemented and observed routes.
Verify the host's actual contract before adding an adapter:

1. Confirm both global and project hook filenames, event/matcher grammar, handler shape and skill discovery paths.
   Update `AGENT_TOOLS` and `AGENT_LAYOUT` in `src/core/paths.ts`; explicitly check `hookFile` and `skills`, whose defaults can silently select the wrong file or directory for a new host.
2. Add labels, delivery and lifecycle matchers in `src/wiring/targets.ts`, with the correct argument-vector or quoted-shell handler.
   A reserved name becomes supported only after its real contract is established; new routes deliver the ordered guide/artifact pair without editing project instructions.
3. Implement the host's output envelope and accepted provider name/repair hint in `src/core/reader.ts`, and its matching self-test expectation in `src/commands/doctor.ts`.
   Codex and Claude consume plain stdout; Antigravity consumes `injectSteps[].ephemeralMessage` in JSON. A filename or table entry alone does not make a usable route.
4. Include trust/enablement, skill discovery, both scopes, merging of unrelated hooks, and data-preserving removal/recovery.
   Run applicable checks in `test/extension-points.test.ts`, `test/native-routes.test.ts` and `test/wiring.test.ts` in disposable paths, including negative cases for foreign or modified resources.
5. Establish actual activation/context delivery in an explicitly approved host trial using [the actual-host procedure](./docs/TESTING.md#actual-host-and-one-day-trial).
   Record host/version and CLI/desktop/IDE surface, scope, event, trust steps and fresh/resumed/compacted-session observations in the PR and integration status.
   If no real session was observed, state the configuration evidence and the remaining activation gap.

Local checks use isolated state/project paths.
Actual-host sessions and changes to personal/global configuration need explicit authorization; preserve normal authentication and never copy credentials or disconnect a user's integration to construct a control.
Native preview prompts and tool flags are not OS filesystem isolation.

## Presets and copy

Prefer a user preset created with `set`, `save` and `export`; it needs no repository change.
The bundled set is deliberately five presets, each with 3–7 non-default axes.
A new bundled preset needs a user-facing reason and an agreed proposal; axis coverage belongs to the measurement harness.
Update `src/core/presets.ts`, English/Korean summaries and safeword suggestions in `src/core/i18n.ts`, the pack/fixtures, extension-point/count checks and maintained product lists together.
The first bundled preset determines the unattended default, so changing its position changes behavior.
Anchor changes must preserve distinct axis observables and the [measurement obligations](./docs/TESTING.md#model-measurements).

Write repository documents in English.
README.md remains the English default, with README.ko.md as its Korean translation.
Localized README/media follow their own locale; use the [README media conventions](./docs/media/readme/README.md) for paths, names, translation parity and provenance.
Revised shipped sentences follow English draft → Korean translation → natural Korean polish; keep short labels out of that pipeline, anchors in their single English set, and commands, paths and JSON keys unchanged.

## Measurements and pull requests

A single configuration on one model is a useful contribution and needs no ToneDial installation for the pasted/API routes.
Follow [the fixed-input procedure](./docs/TESTING.md#model-measurements): use the committed pack/scenario, pre-register the prediction, retain verbatim output, use a separate judge and report an explicit repetition count.
Record exact model, effort and delivery-route metadata and the required matched no-artifact control; native Route D also needs actual activation evidence.
Measurement contributions may add a result file under `docs/results/`.
Record exact metadata, requests, artifacts, outputs and scores, and never infer missing fields.
Approved navigation-only link repairs may update links without changing that evidence.

Open the PR from the topic branch or fork after the focused checks are complete.
Explain the problem, resulting behavior, checks that passed or failed, checks not run or unavailable, and remaining limits.
Use the PR template's evidence boundaries for generated configuration, host activation, delivered context and model adherence;
mark unrelated evidence as not applicable.
Add or update tests for realistic uncovered regressions, not a test-count target, and never weaken a failing gate to obtain green output.
AI-assisted contributions are welcome: the submitting human reviews the complete diff and owns correctness and verification; authoring model/plugin/harness disclosure is optional.
Measurement metadata remains required because it identifies the experiment.
Maintain contributor authorship and PR references when integrating changes; commit messages explain what changed and why.

Use synthetic/redacted examples in reports.
Exclude credentials, persona notes, saved personal configuration, provider history, recovery backups, personal provider assets, generated local links and agent execution journals.
[SECURITY.md](./SECURITY.md) owns sensitive reporting.
The [release gate](./scripts/check-release.mjs) owns package and repository checks; publication requires maintainer authorization.
