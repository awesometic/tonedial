import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertGolden,
  captureDialFrame,
  goldenPath,
  selectedGoldenLanguages,
  type DialFrameScenario,
} from "./support/golden.ts";

const scenarios: readonly DialFrameScenario[] = ["pending", "help", "too-small"];

for (const language of selectedGoldenLanguages()) {
  test(`interactive frame goldens · ${language}`, async () => {
    for (const scenario of scenarios) {
      const frame = await captureDialFrame(language, scenario);
      assert.ok(frame.visible.length > 0, `${language} ${scenario}: empty frame cannot be a golden`);
      assertGolden(goldenPath(language, "frames", scenario), `${frame.visible}\n`);
    }
  });
}
