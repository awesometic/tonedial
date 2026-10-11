import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const kind of ["fifo", "directory", "symlink"] as const) {
  test(`language bootstrap ignores a ${kind} config entry without blocking`, {
    skip: kind === "fifo" && process.platform === "win32",
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "tonedial-locale-"));
    try {
      const path = join(root, "config.json");
      if (kind === "fifo") execFileSync("mkfifo", [path]);
      if (kind === "directory") mkdirSync(path);
      if (kind === "symlink") {
        const other = join(root, "other.json");
        writeFileSync(other, '{"language":"ko"}');
        symlinkSync(other, path);
      }
      const script = `
        import { configLanguage } from ${JSON.stringify(new URL("../src/core/i18n.ts", import.meta.url).href)};
        process.stdout.write(JSON.stringify({ language: configLanguage(${JSON.stringify(path)}) }));
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8", timeout: 2000,
        env: { HOME: root, TMPDIR: root, PATH: "" },
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { language: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("language bootstrap rejects a config replaced by a FIFO after inspection", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-locale-race-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, '{"language":"ko"}');
    const script = `
      import fs from "node:fs";
      import { execFileSync } from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { configLanguage } from ${JSON.stringify(new URL("../src/core/i18n.ts", import.meta.url).href)};
      const target = ${JSON.stringify(path)};
      const open = fs.openSync;
      const read = fs.readFileSync;
      let replaced = false;
      let payloadReads = 0;
      function replace(path) {
        if (path !== target || replaced) return;
        replaced = true;
        fs.renameSync(target, target + ".saved");
        execFileSync("mkfifo", [target]);
      }
      fs.openSync = (path, ...args) => { replace(path); return open(path, ...args); };
      fs.readFileSync = (path, ...args) => {
        replace(path);
        if (path === target || typeof path === "number") payloadReads++;
        return read(path, ...args);
      };
      syncBuiltinESMExports();
      const language = configLanguage(target);
      process.stdout.write(JSON.stringify({ replaced, payloadReads, language }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 2000,
      env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { replaced: true, payloadReads: 0, language: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("language bootstrap bounds a regular config before parsing its private body", () => {
  const root = mkdtempSync(join(tmpdir(), "tonedial-locale-size-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ language: "ko", private: "x".repeat(256 * 1024) }));
    const script = `
      import { configLanguage } from ${JSON.stringify(new URL("../src/core/i18n.ts", import.meta.url).href)};
      process.stdout.write(JSON.stringify({ language: configLanguage(${JSON.stringify(path)}) }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 2000, env: { HOME: root, TMPDIR: root, PATH: "" },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { language: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
