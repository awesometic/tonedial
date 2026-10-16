import assert from "node:assert/strict";
import { test } from "node:test";

import { wrapTranscript } from "../scripts/voice-wrap.ts";
import { maxCells } from "../src/ui/width.ts";

const displayed = (value: string) => value.replaceAll("**", "").replaceAll("`", "");

test("transcript wrapping keeps fitting inline code whole", () => {
  const rows = wrapTranscript(`${"界".repeat(31)} \`fetchData\` 后续`, 68, "zh");
  assert.ok(rows.some((row) => row.includes("`fetchData`")));
  assert.ok(rows.every((row) => maxCells(displayed(row)) <= 68));
  assert.equal(rows.join(""), `${"界".repeat(31)}\`fetchData\` 后续`);
});

test("transcript wrapping moves content with closing punctuation without overflowing", () => {
  const source = `${"a".repeat(68)}.`;
  const rows = wrapTranscript(source, 68, "en");
  assert.equal(rows.join(""), source);
  assert.ok(rows.every((row) => maxCells(displayed(row)) <= 68));
  assert.doesNotMatch(displayed(rows.at(-1)!), /^[.]+$/u);
});

test("transcript wrapping refuses inline code that cannot fit atomically", () => {
  assert.throws(() => wrapTranscript(`\`${"a".repeat(69)}\``, 68, "en"), /Inline code exceeds/);
  assert.throws(() => wrapTranscript(`\`${"a".repeat(68)}\`.`, 68, "en"), /Inline code and closing punctuation exceed/);
});
