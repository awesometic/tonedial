// Serialize the state-free dial recipe; no saved settings, fonts or native client are read.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { cells } from "../src/ui/width.ts";

const result = spawnSync(process.execPath, [fileURLToPath(new URL("./dial-frame.ts", import.meta.url)), ...process.argv.slice(2)], { encoding: "utf8", env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
const frame = result.stdout;
const rows = frame.replace(/\n$/, "").split("\n");
const width = Math.max(...rows.map(line => cells(stripVTControlCharacters(line))));
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paints: Record<number, string> = { 31: "#ef8585", 32: "#61d8a4", 33: "#d8c35d", 36: "#66d9dc", 39: "#edf3f6" };
let colour = paints[39]!, bold = false, dim = false;
const text: string[] = [];
// ponytail: this frame's SGR and 2+ space columns only; revisit when the producer changes them.
for (const [row, line] of rows.entries()) {
  let column = 0;
  for (const part of line.split(/(\x1b\[[\d;]*m)/u)) {
    if (part.startsWith("\x1b[")) {
      for (const code of part.slice(2, -1).split(";").map(Number)) {
        if (code === 0) { colour = paints[39]!; bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (paints[code]) colour = paints[code]!;
        else throw new Error(`Unsupported dial style ${code}`);
      }
      continue;
    }
    if (part.includes("\x1b")) throw new Error("Unsupported dial escape");
    for (const run of part.split(/(\s{2,})/u)) {
      const span = cells(run);
      if (run.trim() && span > 0) text.push(`<text x="${32 + column * 14}" y="${48 + row * 28}" fill="${colour}" font-weight="${bold ? 700 : 400}" opacity="${dim ? 0.65 : 1}">${escape(run)}</text>`);
      column += span;
    }
  }
}
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width * 14 + 64}" height="${rows.length * 28 + 64}" viewBox="0 0 ${width * 14 + 64} ${rows.length * 28 + 64}" role="img" aria-labelledby="title description">
<title id="title">ToneDial synthetic dial (${process.argv[2] ?? "en"})</title>
<desc id="description">${escape(stripVTControlCharacters(frame))}</desc>
<rect width="100%" height="100%" rx="16" fill="#171b20"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, system-ui" font-size="22">${text.join("\n")}</g>
</svg>\n`);
