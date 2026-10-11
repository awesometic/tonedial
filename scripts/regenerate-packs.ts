// Rewrite only generated artifacts and counts, preserving pack prose.
// This closes the compiler/fixture loop; anchor wording still needs external measurement.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, type Config } from "../src/core/compile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The packs have their own directory, so "every file here" is the whole rule.
const PACKS = join(ROOT, "docs", "test", "packs");
const FIXTURES = join(ROOT, "test", "fixtures");

/** Packs whose artifacts come from more than one fixture, in the order the blocks appear. */
const MULTI: Record<string, string[]> = { "persona-leak": ["persona-leak-a", "persona-leak-b"] };

const check = process.argv.includes("--check");
const changed: string[] = [];
for (const file of readdirSync(PACKS).sort().filter((name) => name.endsWith(".md"))) {
  const base = file.replace(/\.md$/, "");
  const names = MULTI[base] ?? [base];
  const path = join(PACKS, file);
  const before = readFileSync(path, "utf8");

  let i = 0;
  const after = before.replace(/(```markdown\n)([\s\S]*?)(```)/g, (_m, open: string, _body, close: string) => {
    const name = names[i++];
    if (!name) throw new Error(`${file}: more artifact blocks than fixtures`);
    const { config } = JSON.parse(
      readFileSync(join(FIXTURES, `${name}.config.json`), "utf8"),
    ) as { config: Config };
    return open + compile(config) + close;
  });
  if (i !== names.length) throw new Error(`${file}: ${i} artifact blocks, expected ${names.length}`);

  // A single-artifact pack records its own character count in the frontmatter. Keep it true.
  const blocks = [...after.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const withChars =
    names.length === 1 && /^chars: \d+$/m.test(after)
      ? after.replace(/^chars: \d+$/m, `chars: ${[...blocks[0]!].length}`)
      : after;

  if (withChars === before) continue;
  changed.push(file);
  if (!check) writeFileSync(path, withChars);
}

if (check) {
  if (changed.length) {
    console.error(`packs differ from the compiler:\n  ${changed.join("\n  ")}`);
    process.exit(1);
  }
  console.log("packs match the compiler");
} else if (!changed.length) {
  console.log("packs already match the compiler");
} else {
  console.log(`rewrote ${changed.join(", ")}`);
}
