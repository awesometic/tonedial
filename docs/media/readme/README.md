# README languages and media

**English first. Same facts in every locale. Real replies stay verbatim.**

[README copy](#readme-copy) · [Paths & links](#paths-and-links) · [Dial images](#dial-images) · [Recorded conversations](#recorded-conversations)

## README copy

| Language | README | Media directory |
|---|---|---|
| English, editing source | `README.md` | `en/` |
| Korean | `README.ko.md` | `ko/` |
| Japanese | `README.ja.md` | `ja/` |
| Simplified Chinese | `README.zh.md` | `zh/` |
| Spanish | `README.es.md` | `es/` |

Each README links to all five beside the title.
Do not add `README.en.md`, auto-select a locale or translate commands, preset names or axis keys.
Other guides stay English unless they declare a locale contract.
The CLI language and single English anchor set are independent of README language.

1. Edit English, then translate every maintained locale; polish Korean through the project's copy pipeline.
2. Keep commands, links, product facts and limitations aligned.
3. Update matching localized images and accessible text in the same change.
4. Run the consumer checks and inspect images:

```bash
node --test test/dial-example.test.ts test/voice-examples.test.ts
```

## Paths and links

All locale assets live in `docs/media/readme/<language>/`:

| File | Purpose |
|---|---|
| `dial.png` (en) / `dial.svg` (other locales) | Synthetic dial preview |
| `dial-example.json` | Dial input/frame/image hashes |
| `voice-examples.json` | Seven recorded replies and complete inputs/hashes |
| `voice-examples.svg` | README: Royal Advisor + Ego Sword |
| `voice-<preset>.svg` | Gallery: one conversation |
| `use-cases.json` | Three README recipes, complete commands and recorded Codex replies |

Use lowercase locale tags and kebab-case semantic stems: `ko/dial.svg`, not `dial-ko.svg`.
Locales share stems, not necessarily extensions; preserve the appropriate PNG/JPG/SVG/JSON format.
Add `shared/` only for an actual language-neutral asset.
Locale-specific images stay inside their locale directory; link provenance instead of repeating it in captions.
The shared public-v7 batch manifest is `docs/media/readme/capture-v7-manifest.json`;
it records candidate file hashes and path-redacted before/after capture manifests.

Npm omits `docs/`, so links visible there must use canonical repository URLs:

| Target | URL prefix |
|---|---|
| Guides, JSON, image wrapper links | `https://github.com/awesometic/tonedial/blob/main/` |
| Image `src` | `https://raw.githubusercontent.com/awesometic/tonedial/main/` |

Keep locale and filename identical to the repository asset.
The dial test resolves these URLs back to local files to verify provenance and renderer output; retain those checks.

## Dial images

Use the state-free current renderer from the repository root; these commands start no provider and read no saved state:

```bash
node scripts/dial-frame.ts en 80 > frame.ansi
node scripts/dial-frame.ts ko 120 > frame-ko.ansi
node scripts/dial-svg.ts ko 80 > dial-ko.svg
node scripts/demo.ts --list
node scripts/demo.ts sycophant ko
```

Demo scenes are isolated 80-column output; unknown options refuse before rendering/child startup.
Rasterization is optional development tooling: render ANSI with an image tool and inspect glyph/cell alignment.
Regenerate affected assets when the renderer changes; retain each locale's input/frame/image hashes in `dial-example.json`.
Use terminal cells at column boundaries, keep prose runs together and never stretch glyph outlines to fill cells.
Run generation/tests with disposable state; layout evidence does not prove native activation or adherence.

## Recorded conversations

The seven bundled-character samples came from the actual `tonedial test` handoff
to the native interactive Codex client.
There is no product capture API or provider-UI imitation.
Each locale JSON owns all seven **first completed** replies, complete compiler inputs and tone/reply hashes.
Each README features Royal Advisor and Ego Sword; `docs/EXAMPLES.md` and its four localized pages show all seven images with expandable verbatim text.

```bash
node scripts/voice-svg.ts en > voice-examples.svg
node scripts/voice-svg.ts ko royal-advisor > voice-royal-advisor.svg
```

Choose any supported locale (`en`, `ko`, `ja`, `zh`, `es`) and recorded preset slug.
These SVGs render terminal-style transcripts, not screenshots of the native provider UI.
Commands/speaker markers are presentation labels, not extra recorded reply text.
Preserve each locale's actual date, product revision, model/client/effort, failed-request notes and unobserved evidence limits.
When only some replies are recorded again, put their new metadata in each reply's `capture` object.
Keep the original batch metadata for unchanged replies; single-reply images use the capture override.
Never polish replies, rerun a completed response for preferred wording or inherit another locale's capture evidence.
Keep provider journals/auth material private; samples prove neither hook activation nor scored adherence.
The public JSON retains every assistant response before the fixed question and any explicit
intensity-approval turn, so their order can be audited without publishing the native journal.
The consumer test checks locale links, seven raw replies/hashes, current inputs, page text, featured selection and deterministic SVGs.

The three custom recipes below each README's opening gallery are recorded separately in `use-cases.json`.
Each locale owns its actual first completed replies to one shared question, full compiler inputs,
copyable CLI commands and native invocation metadata.
Run each recipe through the native interactive `tonedial test codex` client with `gpt-6.1-sol` and `high`.
Keep the opening prompt unchanged, wait for its response, then enter the question as a separate turn.
Use invocation-only model flags without saving personal defaults;
record the native session's observed model, reasoning effort and turn count.
Keep session journals private and publish only the selected verbatim response and relevant provenance.
Keep the commands and verbatim Markdown replies aligned with that locale's README.
The consumer test exercises every command with disposable state and checks the resulting compiler input and transcript hashes.
These dialogue-only examples neither edit a project nor establish hook activation or scored adherence;
preserve their recorded deviations as well as their replies.
