# Testing ToneDial

Run automated checks, then inspect the installed candidate, then observe the selected native host.
Model adherence is a separate measurement; none of these steps alone qualifies a release.
Use Node 24+, npm and a POSIX shell from the repository root.

## Automated checks

```bash
npm ci
npm test
npm pack --dry-run
```

Stop on failure. `npm test` checks types, builds, checks pack/fixture drift and runs `node:test`.
While working, run the relevant file with `node --test test/compile.test.ts`, substituting the actual affected test.
Run `npm run build` first when a focused test consumes `dist`.
Installer and package-inventory tests use that built output; the `prepack` build is checked in a separate disposable source tree.
Add a test only for a realistic regression not already caught, and assert the visible result or protected bytes rather than an implementation detail.
Do not weaken tests, regenerate unread snapshots or call skipped checks passes.
Create disposable fixtures under `node:os`'s `tmpdir()`, not an OS-specific path.
For identity-based replacement tests, allocate the foreign entry while the original and any prepared replacement still exist, then rename it into place; inode allocation after deletion is not a portable identity guarantee.
For documentation-only work, resolve links, exercise changed examples and run the artifact checks that consume those documents; explain that scope in the PR.
For README/media changes, `node --test test/dial-example.test.ts` checks canonical asset URLs, locale provenance and renderer output.
Local documentation checks may be focused; CI still runs the complete suite and release gate on every push and pull request.

## Output and terminal regression tests

`npm test` includes English and Korean command text, interactive-frame and SVG image goldens, plus real PTY flows.
The command corpus checks the live CLI registry, stdout, stderr and exit status.
Frames cover the existing dial renderer; image goldens compare deterministic SVG output, including cell positions and supported ANSI styles.
These checks do not certify a font's rasterization, a native agent session or model adherence.
PTY checks use Python 3.9+ and its standard library on Linux and macOS; `python3` must be available on `PATH`.
Unsupported platforms are reported as skipped.
Missing Python on a supported platform fails the check.
All state, projects and provider paths are disposable; external-agent and network actions are not part of the golden corpus.

For focused verification from the checkout:

```bash
npm run test:golden
npm run test:pty
TONEDIAL_TEST_LANG=en npm run test:golden
TONEDIAL_TEST_LANG=ko npm run test:pty
```

`test:pty` builds the CLI first.
Omit `TONEDIAL_TEST_LANG` to check both locales; an empty or unknown locale is an error.
Golden files live under `test/golden/` and belong in version control.
Only replace them after inspecting the changed command output and representative images:

```bash
TONEDIAL_GOLDEN_UPDATE=1 npm run test:golden
npm run test:golden
```

Update mode is forbidden in CI.
Text and frame mismatches retain expected/actual output and a diff; image mismatches also include an HTML visual comparison.
PTY failures retain the captured terminal transcript.
Local failure artifacts live under ignored `artifacts/`.
GitHub CI runs independent `en` and `ko` jobs on pushes and pull requests, and uploads failure artifacts as `visual-regression-en` or `visual-regression-ko`.
CI verifies the committed baselines and never updates them.

## Isolated candidate

The following helper isolates CLI state and configuration, not an authenticated agent process.
Keep this shell and its variables for the entire trial. Do not substitute your normal state or provider home.

```bash
trial_dir="$(mktemp -d)"
td_trial() {
  channel="$1"
  shift
  mkdir -p "$trial_dir/$channel/home" "$trial_dir/$channel/tmp" \
    "$trial_dir/$channel/agents" "$trial_dir/$channel/state"
  env -i PATH="$trial_dir/$channel/state/bin:$trial_dir/npm-prefix/bin:$PATH" \
    HOME="$trial_dir/$channel/home" TMPDIR="$trial_dir/$channel/tmp" \
    XDG_CONFIG_HOME="$trial_dir/$channel/xdg" \
    TONEDIAL_HOME="$trial_dir/$channel/state" \
    TONEDIAL_AGENT_HOME="$trial_dir/$channel/agents" \
    npm_config_userconfig="$trial_dir/$channel/npm-user.conf" \
    npm_config_globalconfig="$trial_dir/$channel/npm-global.conf" \
    npm_config_cache="$trial_dir/$channel/npm-cache" \
    npm_config_offline=true npm_config_update_notifier=false \
    LANG=en_US.UTF-8 "$@"
}
if ! pack_output="$(td_trial build npm pack --pack-destination "$trial_dir")"; then
  printf '%s\n' 'Pack failed; stop this trial.' >&2
  exit 1
fi
pack_file="$(printf '%s\n' "$pack_output" | tail -n 1)"
pack_path="$trial_dir/$pack_file"
if [ ! -f "$pack_path" ]; then
  printf '%s\n' 'Reported archive is missing; stop this trial.' >&2
  exit 1
fi
td_trial npm npm install --global --prefix "$trial_dir/npm-prefix" \
  --ignore-scripts --offline --no-audit --no-fund "$pack_path"
npm_cli="$trial_dir/npm-prefix/bin/tonedial"
td_trial npm "$npm_cli" --version --json
```

