# Contributing to ToneDial

**One PR, one purpose.** Fix a bug, improve a guide, add a native route or contribute a model measurement.
Search existing issues/PRs first; small fixes can go straight to a PR.
Discuss larger features, new hosts, bundled presets and anchor changes in an issue before implementation.
Use a topic branch or fork and the matching issue form; a blank issue is available.
For sensitive findings, use [private reporting](./SECURITY.md).

| Start here | Owns |
|---|---|
| [README](./README.md) | Product overview and installation |
| [Usage](./docs/USAGE.md) | Commands, settings, state and privacy limits |
| [Testing](./docs/TESTING.md) | Automated gates, candidate/native trials and measurements |
| [Agent guide](./AGENTS.md) | Obligations for agent-assisted work |

Use the maintainer-controlled [publish workflow](./.github/workflows/publish.yml) for releases.
Publication and native acceptance are separate checks; local passes do not establish either.

<a id="setup-and-checks"></a>

## Build and run from source

Use **Node 24+ and npm** from a checkout:

```bash
npm ci
npm run build
node dist/bin.js init --tools none --global --lang en
node dist/bin.js set
```

The compiled CLI is `dist/bin.js`; use `node dist/bin.js` in place of installed `tonedial` commands.
Setup previews changes to your normal ToneDial state before approval and selects no agent connection.
For disposable state and projects, follow the [isolated candidate procedure](./docs/TESTING.md#isolated-candidate).
Use `--lang ko`, `ja`, `zh` or `es` for another interface language.

### Check your changes

```bash
npm test
```

| During development | Command / requirement |
|---|---|
| Types, including tests/scripts | `npm run typecheck` |
| Shipped JavaScript in `dist/` | `npm run build` |
| Focused test | `node --test test/compile.test.ts`; substitute the affected file; build first if it consumes `dist` |
| Compiler/anchor changes | `npm run packs`, then `npm run fixtures`; inspect the generated diff |
| Documentation | Resolve links, exercise changed examples and run their consumer tests |
| CLI output/dial | Review [goldens and PTY checks](./docs/TESTING.md#output-and-terminal-regression-tests); retain state/stream assertions |
| Issue forms | Parse YAML and check GitHub's schema or preview |

`npm test` runs **typecheck → build → fixture drift → pack drift → node:test**.
Keep every gate; build alone does not typecheck tests/scripts.
Use focused checks while working and the relevant full suite after runtime/build changes settle.
[TESTING.md](./docs/TESTING.md#automated-checks) owns test selection and reporting; skipped checks are never passes.

For a new pack or changed compiler inputs, prepare complete valid frontmatter, a compiler-generated artifact block and its exact code-point count first.
Extract the inputs before regenerating packs; `packs` reads the generated fixture configs, not frontmatter:

```bash
npm run fixtures    # create/update fixture inputs from the prepared pack
npm run packs       # compile artifacts using those inputs
npm run fixtures    # synchronize the final artifacts and counts
```

For compiler/anchor text changes with unchanged pack inputs, use packs → fixtures as above.
Generate artifacts through the compiler; never hand-edit existing artifact blocks or generated fixtures.
Measurements apply only to the exact artifact bytes they record; changed bytes need fresh evidence.

## Code and contracts

ToneDial has **zero runtime dependencies**.
Reuse the current owner and standard `node:` APIs before adding a dependency or another path.
Authoring agents, models, plugins and skills are your choice; the project contracts apply equally.

| Owner | Responsibility |
|---|---|
| `src/core/` | Axes, profiles, config, pure compiler, seeds/skill, paths and recovery state |
| `src/cli.ts`, `src/commands/` | Parsing, dispatch, command behavior and output envelopes |
| `src/ui/` | Terminal measurement, formatting, prompts and dial |
| `src/wiring/` | Delivery, file plans, consent, ownership, scoped removal and recovery |
| `scripts/`, `test/fixtures/` | Development generation and generated fixtures; runtime never reads docs |

Preserve these boundaries:

- **Pure compilation:** identical inputs produce identical bytes; no LLM or external state. All twelve axes use the single English anchor set at levels 1–5.
- **Manner only:** risk notices are advisory; tone never changes permissions or approval requirements.
- **Complete profiles:** axes, persona, address, register and safeword travel together. Legacy axis-only profiles preserve separate settings; language/wiring remain global.
- **Shared state:** tone changes recompile immediately; project scope selects connections, not a separate library.
- **Owned writes:** preserve user data and foreign settings/handlers. Generated markers do not authorize unrelated overwrites.
- **Evidence:** generated config, host activation, delivered context and model adherence are distinct claims.
- **Skill parity:** audit generated skill guidance and seed provenance whenever its exposed CLI contract changes; see [AGENTS.md](./AGENTS.md).

## New native hosts

Verify the actual host contract before adding an adapter.
Use the [connection reference](./docs/USAGE.md#connecting-an-agent) alongside this checklist.

1. **Paths:** confirm global/project hook names, events, matchers, handler shape and skill discovery. Update `AGENT_TOOLS`/`AGENT_LAYOUT` in `src/core/paths.ts`; explicitly check `hookFile` and `skills` defaults.
2. **Delivery:** add labels and lifecycle matchers in `src/wiring/targets.ts` with the right argv or quoted-shell handler. Deliver guide before artifact, without editing project instructions. A reserved name alone is not support.
3. **Reader:** implement the output envelope and provider name/repair hint in `src/core/reader.ts`, plus doctor self-test expectations. Codex/Claude consume plain stdout; Antigravity consumes JSON `injectSteps[].ephemeralMessage`.
4. **Preservation:** cover trust/enablement, discovery, both scopes, foreign hooks, removal and recovery in disposable paths. Run applicable `extension-points`, `native-routes` and `wiring` tests, including modified/foreign negative cases.
5. **Actual host:** use an [explicitly approved trial](./docs/TESTING.md#actual-host-and-one-day-trial). Record host/version, CLI/IDE/Desktop surface, scope, event, trust and fresh/resumed/compacted-session observations in the PR and integration status. Without a real session, report the activation gap.

Actual-host sessions and personal/global config changes require explicit authorization; see [TESTING.md](./docs/TESTING.md#actual-host-and-one-day-trial) for trial, credential and isolation rules.

## Presets and copy

Prefer a custom profile made with `set`, `save` and `export`; it needs no repository change.
The bundled set contains seven relationships, each with 3–7 non-default axes and address/role defaults.
New bundled profiles need an agreed user-facing reason; axis coverage belongs to measurements.
The first profile is the unattended default, so ordering changes behavior.

When changing bundled profiles, update together:

- `src/core/presets.ts` and all five CLI catalogues: `src/core/i18n.ts` plus `src/core/locales/{ja,zh,es}.ts`.
- Packs/fixtures, extension-point/count checks and maintained product lists.
- Applicable [model measurements](./docs/TESTING.md#model-measurements) when anchors change; keep each axis independently observable.

Write repository prose in English, except declared localized README/media and example pages.
README.md is the English source; keep Korean, Japanese, Simplified Chinese and Spanish translations aligned.
The [media guide](./docs/media/readme/README.md) owns locale paths, parity and provenance.
Revised shipped sentences follow **English draft → Korean translation → natural Korean polish**.
Short labels are exempt; anchors stay in one English set and command/path/JSON keys stay unchanged.

## Measurements and pull requests

A single configuration/model is useful; pasted/API routes need no ToneDial installation.
Use the [fixed-input procedure](./docs/TESTING.md#model-measurements): pre-register predictions, preserve verbatim output, use an independent judge and report explicit `n`.
Record exact model/effort/route metadata and matched no-artifact controls; Route D also needs observed activation.
Results may live under `docs/results/` with exact inputs, requests, artifacts, outputs and scores; never invent missing fields.
Navigation-only link repairs must leave evidence unchanged.

Before opening the PR:

- Explain the problem and resulting behavior; list passed, failed, unrun/unavailable checks and remaining limits.
- Use the PR template's evidence boundaries; mark unrelated claims not applicable.
- Add tests for realistic uncovered regressions, not test counts; never weaken a gate to pass.
- Review the complete diff. AI assistance is welcome and disclosure optional; the submitting human owns correctness/verification. Measurement metadata remains required.
- Preserve contributor authorship and PR references when integrating; commit messages explain what changed and why.

Use synthetic/redacted reports.
Exclude credentials, persona notes, saved personal config, provider files/history, recovery backups, local links and execution journals.
[SECURITY.md](./SECURITY.md) owns sensitive reporting; the [release gate](./scripts/check-release.mjs) owns release checks.
Publication requires maintainer authorization.

## Maintainer releases

Keep the version in `package.json`, both root entries in `package-lock.json` and `src/cli.ts` aligned.
Prepare English release notes at `docs/releases/<version>.md`, including the pinned npm installation command and relevant changes.
Commit the candidate to `main`, then run **Actions → Publish → Run workflow**.
Pushing to `main` alone does not publish.

The workflow runs the complete checks, publishes to npm using its trusted publisher,
then checks npm availability immediately and retries HTTP 404 responses every 15 seconds
for up to 20 minutes, sharing that limit across metadata and tarball requests.
It verifies npm's package identity, `gitHead` and SHA-512 integrity before creating
`ToneDial v<version>` at that workflow's commit, attaching the published
`tonedial-<version>.tgz` and `SHA256SUMS` to a draft, and publishing that release.
GitHub supplies the source ZIP and tarball automatically.
Only the release job receives `contents: write`; no long-lived publishing token is required.

Configure npm's trusted publisher for `.github/workflows/publish.yml` with **Allow npm publish**.
**Allow npm dist-tag** is unnecessary for this workflow.
The package must already exist on npm before a trusted publisher can publish its next version.

If npm succeeds but the GitHub job fails, use **Re-run failed jobs** to retry only that job.
Matching draft assets are reused; existing notes and unrelated attachments are preserved.
Conflicting tags/assets or incomplete published releases fail without overwriting them.
Inspect those conflicts before resolving them manually; do not republish an existing npm version.
