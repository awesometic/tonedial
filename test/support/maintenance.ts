import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseConfig, serializeConfig } from "../../src/core/config.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { seedFiles, seedRecord } from "../../src/core/seeds.ts";
import {
  captureCli,
  createGoldenWorkspace,
  normalizeCapture,
  type CliCapture,
  type GoldenLanguage,
} from "./golden.ts";

export const UPDATE_SCENARIOS = ["update-current", "update-refresh", "update-modified", "update-blocked", "update-invalid"] as const;
export type MaintenanceScenario = typeof UPDATE_SCENARIOS[number] | "doctor-seeds";

/** Real seed provenance in disposable state; dry runs never invoke a package manager. */
export async function captureMaintenance(
  language: GoldenLanguage,
  scenario: MaintenanceScenario,
  columns = 80,
): Promise<CliCapture> {
  const workspace = createGoldenWorkspace(language);
  workspace.env.COLUMNS = String(columns);
  try {
    const initialized = await captureCli(workspace, ["init", "--lang", language, "--tools", "none", "--global", "--auto", "--json"]);
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    const paths = resolvePaths(workspace.env);
    if (scenario === "update-invalid") {
      writeFileSync(paths.config, '{"private":"PRIVATE_CONFIG_CONTENT_4682"');
    } else if (scenario !== "update-current") {
      const config = parseConfig(readFileSync(paths.config, "utf8"));
      const seeds = seedFiles(paths, { native: true })
        .filter(seed => seed.id.startsWith("skill/") || seed.id.startsWith("preset/"));
      const states = scenario === "update-refresh"
        ? ["stale", "stale", "stale", "missing", "missing"]
        : scenario === "update-modified"
          ? ["modified", "modified"]
          : scenario === "update-blocked"
            ? ["current", "current", "foreign", "foreign"]
            : ["stale", "modified", "stale", "stale", "missing", "missing", "foreign", "foreign"];
      for (const [index, state] of states.entries()) {
        const seed = seeds[index]!;
        mkdirSync(dirname(seed.path), { recursive: true });
        writeFileSync(seed.path, seed.contents);
        config.managedSeeds[seed.id] = seedRecord(seed);
        if (state === "stale") {
          const old = { ...seed, version: Math.max(1, seed.version - 1), contents: `Previous generated ${seed.id}\n` };
          writeFileSync(seed.path, old.contents);
          config.managedSeeds[seed.id] = seedRecord(old);
        } else if (state === "modified") {
          writeFileSync(seed.path, `${seed.contents}\nLocal customization\n`);
        } else if (state === "missing") {
          rmSync(seed.path);
        } else if (state === "foreign") {
          const foreign = join(workspace.root, `foreign-${index}.json`);
          writeFileSync(foreign, seed.contents);
          rmSync(seed.path);
          symlinkSync(foreign, seed.path);
        }
      }
      writeFileSync(paths.config, serializeConfig(config));
    }
    if (scenario === "doctor-seeds") {
      writeFileSync(join(workspace.bin, "tonedial"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
    }
    const capture = normalizeCapture(await captureCli(workspace, scenario === "doctor-seeds"
      ? ["doctor", "--global"] : ["update", "--dry-run"]), workspace);
    assert.doesNotMatch(capture.stdout + capture.stderr, /PRIVATE_CONFIG_CONTENT_4682/);
    return capture;
  } finally {
    workspace.dispose();
  }
}
