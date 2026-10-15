import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { renderDialSvg } from "../scripts/dial-svg.ts";
import {
  assertGolden,
  captureCli,
  captureDialFrame,
  createGoldenWorkspace,
  goldenDiff,
  goldenUpdateEnabled,
  normalizeCapture,
  selectedGoldenLanguages,
  type GoldenLanguage,
} from "./support/golden.ts";
import { captureMaintenance, UPDATE_SCENARIOS, type MaintenanceScenario } from "./support/maintenance.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactRoot = resolve(process.env.TONEDIAL_GOLDEN_ARTIFACT_DIR ?? join(root, "artifacts/golden"));
type ImageScenario = "pending" | "help" | "doctor-global" | MaintenanceScenario | "doctor-seeds-narrow";

function imageGoldenPath(language: GoldenLanguage, scenario: ImageScenario): string {
  return join(root, "test/golden/images", language, `${scenario}.svg`);
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function writeFailureReport(
  language: GoldenLanguage,
  scenario: ImageScenario,
  expected: string,
  actual: string,
  outputRoot = artifactRoot,
): string {
  const directory = join(outputRoot, language, scenario);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "expected.svg"), expected);
  writeFileSync(join(directory, "actual.svg"), actual);
  const diff = goldenDiff(expected, actual);
  writeFileSync(join(directory, "diff.txt"), diff);
  const expectedData = Buffer.from(expected).toString("base64");
  const actualData = Buffer.from(actual).toString("base64");
  writeFileSync(join(directory, "index.html"), `<!doctype html>
<meta charset="utf-8">
<title>ToneDial ${language} ${scenario} golden diff</title>
<style>body{background:#171b20;color:#edf3f6;font:16px system-ui,sans-serif;margin:2rem}main{display:grid;gap:1rem;grid-template-columns:repeat(2,minmax(0,1fr))}figure{margin:0}img{background:#fff;max-width:100%;border:1px solid #64727b}pre{background:#0d1114;overflow:auto;padding:1rem;white-space:pre-wrap}</style>
<h1>ToneDial ${language} ${scenario} golden diff</h1>
<main><figure><figcaption>Expected</figcaption><img alt="Expected ${language} ${scenario}" src="data:image/svg+xml;base64,${expectedData}"></figure><figure><figcaption>Actual</figcaption><img alt="Actual ${language} ${scenario}" src="data:image/svg+xml;base64,${actualData}"></figure></main>
<h2>Changed SVG lines</h2><pre>${htmlEscape(diff)}</pre>
`);
  return join(directory, "index.html");
}

test("image golden reports retain both renderings and a readable diff", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "tonedial-image-report-"));
  try {
    const report = writeFailureReport("en", "help", "<svg>expected</svg>\n", "<svg>actual</svg>\n", outputRoot);
    const directory = dirname(report);
    assert.ok(existsSync(join(directory, "expected.svg")));
    assert.ok(existsSync(join(directory, "actual.svg")));
    assert.ok(existsSync(join(directory, "diff.txt")));
    assert.match(readFileSync(report, "utf8"), /Expected[\s\S]*Actual[\s\S]*Changed SVG lines/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("image goldens reject an invalid update policy before matching a baseline", () => {
  assert.throws(
    () => goldenUpdateEnabled({ TONEDIAL_GOLDEN_UPDATE: "2" }),
    /TONEDIAL_GOLDEN_UPDATE must be 1/,
  );
});

async function captureDoctor(language: GoldenLanguage): Promise<string> {
  const workspace = createGoldenWorkspace(language);
  try {
    const initialized = await captureCli(workspace, ["init", "--lang", language, "--tools", "none", "--global", "--auto", "--json"]);
    assert.equal(initialized.status, 0, `${language}: doctor setup failed: ${initialized.stderr}`);
    const capture = normalizeCapture(await captureCli(workspace, ["doctor", "--global"]), workspace);
    assert.equal(capture.status, 0, `${language}: doctor failed: ${capture.stderr}`);
    assert.ok(capture.stdout.length > 0, `${language}: doctor produced no human output`);
    return capture.stdout;
  } finally {
    workspace.dispose();
  }
}

async function captureImage(language: GoldenLanguage, scenario: ImageScenario): Promise<string> {
  if (scenario === "doctor-global") return renderDialSvg(await captureDoctor(language), language, `${language} · doctor --global`);
  if (scenario !== "pending" && scenario !== "help") {
    const capture = await captureMaintenance(language, scenario === "doctor-seeds-narrow" ? "doctor-seeds" : scenario,
      scenario === "doctor-seeds-narrow" ? 60 : 80);
    return renderDialSvg(capture.stdout + capture.stderr, language, `${language} · ${scenario}`);
  }
  const frame = await captureDialFrame(language, scenario, 80);
  assert.ok(frame.visible.length > 0, `${language} ${scenario}: empty frame cannot be an image golden`);
  return renderDialSvg(frame.ansi, language, `${language} · dial ${scenario}`);
}

function assertImageGolden(language: GoldenLanguage, scenario: ImageScenario, actual: string): void {
  const path = imageGoldenPath(language, scenario);
  const update = goldenUpdateEnabled();
  if (!existsSync(path) || update) {
    assertGolden(path, actual);
    return;
  }
  const expected = readFileSync(path, "utf8");
  if (actual === expected) return;
  const report = writeFailureReport(language, scenario, expected, actual);
  assert.fail(`${language} ${scenario}: image golden differs; open ${report}`);
}

for (const language of selectedGoldenLanguages()) {
  test(`representative ${language} screen images match their SVG goldens`, async (t) => {
    for (const scenario of ["pending", "help", "doctor-global", ...UPDATE_SCENARIOS, "doctor-seeds", "doctor-seeds-narrow"] as const) {
      await t.test(scenario, async () => {
        assertImageGolden(language, scenario, await captureImage(language, scenario));
      });
    }
  });
}
