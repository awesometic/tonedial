import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_COLUMNS, SCENES, render } from "../scripts/demo.ts";
import { AXIS_ORDER } from "../src/core/anchors.ts";
import { maxCells } from "../src/ui/width.ts";
import { LANGUAGES, catalogue } from "../src/core/i18n.ts";

const RETAKE = "the screenshots need retaking — node scripts/demo.ts <scene> <language>";

test("retired and unknown demo options refuse before rendering, writing or starting a child", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tonedial-demo-options-"));
  const preload = join(scratch, "no-child.mjs");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  writeFileSync(preload, `import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawnSync = () => {
  writeFileSync(${JSON.stringify(join(scratch, "child-started"))}, "unexpected child\\n");
  throw new Error("demo options must be checked before any child starts");
};
syncBuiltinESMExports();
`);
  try {
    for (const args of [["sycophant", "en", "--ask"], ["sycophant", "en", "--unknown"], ["--help", "--ask"]]) {
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(root, "scripts/demo.ts"), ...args], {
        cwd: root, encoding: "utf8",
        env: {
          HOME: join(scratch, "home"), TONEDIAL_HOME: join(scratch, "state"),
          TONEDIAL_AGENT_HOME: join(scratch, "agents"), TMPDIR: scratch, TMP: scratch, TEMP: scratch, PATH: "",
        },
      });
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, "", "a rejected option must not render a screen");
      assert.match(result.stderr, /unsupported option/);
      assert.deepEqual(readdirSync(scratch), ["no-child.mjs"], "a rejected option must not write state or start a child");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("every scene carries its address terms in every language the interface ships", () => {
  // The guard that makes another language cheap rather than quietly incomplete. `LANGUAGES` is
  // the product's own list, so adding one to the catalogue fails this until the scenes follow —
  // which is the whole reason the scenes are a table and not three branches in a script.
  for (const scene of SCENES) {
    if (scene.address === null) continue;
    for (const language of LANGUAGES) {
      const address = scene.address[language];
      assert.ok(address, `scene ${scene.id} has no ${language} address terms`);
      assert.ok(address.self.trim() && address.user.trim(), `scene ${scene.id}'s ${language} terms are blank`);
    }
  }
});

test("the scenes are distinct, so each screenshot shows something else", () => {
  const ids = SCENES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `two scenes share an id: ${ids.join(", ")}`);
  const presets = SCENES.map((s) => `${s.preset} ${s.settings.join(" ")}`);
  assert.equal(new Set(presets).size, presets.length, `two scenes show the same configuration`);
});

for (const scene of SCENES) {
  for (const language of LANGUAGES) {
    test(`the ${scene.id} scene renders current gauges and settings in ${language}`, () => {
      const output = render(scene, language);
      const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

      // Every axis, once. The gauge block is the reason the screenshots exist, and the axis
      // names stay English in every language because they are what a person types.
      for (const axis of AXIS_ORDER) {
        assert.ok(plain.includes(axis), `${axis} is missing from ${scene.id}/${language} — ${RETAKE}`);
      }
      for (const group of ["form", "target", "behaviour"]) {
        assert.ok(plain.includes(group), `the ${group} label is gone from ${scene.id}/${language} — ${RETAKE}`);
      }
      assert.match(plain, /TONE\.md [\d,]+ \/ [\d,]+/, `the budget line changed in ${scene.id}/${language} — ${RETAKE}`);
      assert.match(plain, /[▮▯]{5}\s+\d!?\s+\*\d/, `changed axes lost their default values — ${RETAKE}`);

      // The isolated recipe owns 80-column geometry, including Korean and emoji cell widths.
      for (const line of plain.split("\n")) {
        assert.ok(maxCells(line) < DEMO_COLUMNS, `${maxCells(line)} cells in ${scene.id}/${language}: ${line}`);
      }

      // Each scene earns its place by showing something the others do not.
      const address = scene.address?.[language];
      if (address) {
        assert.ok(plain.includes(address.self), `${scene.id}/${language} lost its self-reference — ${RETAKE}`);
        assert.ok(plain.includes(address.user), `${scene.id}/${language} lost its address — ${RETAKE}`);
      }
      if (scene.id === "risky-tone") {
        const warning = catalogue(language).cli.notice.riskAxes(["critique"]);
        assert.ok(
          plain.replace(/\s+/g, " ").includes(warning.split(" · ")[1]!),
          `${scene.id}/${language} no longer explains risky levels — ${RETAKE}`,
        );
      }
    });
  }
}

test("the isolated scene geometry ignores the caller's declared terminal width", () => {
  const before = process.env.COLUMNS;
  try {
    process.env.COLUMNS = "200";
    const wideCaller = render(SCENES[0]!, "ko");
    process.env.COLUMNS = "60";
    assert.equal(render(SCENES[0]!, "ko"), wideCaller);
    const plain = wideCaller.replace(/\x1b\[[0-9;]*m/g, "");
    for (const line of plain.split("\n")) assert.ok(maxCells(line) < DEMO_COLUMNS, line);
  } finally {
    if (before === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = before;
  }
});
