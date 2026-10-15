// Render recorded replies only; no provider, saved settings or font files are read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrap } from "../src/ui/width.ts";

const language = process.argv[2];
if ((language !== "en" && language !== "ko") || process.argv.length !== 3) throw new Error("Usage: node scripts/voice-svg.ts [en|ko]");
const data = JSON.parse(readFileSync(fileURLToPath(new URL(`../docs/media/readme/${language}/voice-examples.json`, import.meta.url)), "utf8"));
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text: string[] = [];
const line = (value: string, y: number, size = 24, colour = "#edf3f6", weight = 400) =>
  text.push(`<text x="36" y="${y}" fill="${colour}" font-size="${size}" font-weight="${weight}" xml:space="preserve">${value}</text>`);
line(escape(`Codex CLI · ${data.model} · ${data.reasoningEffort}`), 50, 24, "#66d9dc", 700);
line(escape(`${language === "ko" ? "질문" : "You"}: ${data.question}`), 86, 23, "#b8cbd4");
let y = 112;
const replies = (data.replies as { preset: string; displayName: string; text: string }[])
  .filter(reply => data.featured.includes(reply.preset));
if (replies.length !== 2) throw new Error("README must feature exactly two recorded roles");
for (const reply of replies) {
  text.push(`<path d="M36 ${y}H1084" stroke="#34424d"/>`);
  y += 46;
  line(escape(reply.displayName), y, 28, "#66d9dc", 700);
  y += 44;
  let bold = false, code = false;
  // Keep the native text in the accessible transcript; only inline presentation changes.
  for (const row of wrap(reply.text, 68)) {
    const spans = row.split(/(\*\*|`)/u).map(part => {
      if (part === "**" && !code) { bold = !bold; return ""; }
      if (part === "`") { code = !code; return ""; }
      return `<tspan font-weight="${bold ? 700 : 400}" fill="${code ? "#b8e5df" : "#edf3f6"}">${escape(part)}</tspan>`;
    }).join("");
    line(spans, y);
    y += 32;
  }
  y += 24;
}
const footer = language === "ko" ? "실제 응답 · 형식만 정리 · 프리셋당 1회" : "Real replies · formatted transcript · one sample per preset";
line(escape(`${footer} · ${data.recordedOn}`), y + 12, 20, "#b8cbd4");
const raw = replies.map((reply: { displayName: string; text: string }) => `${reply.displayName}\n${reply.text}`).join("\n\n");
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${y + 48}" viewBox="0 0 1120 ${y + 48}" role="img" aria-labelledby="title description">
<title id="title">${escape(language === "ko" ? "Codex의 실제 말투 응답" : "Recorded Codex voice examples")}</title>
<desc id="description">${escape(data.question + "\n\n" + raw)}</desc>
<rect width="1120" height="${y + 48}" rx="16" fill="#171b20"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, system-ui">${text.join("\n")}</g>
</svg>\n`);
