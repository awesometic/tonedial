# README languages and media

English is the default and editing source: `README.md` at the repository root.
`README.ko.md` is its Korean translation; each links to the other beside the title.
Do not create a second `README.en.md`, auto-select a language or translate command names, preset names or axis keys.
Other maintained guides remain English unless they declare their own language contract.

```text
README.md
README.ko.md
docs/media/readme/
  README.md
  en/
    dial.png
    dial-example.json
    voice-examples.json
    voice-examples.svg
  ko/
    dial.svg
    dial-example.json
    voice-examples.json
    voice-examples.svg
```

Use lowercase language tags for directories and lowercase-kebab-case semantic file stems.
The directory carries the language: use `dial`, not `dial-en` or `dial-ko`.
Keep the appropriate format (`png`, `jpg`, `svg`, `json`); translations share stems, not necessarily extensions.
Add a `shared/` directory only when an actual language-neutral asset needs it, never as an empty placeholder.
Locale-specific images must resolve inside that README's locale directory; link to metadata rather than duplicate provenance in captions.

The npm package does not ship `docs/` or `docs/media/`, so links that can appear on npm must use the public repository.
Use `https://github.com/awesometic/tonedial/blob/main/<path>` for guides and JSON metadata.
Use `https://raw.githubusercontent.com/awesometic/tonedial/main/<path>` for image `src` values;
an image's surrounding link may use the GitHub `blob` URL.
Keep the path's locale and file name identical to the repository asset.

Edit English first, translate Korean, then check natural Korean and every command, link and factual limitation.
Update the matching localized image and its accessible text in the same change.
The dial provenance test requires these canonical URLs and maps them back to local files before checking locale, hashes and renderer output.
Keep those checks when changing link forms.
The CLI's language setting and single English tone-anchor set are independent of README language.

Dial images use the current state-free recipe and per-locale input/frame/image hashes.
Regenerate the affected dial image when its renderer changes.
The Korean SVG is generated with `node scripts/dial-svg.ts ko 80`.
Use terminal cells to position glyphs; do not stretch glyph outlines to fill those cells.
Keep prose runs together; fixed cell positions belong to column boundaries, not each letter or word.
Run generation and media tests from the repository root with disposable state, and inspect glyph alignment before claiming a current image.


Recorded voice examples use the actual ToneDial test handoff and a disposable exec adapter
around the native Codex client, with no provider/UI imitation and no product capture API.
Each locale JSON owns all seven first completed replies, complete compiler inputs and tone/reply hashes.
README features only Royal Advisor and Ego Sword; `docs/EXAMPLES.md` and the declared Korean
translation `docs/EXAMPLES.ko.md` show every reply verbatim.
Generate the two-role image with `node scripts/voice-svg.ts en` or `node scripts/voice-svg.ts ko`.
These SVGs format transcripts; they are not screenshots of the native provider interface.
Retain model/client/effort/date metadata, failed-request notes and any unobserved evidence boundary.
Never polish model wording, retry a completed response for a preferred result, publish raw provider
journals or auth material, or treat these samples as hook activation or a scored measurement.
The consumer test checks locale links, all seven replies, exact hashes, current compiler inputs,
verbatim page content, featured selection and deterministic SVG output.