Record the archive SHA-256 and version. Use the filename npm returned, not a guessed versioned name.
Continue only with the expected version and successful schema-3 JSON envelopes (`ok: true`).
Test the extracted installer separately; this checks the local install shape, not the live curl downloader:

```bash
mkdir "$trial_dir/curl-candidate"
tar -xzf "$pack_path" -C "$trial_dir/curl-candidate" \
  --no-same-owner --no-same-permissions
td_trial curl node "$trial_dir/curl-candidate/package/dist/install.js" \
  --root "$trial_dir/curl/state" \
  --candidate "$trial_dir/curl-candidate/package"
curl_cli="$trial_dir/curl/state/bin/tonedial"
td_trial curl "$curl_cli" --version --json
```

The fresh installer emits a human install receipt; only the following CLI check is a schema-3 envelope.
Installation must not initialize tone state, modify provider files or add shell PATH lines.
If bare-command reachability differs between channels, record that separately from state or native health.
Run this state/library sequence for both channels:

```bash
check_state() {
  channel="$1"
  cli="$2"
  td_trial "$channel" "$cli" init --lang en --tools none --global --auto --dry-run --json
  td_trial "$channel" "$cli" init --lang en --tools none --global --auto --json
  td_trial "$channel" "$cli" compile --check --json
  td_trial "$channel" "$cli" set warmth=4 --json
  td_trial "$channel" "$cli" save "Trial Preset" --json
  td_trial "$channel" "$cli" export trial-preset --json
  td_trial "$channel" "$cli" list --json
  td_trial "$channel" "$cli" doctor --global --json
}
check_state npm "$npm_cli"
check_state curl "$curl_cli"
```

