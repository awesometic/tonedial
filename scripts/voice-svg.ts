// Render recorded replies only; no provider, saved settings or font files are read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cells, wrap } from "../src/ui/width.ts";
import { isLanguage, LANGUAGES, type Language } from "../src/core/i18n.ts";
import { wrapTranscript } from "./voice-wrap.ts";

const language = process.argv[2];
const selectedPreset = process.argv[3];
if (language === undefined || !isLanguage(language) || process.argv.length < 3 || process.argv.length > 4) throw new Error(`Usage: node scripts/voice-svg.ts [${LANGUAGES.join("|")}] [PRESET]`);
const labels: Record<Language, { title: string; footer: string }> = {
  en: { title: "Recorded Codex voice examples", footer: "Real replies · formatted transcript · one sample per preset" },
  ko: { title: "Codex의 실제 말투 응답", footer: "실제 응답 · 형식만 정리 · 프리셋당 1회" },
  ja: { title: "Codexの実際の口調例", footer: "実際の応答 · 原文の表示整形 · 各プリセット1件" },
  zh: { title: "Codex 实际语气示例", footer: "实际回复 · 仅整理显示格式 · 每个预设一例" },
  es: { title: "Ejemplos reales de tono de Codex", footer: "Respuestas reales · transcripción con formato · una muestra por preajuste" },
};
const copy = labels[language];
const data = JSON.parse(readFileSync(fileURLToPath(new URL(`../docs/media/readme/${language}/voice-examples.json`, import.meta.url)), "utf8"));
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text: string[] = [];
const line = (value: string, y: number, size = 24, colour = "#edf3f6", weight = 400) =>
  text.push(`<text x="36" y="${y}" fill="${colour}" font-size="${size}" font-weight="${weight}" xml:space="preserve">${value}</text>`);
let y = 80;
const replies = (data.replies as { preset: string; displayName: string; text: string;
  capture?: { model: string; reasoningEffort: string; recordedOn: string } }[])
  .filter(reply => selectedPreset === undefined ? data.featured.includes(reply.preset) : reply.preset === selectedPreset);
if (replies.length !== (selectedPreset === undefined ? 2 : 1)) throw new Error("Select one recorded preset, or omit PRESET for the two README roles");
const metadata = selectedPreset === undefined ? data : (replies[0]!.capture ?? data);
line(escape(`Codex CLI · ${metadata.model} · ${metadata.reasoningEffort}`), 50, 24, "#66d9dc", 700);
for (const reply of replies) {
  text.push(`<path d="M36 ${y}H1084" stroke="#34424d"/>`);
  y += 46;
  line(escape(reply.displayName), y, 28, "#66d9dc", 700);
  y += 34;
  line(escape(`$ tonedial test codex --preset ${reply.preset}`), y, 20, "#b8cbd4");
  y += 42;
  for (const row of wrap(`> ${data.question}`, 68)) {
    line(escape(row), y, 23, "#b8e5df");
    y += 32;
  }
  y += 8;
  line("codex", y, 20, "#b8cbd4");
  y += 34;
  let bold = false, code = false;
  // Keep the native text in the accessible transcript; only inline presentation changes.
  // shortcut: bold, code and simple lists only; extend for richer recorded Markdown.
  let fenced = false;
  const rows = reply.text.split("\n").flatMap(source => {
    if (/^```\w*\s*$/u.test(source)) { fenced = !fenced; return []; }
    const marker = fenced ? "" : /^(?:[-*] |\d+\. )/u.exec(source)?.[0] ?? "";
    return (fenced ? wrap(source.slice(marker.length), 68 - cells(marker))
      : wrapTranscript(source.slice(marker.length), 68 - cells(marker), language))
      .map((row, index) => ({ row: (index === 0 ? marker : " ".repeat(cells(marker))) + row, fenced }));
  });
  for (const { row, fenced } of rows) {
    const spans = fenced ? `<tspan fill="#b8e5df">${escape(row)}</tspan>` : row.split(/(\*\*|`)/u).map(part => {
      if (part === "**" && !code) { bold = !bold; return ""; }
      if (part === "`") { code = !code; return ""; }
      return `<tspan font-weight="${bold ? 700 : 400}" fill="${code ? "#b8e5df" : "#edf3f6"}">${escape(part)}</tspan>`;
    }).join("");
    line(spans, y);
    y += 32;
  }
  y += 24;
}
line(escape(`${copy.footer} · ${metadata.recordedOn}`), y + 12, 20, "#b8cbd4");
const raw = replies.map((reply: { displayName: string; text: string }) => `${reply.displayName}\n${reply.text}`).join("\n\n");
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${y + 48}" viewBox="0 0 1120 ${y + 48}" role="img" aria-labelledby="title description">
<title id="title">${escape(copy.title)}</title>
<desc id="description">${escape(data.question + "\n\n" + raw)}</desc>
<rect width="1120" height="${y + 48}" rx="16" fill="#171b20"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, system-ui">${text.join("\n")}</g>
</svg>\n`);
