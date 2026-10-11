// A synthetic current-dial example. No saved state, native client or real terminal is used.
// Run from the repository: node scripts/dial-frame.ts en 80 > frame.ansi

import { EventEmitter } from "node:events";

import { AXIS_ORDER } from "../src/core/anchors.ts";
import { catalogue, isLanguage } from "../src/core/i18n.ts";
import { BUNDLED, applyPreset } from "../src/core/presets.ts";
import { dial } from "../src/ui/dial.ts";
import { palette } from "../src/ui/style.ts";

const [language = "en", width = "80", ...extra] = process.argv.slice(2);
const columns = Number(width);
if (!isLanguage(language) || !Number.isInteger(columns) || columns < 60 || columns > 160 || extra.length) {
  process.stderr.write("Usage: node scripts/dial-frame.ts [en|ko] [columns: 60..160]\n");
  process.exit(2);
}

const preset = BUNDLED.find((entry) => entry.slug === "tough-love")!;
const input = new EventEmitter() as unknown as NodeJS.ReadStream;
Object.assign(input, { isTTY: false, isRaw: false, resume: () => input, pause: () => input });
const writes: string[] = [];
const output = new EventEmitter() as unknown as NodeJS.WriteStream;
Object.assign(output, { columns, rows: 24, isTTY: false, write: (text: string) => (writes.push(text), true) });
const pending = dial(applyPreset(preset), palette("always", {}, false, columns - 1), catalogue(language), input, output, {
  presetName: preset.displayName,
});
const key = (name: string) => input.emit("keypress", "", { name });
for (let index = 0; index < AXIS_ORDER.indexOf("warmth"); index++) key("down");
key("left"); // Tough Love warmth 5 -> unsaved preview 4.
const frame = writes.filter((text) => text.endsWith("\n") && text.includes("formality")).at(-1);
key("escape");
await pending;
if (frame === undefined) throw new Error("The current dial did not produce a complete example frame.");
process.stdout.write(frame);
