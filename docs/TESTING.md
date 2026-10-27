# Testing ToneDial

**Check the change you made. Report only what you observed.**
Use Node 24+, npm and a POSIX shell from the repository root.

| Change / claim | Verification |
|---|---|
| Documentation / examples | Resolve links, exercise changed commands and run relevant document consumers |
| README / media | `node --test test/dial-example.test.ts test/voice-examples.test.ts test/verbosity-comparison.test.ts` |
| Runtime / build | [Automated checks](#automated-checks) |
| CLI text / dial | [Golden and PTY tests](#output-and-terminal-regression-tests) |
| Installed package | [Isolated candidate](#isolated-candidate) |
| Native delivery | [Actual host and one-day trial](#actual-host-and-one-day-trial) |
| Tone behavior | [Model measurements](#model-measurements) |
| Release automation | `node --test test/github-release.test.ts test/release-check.test.ts`; [maintainer workflow](../CONTRIBUTING.md#maintainer-releases) |

Run automation before candidate inspection and the selected native trial.
Configuration, reader health, trust, activation, delivered context and model adherence are separate claims; no single check qualifies a release.
Release automation tests simulate npm/GitHub responses; they do not validate the trusted publisher or establish live publication.

## Automated checks

```bash
npm ci
npm test
npm pack --dry-run
```

**Stop on failure.** `npm test` runs types → build → pack/fixture drift checks → `node:test`.
During development use the affected file, for example `node --test test/compile.test.ts`.
Build first when it consumes `dist`; installer/package tests need built output, while prepack is tested in a separate disposable source tree.
For docs-only changes, use link/example/consumer checks and explain that scope in the PR.
CI still runs the full suite and release gate on every push/PR.

- Add coverage for a realistic uncovered regression; assert visible behavior or protected bytes, not implementation details.
- Never weaken gates, regenerate unread snapshots or report skipped checks as passes.
- Create disposable fixtures under `node:os`'s `tmpdir()`, not an OS-specific path.
- For identity-replacement tests, allocate the foreign entry while original/prepared entries still exist, then rename it into place. Inode allocation after deletion is not a portable identity guarantee.

## Output and terminal regression tests

Text/frame/SVG goldens and real PTY flows check command registry, stdout, stderr, exit status, cell positions and supported ANSI styles.
They establish renderer behavior, not font rasterization, native activation or adherence.
All state/project/provider paths are disposable; the corpus runs no external agent or network action.

```bash
npm run test:golden
npm run test:pty
TONEDIAL_TEST_LANG=en npm run test:golden
TONEDIAL_TEST_LANG=ko npm run test:pty
```

| Requirement | Behavior |
|---|---|
| Locales | English/Korean; omit `TONEDIAL_TEST_LANG` for both; empty/unknown fails |
| PTY runtime | Python 3.9+ standard library on Linux/macOS; missing Python fails; unsupported platforms skip |
| Build | `test:pty` builds first |
| Baselines | Committed under `test/golden/`; inspect changed text and representative images before replacing |
| Failure evidence | Expected/actual/diff; SVG HTML comparison; PTY transcript under ignored `artifacts/` |
| CI | Separate en/ko jobs; uploads `visual-regression-en` / `visual-regression-ko`; never updates baselines |

After inspecting an intentional change:

```bash
TONEDIAL_GOLDEN_UPDATE=1 npm run test:golden
npm run test:golden
```

Update mode is forbidden in CI.

## Isolated candidate

**Keep this shell and its variables for the whole trial.**
The helper isolates CLI state/configuration, not an authenticated agent process.
Never substitute normal state or a personal provider home.

### Build and install the archive

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

Record archive SHA-256/version; use npm's returned filename, never a guessed one.
Continue only with the expected version and schema-3 `ok: true` receipts.
The extracted installer checks local curl installation shape, not the live downloader:

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

Require a human install receipt followed by the CLI's schema-3 version result.
Installation must not initialize tone state, modify provider files or add shell PATH lines.
Report bare-command reachability separately from state/native health.
In this redirected layout, curl doctor can report a missing shell PATH line even when the helper resolves the command; inspect `appHealthy` and individual checks separately.

### Check state and preservation

Run both channels:

```bash
check_state() {
  channel="$1"
  cli="$2"
  td_trial "$channel" "$cli" init --lang en --tools none --global --auto --dry-run --json || return
  td_trial "$channel" "$cli" init --lang en --tools none --global --auto --json || return
  td_trial "$channel" "$cli" compile --check --json || return
  td_trial "$channel" "$cli" set warmth=4 --json || return
  td_trial "$channel" "$cli" off --json || return
  td_trial "$channel" "$cli" on --json || return
  td_trial "$channel" "$cli" save "Trial Preset" --json || return
  td_trial "$channel" "$cli" export trial-preset --json || return
  td_trial "$channel" "$cli" list --json || return
  td_trial "$channel" "$cli" doctor --global --json || return
}
check_state npm "$npm_cli" && check_state curl "$curl_cli"
```

Stop on any failure. Inspect files/modes as well as receipts:

- Exported `warmth=4`, listed custom `trial-preset`, fresh tone, no native connection.
- `off` retains the full artifact and settings while the reader emits no context; `on` restores
  the exact prior artifact body and reader delivery.
- Dry-run leaves every byte unchanged; state-only init writes guide/tone, config and caches, no hooks/skills.
- Save a custom profile, alter generated guide/tone, preview/approve `doctor --fix --global --auto`, then verify original custom bytes/mode, export and reload.
- Missing values use explicit sources/defaults from [recovery](./USAGE.md#recovery), never root/lock deletion.

### Check native configuration without a host

Use a disposable fake layout with a foreign hook and custom setting.
Preview `init --tools claude --global --dry-run --json`, then approve that exact tool/scope; repeat for Antigravity.
Verify:

- Named Antigravity `tonedial`/`PreInvocation`, direct command list, `injectSteps[].ephemeralMessage`, skill links and repeat init.
- Merged/foreign handlers and settings, guide-before-tone output and correct project/global paths.
- Scoped removal preserves foreign hooks, custom profiles and other scopes.

Fake clients/config checks do not prove actual host loading.

<details>
<summary>Installation and recovery boundaries</summary>

Existing tests cover integrity/archive refusal, package/shim replacement, rollback after verification failure, killed-owner retry, concurrent installers and foreign-path preservation.
Retain recovery staging, archives and operation IDs on failure; a live owner, ambiguous lock, invalid journal or replaced target is not permission to delete it.
Package repair and application repair are separate results. Use the fresh executable at the same root to retry state recovery.
This trial does not establish network availability, publishing permissions, every OS/filesystem behavior or complete recovery from all interruptions.

</details>

## Actual host and one-day trial

**User-operated; explicit permission and normal host authentication required.**
Do not copy credentials, auto-grant trust, disable a real setup to make a control or infer IDE/Desktop support from a CLI run.

Before launching:

- Put the selected candidate's bin on the actual host process's PATH and use the approved delivery's `TONEDIAL_HOME`.
- Inside that host, prove bare `tonedial` resolves to the selected path/bytes (`command -v tonedial` where available) and state root. Version alone is insufficient; stop on mismatch or missing evidence before invoking the skill.
- `TONEDIAL_AGENT_HOME` redirects wiring only; it does not select/isolate the host profile.

### Run the trial

1. Select the exact installed candidate above and a dedicated host profile/project, or deliberately choose normal settings after reviewing the [usage and privacy limits](./USAGE.md).
   Record version/archive fingerprint, OS, host/surface/version, scope, model and effort.
2. Preview only that host and scope, then approve it. For a project use `init --tools codex --project <existing-directory> --dry-run`, then the same command without `--dry-run`; substitute the actual host and a real chosen directory before execution.
   Ensure the selected host actually reads that project/profile. Review the current hook definition in the host, including `/hooks` where applicable; for Antigravity IDE use the agent panel `… → Customizations → Hooks`, and for Antigravity Desktop use `Settings → Customizations → Hooks`. Do not use trust bypasses.
3. Start a fresh session and observe delivery of the complete guide before the exact current artifact.
   Test resume, clear, compaction and fork only where that surface has those events. Shared global/project layers must not duplicate context.
4. Ask the discovered skill to change one setting and separately to reload unchanged settings.
   Require CLI success, `compile --check --json`, then complete `agentsPath` and `path` reads. A settings query alone is not reload evidence.
   Turn delivery off and verify every connected lifecycle route emits an empty provider-valid response,
   then turn it on and verify the same saved pair returns. Use a fresh session to check the no-tone control;
   an open session may retain context delivered before `off`.
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

### Preview acceptance

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

**Freeze inputs → run fresh sessions → score independently → publish every outcome.**
Use [packs](./test/packs/), [scenarios](./test/scenarios.md) and the [rubric](./test/rubric.md).
One configuration/model is useful; the matrix below defines full coverage, not a minimum PR.
Anchor changes require Route D in Codex and Claude with matched clean `X-none` controls; keep Antigravity IDE/Desktop evidence separate.
The producer sees no predictions, repository design or judging instructions; the judge is a separate context.

The README's [default-vs-`vibe-coder` record](./media/readme/verbosity-comparison.json) is an `n=1`
illustration of a complete profile, not a scored measurement or a single-axis claim.
Its consumer test protects the displayed instruction, raw replies, hashes, profile bytes,
excluded preflight and evidence limits.

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
An axis-only probe must explicitly clear persona/address and restore auto register and `address_frequency=auto`; `reset` preserves these settings.
Verify compiled artifact bytes equal the pack and retain its SHA-256/full input/compiler revision plus guide fingerprint and actual delivery evidence.
Run each request at least twice in fresh sessions and report explicit `n`; controls use the matched request and a fresh no-tone session.
Compare only identical route/input/request conditions, and use both small and class-sized surfaces before generalizing axis counts.

### One-off single-axis arm

Prepare fresh temporary state/project and retain the same absolute installed candidate/environment.
Use explicit-scope state-only init, then `reset`; clear persona/address/safeword through the CLI and restore auto register and `address_frequency=auto` before changing only the selected axis to its 1–5 level.
Do not save it as a preset or hand-edit a managed artifact.
Require `preset: null`, empty persona/address, `speech_level: auto`, `address_frequency: auto`, no safeword, other style axes at 3 and other permission axes (`profanity`, `flattery`, `refusal`, `bravado`) at 1.
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

Keep request boundaries and verbatim outputs beside scores.
A host that did not deliver the selected artifact makes the run inconclusive.