Stop if any command fails. Require exported `warmth=4`, a listed custom `trial-preset`, fresh compiled tone and no native connection.
Dry-run must leave all bytes unchanged; state-only initialization writes the guide/tone pair, config and preset caches, not hooks or skills.
Inspect the actual trial files and modes as well as receipts.
In disposable state, save a custom preset before changing a generated guide or tone file; preview and approve `doctor --fix --global --auto`, then verify the custom file's original bytes/mode, export and reload.
Missing settings need an explicit source/default choice; use the [recovery procedure](./USAGE.md#recovery), not state-root or lock deletion.

For native configuration regression, use an isolated fake host layout containing a foreign hook and custom setting.
Preview selected tools with `init --tools claude --global --dry-run --json`, then explicitly approve the same selection/scope.
Repeat the preview and approval with `--tools antigravity` and verify the named `tonedial` `PreInvocation` hook, its direct command list, `injectSteps[].ephemeralMessage`, generated skill links and repeat initialization.
Verify merged handlers and unrelated settings, ordered guide-before-tone reader output and the selected project or global paths.
Scoped disconnect must preserve foreign handlers, custom presets and other scopes.
Neither a fake client nor a successful configuration check proves actual host loading.

<details>
<summary>Installation and recovery boundaries</summary>

Existing tests cover integrity/archive refusal, package/shim replacement, rollback after verification failure, killed-owner retry, concurrent installers and foreign-path preservation.
Retain recovery staging, archives and operation IDs on failure; a live owner, ambiguous lock, invalid journal or replaced target is not permission to delete it.
Package repair and application repair are separate results. Use the fresh executable at the same root to retry state recovery.
This trial does not establish network availability, publishing permissions, every OS/filesystem behavior or complete recovery from all interruptions.

</details>

## Actual host and one-day trial

This section is user-operated and needs the selected host's normal authentication and explicit permission to use its profile.
Do not copy credentials, grant trust automatically, construct a no-tone control by disabling someone's real setup, or infer desktop/IDE support from a CLI result.
`TONEDIAL_AGENT_HOME` redirects ToneDial wiring only; it does not select or isolate a host profile.
Before starting the host, put the chosen candidate's bin directory on that host process's PATH and give it the same `TONEDIAL_HOME` used by the approved delivery.
Inside the actual host execution environment, verify that bare `tonedial` resolves to the selected candidate path/bytes (`command -v tonedial` where available), not another global copy, and reads that state root.
Matching version alone is insufficient.
Stop on a command/root mismatch or if the host cannot provide this evidence before invoking its generated skill.

1. Select the exact installed candidate above and a dedicated host profile/project, or deliberately choose normal settings after reviewing the [usage and privacy limits](./USAGE.md).
   Record version/archive fingerprint, OS, host/surface/version, scope, model and effort.
2. Preview only that host and scope, then approve it. For a project use `init --tools codex --project <existing-directory> --dry-run`, then the same command without `--dry-run`; substitute the actual host and a real chosen directory before execution.
   Ensure the selected host actually reads that project/profile. Review the current hook definition in the host, including `/hooks` where applicable; for Antigravity IDE use the agent panel `… → Customizations → Hooks`, and for Antigravity Desktop use `Settings → Customizations → Hooks`. Do not use trust bypasses.
3. Start a fresh session and observe delivery of the complete guide before the exact current artifact.
   Test resume, clear, compaction and fork only where that surface has those events. Shared global/project layers must not duplicate context.
4. Ask the discovered skill to change one setting and separately to reload unchanged settings.
   Require CLI success, `compile --check --json`, then complete `agentsPath` and `path` reads. A settings query alone is not reload evidence.
5. Exercise failed changed-setting and unchanged-setting reloads in the disposable environment.
   For the changed case, first confirm save success, then interrupt before reading and move a context file aside; otherwise a mutation may recreate/refuse it and test the wrong path.
   Require separate save/no-change and failed-read reports, never a claim that guidance became active. Restore the original file before continuing.
6. Refuse a host trust/enablement request once and verify existing configuration is preserved.
   Through the day, record changed/unchanged reload, restart, ordinary usage, failures and risky-level behavior as passed, failed or not run.
7. Inspect the same scope with doctor, preview disconnect, then approve `eject` or one-tool `unwire` only if chosen.
   Verify user presets, unrelated settings and other scopes survive. Keeping the candidate is also a choice; no trial cleanup deletes shared state or unknown recovery files.

Screenshots/transcripts should show the actual host event and exact request, with private values removed.
Record configuration, reader runtime, trust, activation, delivered context and model behavior separately.
Codex, Claude and Antigravity observations remain separate across surfaces; an IDE result does not qualify Desktop (or the reverse) or a remote runtime. Unavailable authenticated or trusted trials remain pending.

For `test --preset`, compare a bundled and a custom preset while a different saved tone is connected.
Verify the preview uses the selected profile's complete settings, retaining current personal settings only for schema-1 inputs, without changing configuration or artifacts.
Observe exclusion of connected tone hooks and automatic instructions; record managed-policy behavior separately.
An unsupported native client must fail without a weaker retry.
Check default-no cancellation, per-launch consent and the next launch after `--accept-usage`.

### Actual terminal acceptance

Use the isolated candidate in a real interactive terminal, not a piped/fake stream.
At 60×24, 80×24 and a wider window, check all twelve gauges, selected hints and pending edits; apply a visible change and confirm it saved, then discard another and confirm state stayed unchanged.
Open help and shrink below the minimum: hidden or incomplete previews must refuse editing/apply.
Check resize, normal exit, Esc/q/Ctrl+C, controlled error/handled-signal exits, and suspend/resume; the cursor, raw-input state and shell must remain usable afterwards (compare `stty -g` before/after where available).
Repeat with colors disabled and check Unicode cell alignment. Previous resize rows may remain in scrollback; erasing user shell history is not a pass condition.
Record failures and unavailable platform/terminal checks separately; automated dial tests do not establish this manual usability result.

## Model measurements

Use [fixed packs](./test/packs/), [scenarios](./test/scenarios.md) and the [rubric](./test/rubric.md).
One configuration/model contribution is useful; a full matrix is not required for a PR.
For anchor changes, run Route D checks in Codex and Claude with matched clean `X-none` controls; keep Antigravity IDE and Desktop evidence separate.
The producer must not see predictions, this repository's design or judging instructions, and the judge must not be the producing context.

The following set defines full model coverage, not the minimum size of a contribution:

| Case | Packs | Scenarios | Tiers | Repetitions |
| --- | --- | --- | --- | --- |
| Preset reproduction | All seven bundled profiles | S1, S2 | Mid and frontier | At least 2 per request |
| Degenerate | all-1, all-3, all-5 | S2 | Mid and frontier | At least 2 |
| Permission boundary | all-5, heavenly-demon | S4 | Mid and frontier | At least 2 |
| Safeword | bratty-kid or another loud pack | S5 | Mid and frontier | At least 2 |
| Instruction | all-3, eager-sycophant | S6 | Mid and frontier | At least 2 |
| Language gap | royal-advisor, right-hand, eager-sycophant | S3 | Mid and frontier | At least 2 |
| Role idioms | royal-advisor, ego-sword, heavenly-demon, right-hand at playfulness 1–5 | S8 | Mid and frontier | At least 2 per request |
| No-artifact control | X-none | Every covered request | Matched host/model/effort | At least 1 |

| Route | Delivered context | What it establishes |
| --- | --- | --- |
| A | Exact artifact pasted into an instruction file in a newly empty project, in a user-provided clean authenticated environment | Instruction-file proxy behavior, not native hook activation |
| B | Exact artifact as a one-shot system prompt; verify the actual host's flags first | That prompt route only, not A or D |
| C | Exact artifact as system context in an API/web conversation with a fresh user turn | That context route only; credentials belong to the contributor, not ToneDial |
| D | ToneDial's approved installed integration, without also pasting the artifact | Product delivery after separate observed activation |

Keep routes distinct. For every `X-none` control verify no ToneDial guide/artifact, hook context, discovered/invoked skill, `/tone` or preview prompt enters the session.
An empty project is insufficient when the host injects global context; use a dedicated user-provided clean environment, match ordinary instructions/tools/model/effort/request/code, and retain absence evidence.
Stop if delivery or the clean control cannot be established; do not manufacture them with someone's real profiles or authentication files.

### Committed pack

Lock the prediction before running. Copy the complete fenced artifact and fixed scenario request/code verbatim; add no measurement or tone coaching to the request.
For Route D set the pack's complete input: preset identity, all axes, persona, register and exact safeword.
Fresh unattended init needs explicit scope/tools and loads the first profile's role/register defaults with safeword unset.
An axis-only probe must explicitly clear persona/address and restore auto register; `reset` preserves these settings.
Verify compiled artifact bytes equal the pack and retain its SHA-256/full input/compiler revision plus guide fingerprint and actual delivery evidence.
Run each request at least twice in fresh sessions and report explicit `n`; controls use the matched request and a fresh no-tone session.
Compare only identical route/input/request conditions, and use both small and class-sized surfaces before generalizing axis counts.

### One-off single-axis arm

Prepare a separate fresh temporary state and project. Keep the selected absolute installed candidate and environment for every command.
Use state-only explicit-scope init, then `reset`, then change only the selected axis to its 1–5 level; do not save it as a preset or hand-edit a managed artifact.
Require `preset: null`, empty persona/address, `speech_level: auto`, no safeword, other style axes at 3 and other permission axes (`profanity`, `flattery`, `refusal`, `bravado`) at 1.
Name the arm `A-<axis><level>` in the result, not the artifact. Retain complete `show --json`, immutable artifact bytes/SHA-256, compiler revision and guide fingerprint.
Before a native run, approve a host in that disposable scope, recheck unchanged input, and observe that exact fingerprint delivered.
Repeat adjacent levels from fresh defaults with matched no-tone controls. Use `S1-fn-ko` and `S7-fn-polite-ko` for contextual auto forms and the formality contrast.
Also compare familiar polite and formal plain with nonzero profanity and independent warmth; score forms separately from distance, feeling and coarseness.
Treat changed prompt bytes as new measurement inputs and run fresh measurements for them.
A persona/safeword variant needs its own pre-registered name; unavailable native activation remains pending.

### Review the session

Give an independent judge verbatim outputs, scenario request boundaries and the rubric, withholding the prediction until after scoring.
Score axis compliance and language naturalness separately. Compare observed information quality and permission behavior against controls; tone prose does not enforce permissions.
Report held, failed or inconclusive with a reason, including all failed runs rather than selecting favorable replies.
Target mid/frontier tiers; accept entry results without treating them as current supported-tier qualification. Record the exact provider model identifier, not a moving family label.

Keep the request boundaries and verbatim outputs beside the scores so another person can review
what the session actually answered. Score axis compliance and language naturalness separately,
and mark a run inconclusive when the host did not deliver the selected artifact.
