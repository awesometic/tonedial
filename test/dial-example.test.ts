import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { AXIS_ORDER } from "../src/core/anchors.ts";
import { maxCells } from "../src/ui/width.ts";
import { catalogue, LANGUAGES } from "../src/core/i18n.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const REPOSITORY_BLOB = "https://github.com/awesometic/tonedial/blob/main/";
const REPOSITORY_RAW = "https://raw.githubusercontent.com/awesometic/tonedial/main/";
function localAssetPath(reference: string, prefix: string): string {
  assert.ok(reference.startsWith(prefix), `README asset must use ${prefix}: ${reference}`);
  return resolve(root, reference.slice(prefix.length));
}

for (const language of LANGUAGES) {
  const file = language === "en" ? "README.md" : `README.${language}.md`;
  test(`${file} resolves its own locale's current state-free dial frame`, () => {
    const readme = readFileSync(join(root, file), "utf8");
    const image = /<img\s+src="([^"]+)"/.exec(readme)?.[1];
    assert.ok(image, "README must expose a dial image to resolve");
    for (const [, asset] of readme.matchAll(/<img\s+src="([^"]+)"/g)) {
      assert.equal(dirname(localAssetPath(asset!, REPOSITORY_RAW)), join(root, "docs/media/readme", language), "README images must stay in their locale folder");
    }
    const imagePath = localAssetPath(image, REPOSITORY_RAW);
    const metadataLink = /href="([^"]+\/dial-example\.json)"/.exec(readme)?.[1];
    assert.ok(metadataLink, "the image needs discoverable locale provenance");
    const metadataPath = localAssetPath(metadataLink, REPOSITORY_BLOB);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.language, language, "a translation cannot use another locale's frame");
    assert.equal(dirname(imagePath), dirname(metadataPath));
    assert.equal(hash(readFileSync(imagePath)), metadata.imageSha256);
    const inputs = Object.entries(metadata.inputs) as [string, string][];
    assert.ok(inputs.length > 0, "image inputs cannot be an empty discovery");
    for (const [path, expected] of inputs) assert.equal(hash(readFileSync(resolve(root, path))), expected, `${path}: regenerate the example after renderer changes`);

    const scratch = mkdtempSync(join(tmpdir(), "tonedial-dial-example-"));
    try {
      const state = join(scratch, "state"), agents = join(scratch, "agents"), home = join(scratch, "home");
      for (const path of [state, agents, home]) mkdirSync(path);
      const original = "Invalid dummy settings: the frame extractor must not load these.\n";
      writeFileSync(join(state, "config.json"), original);
      const env = { HOME: home, XDG_CONFIG_HOME: home, TONEDIAL_HOME: state, TONEDIAL_AGENT_HOME: agents, PATH: "", LANG: "en_US.UTF-8" };
      const result = spawnSync(process.execPath, [join(root, "scripts/dial-frame.ts"), metadata.language, String(metadata.columns)], { cwd: root, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(hash(result.stdout), metadata.frameSha256);
      if (imagePath.endsWith(".svg")) {
        assert.ok(Array.isArray(metadata.svgRecipe), "SVG provenance must name its generator");
        const svg = spawnSync(process.execPath, [resolve(root, metadata.svgRecipe[0]), ...metadata.svgRecipe.slice(1)], { cwd: root, env, encoding: "utf8" });
        assert.equal(svg.status, 0, svg.stderr);
        assert.equal(svg.stdout, readFileSync(imagePath, "utf8"));
        assert.doesNotMatch(svg.stdout, /\b(?:textLength|lengthAdjust)=/, "cell widths position glyphs without stretching their outlines");
        if (language === "ko") {
          const word = stripVTControlCharacters(result.stdout).split(/\s+/u).find(token => /^\p{Script=Hangul}{2,}$/u.test(token));
          assert.ok(word, "the Korean frame must expose a word to check shaping");
          assert.match(svg.stdout, new RegExp(`>[^<]*${word}[^<]*</text>`), "Korean words must render together without artificial inter-glyph spacing");
        }
        assert.ok(svg.stdout.includes(stripVTControlCharacters(result.stdout).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")), "the SVG must contain the complete current frame");
        assert.ok(!svg.stdout.includes("\x1b"));
      }
      const visible = stripVTControlCharacters(result.stdout).trimEnd().split("\n");
      assert.ok(visible.length < metadata.terminalRows);
      for (const line of visible) assert.ok(maxCells(line) < metadata.columns, line);
      assert.deepEqual(visible.filter(line => /[▮▯]/u.test(line)).map(line => AXIS_ORDER.find(axis => line.includes(axis))), AXIS_ORDER);
      assert.match(visible.find(line => line.startsWith("> "))!, /warmth\s+▮▮▮▮▯\s+4/);
      assert.ok(visible[1]!.includes(catalogue(language).cli.artifact.dialPreview("", true).trim()));
      assert.equal(readFileSync(join(state, "config.json"), "utf8"), original);
      assert.deepEqual(readdirSync(state), ["config.json"]);
      assert.deepEqual(readdirSync(agents), []);
      assert.deepEqual(readdirSync(home), []);
      const refused = spawnSync(process.execPath, [join(root, "scripts/dial-frame.ts"), "en", "40"], { cwd: root, env, encoding: "utf8" });
      assert.equal(refused.status, 2);
      assert.equal(refused.stdout, "");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
