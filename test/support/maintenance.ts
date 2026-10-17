import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

import { parseConfig, serializeConfig } from "../../src/core/config.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { seedFiles, seedRecord } from "../../src/core/seeds.ts";
import { acquireOperation, beginJournal, finishJournal, inspectOperations, releaseOperation } from "../../src/core/operations.ts";
import {
  captureCli,
  createGoldenWorkspace,
  normalizeCapture,
  type CliCapture,
  type GoldenLanguage,
} from "./golden.ts";

export const UPDATE_SCENARIOS = ["update-current", "update-refresh", "update-modified", "update-blocked", "update-invalid"] as const;
export type MaintenanceScenario = typeof UPDATE_SCENARIOS[number] | "doctor-seeds";
export const RECOVERY_SCENARIOS = ["doctor-recovery-stopped", "doctor-recovery-invalid", "doctor-recovery-multiple", "doctor-rebuild-failed"] as const;
export type RecoveryScenario = typeof RECOVERY_SCENARIOS[number];
export const RECOVERY_OPERATION_ID = "f".repeat(32);

/** This child exits with a real pending owner after retaining completed history. */
export function seedRecoveryHistory(env: NodeJS.ProcessEnv): void {
  const paths = resolvePaths(env);
  for (let index = 1; index <= 8; index++) {
    const handle = acquireOperation(paths, "mutation", index.toString(16).padStart(32, "0"));
    beginJournal(handle, []);
    finishJournal(handle, "complete");
    releaseOperation(handle);
  }
  beginJournal(acquireOperation(paths, "mutation", RECOVERY_OPERATION_ID), []);
}

export async function captureRecovery(language: GoldenLanguage, scenario: RecoveryScenario, columns = 80): Promise<CliCapture> {
  const workspace = createGoldenWorkspace(language);
  workspace.env.COLUMNS = String(columns);
  let restoreFault: (() => void) | null = null;
  try {
    const initialized = await captureCli(workspace, ["init", "--lang", language, "--tools", "none", "--global", "--auto", "--json"]);
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    const paths = resolvePaths(workspace.env);
    if (scenario === "doctor-recovery-stopped") {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval",
        `import { seedRecoveryHistory } from ${JSON.stringify(import.meta.url)}; seedRecoveryHistory(process.env);`],
      { env: workspace.env, encoding: "utf8", timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr);
    } else if (scenario === "doctor-recovery-invalid" || scenario === "doctor-recovery-multiple") {
      writeFileSync(join(paths.operations, `${RECOVERY_OPERATION_ID}.json`), "invalid journal\n", { mode: 0o640 });
      if (scenario === "doctor-recovery-multiple") writeFileSync(join(paths.operations, `${"e".repeat(32)}.json`), "another invalid journal\n", { mode: 0o600 });
    } else {
      const config = parseConfig(readFileSync(paths.config, "utf8"));
      const seeds = seedFiles(paths, { native: true }).filter(seed => seed.id.startsWith("skill/"));
      for (const seed of seeds) {
        mkdirSync(dirname(seed.path), { recursive: true });
        const contents = seed.id === "skill/body" ? "Previous generated skill.\n" : seed.contents;
        writeFileSync(seed.path, contents);
        config.managedSeeds[seed.id] = seedRecord({ ...seed, contents });
      }
      writeFileSync(paths.config, serializeConfig(config));
      const target = seeds[0]!.path;
      const originalRename = fs.renameSync;
      const fault = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === target) throw Object.assign(new Error("PRIVATE_RECOVERY_FAILURE_4682"), { code: "EACCES", path: target, syscall: "rename" });
        originalRename(from, to);
      });
      syncBuiltinESMExports();
      restoreFault = () => { fault.mock.restore(); syncBuiltinESMExports(); };
    }
    let capture = normalizeCapture(await captureCli(workspace, scenario !== "doctor-rebuild-failed"
      ? ["doctor", "--global"] : ["doctor", "--fix", "--global", "--auto"]), workspace);
    if (scenario === "doctor-recovery-stopped") {
      assert.equal(capture.status, 0, capture.stderr);
      assert.equal(capture.stderr, "");
      assert.ok(capture.stdout.includes(RECOVERY_OPERATION_ID));
      for (let index = 1; index <= 8; index++) assert.ok(!capture.stdout.includes(index.toString(16).padStart(32, "0")), "completed history leaked into the default recovery report");
    } else if (scenario === "doctor-recovery-invalid" || scenario === "doctor-recovery-multiple") {
      assert.equal(capture.status, 0, capture.stderr);
      assert.equal(capture.stderr, "");
      const next = scenario === "doctor-recovery-multiple" ? "e".repeat(32) : RECOVERY_OPERATION_ID;
      assert.ok(capture.stdout.includes(`tonedial doctor --fix --quarantine-operation ${next} --global`));
    } else {
      assert.equal(capture.status, 1, capture.stdout + capture.stderr);
      assert.match(capture.stderr, /EACCES/);
      assert.ok(capture.stderr.includes("SKILL.md"), "failed rebuild must identify its target");
      for (const { operationId } of inspectOperations(paths).journals) {
        capture = { ...capture, stdout: capture.stdout.replaceAll(operationId, "<OPERATION_ID>"), stderr: capture.stderr.replaceAll(operationId, "<OPERATION_ID>") };
      }
    }
    assert.doesNotMatch(capture.stdout + capture.stderr, /PRIVATE_RECOVERY_FAILURE_4682/);
    return capture;
  } finally {
    restoreFault?.();
    workspace.dispose();
  }
}

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
