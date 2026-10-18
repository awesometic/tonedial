// Render the recorded default-vs-profile replies; no provider or saved settings are read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLanguage, LANGUAGES, type Language } from "../src/core/i18n.ts";
import { cells } from "../src/ui/width.ts";
import { wrapTranscript } from "./voice-wrap.ts";

type Condition = {
  id: string;
  responseText: string;
  responseWords: number;
};

type Copy = {
  title: string;
  control: string;
  controlDetail: string;
  profile: string;
  words: (count: number) => string;
  footer: string;
};

type Row = { text: string; code: boolean; bold: boolean };

const language = process.argv[2];
if (language === undefined || !isLanguage(language) || process.argv.length !== 3) {
  throw new Error(`Usage: node scripts/verbosity-svg.ts [${LANGUAGES.join("|")}]`);
}

const labels: Record<Language, Copy> = {
  en: {
    title: "Same model. A tighter plan.",
    control: "Codex default",
    controlDetail: "No ToneDial manner supplied",
    profile: "vibe-coder",
    words: count => `${count} words`,
    footer: "Same instruction · first completed reply · one sample per condition",
  },
  ko: {
    title: "같은 모델, 더 간결한 계획",
    control: "Codex 기본값",
    controlDetail: "ToneDial 말투를 넣지 않음",
    profile: "vibe-coder",
    words: count => `${count}단어`,
    footer: "같은 지침 · 첫 완료 응답 · 조건별 1회",
  },
  ja: {
    title: "同じモデル、より簡潔な計画",
    control: "Codex デフォルト",
    controlDetail: "ToneDial の口調指定なし",
    profile: "vibe-coder",
    words: count => `${count}語`,
    footer: "同じ指示 · 最初の完了応答 · 条件ごとに1回",
  },
  zh: {
    title: "同一模型，更精简的计划",
    control: "Codex 默认设置",
    controlDetail: "未提供 ToneDial 语气",
    profile: "vibe-coder",
    words: count => `${count} 个词`,
    footer: "同一指令 · 首次完整回复 · 每种条件1次",
  },
  es: {
    title: "El mismo modelo. Un plan más directo.",
    control: "Codex predeterminado",
    controlDetail: "Sin instrucciones de ToneDial",
    profile: "vibe-coder",
    words: count => `${count} palabras`,
    footer: "Misma instrucción · primera respuesta completa · una muestra por condición",
  },
};

const data = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/media/readme/verbosity-comparison.json", import.meta.url)), "utf8")) as {
  instruction: string;
  model: string;
  reasoningEffort: string;
  recordedOn: string;
  profile: { testCommand: string };
  conditions: Condition[];
};
const copy = labels[language];
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const condition = (id: string) => {
  const value = data.conditions.find(item => item.id === id);
  if (value === undefined) throw new Error(`Missing recorded condition: ${id}`);
  return value;
};
const text: string[] = [];
const line = (value: string, x: number, y: number, size = 22, colour = "#edf3f6", weight = 400) =>
  text.push(`<text x="${x}" y="${y}" fill="${colour}" font-size="${size}" font-weight="${weight}" xml:space="preserve">${escape(value)}</text>`);

function responseRows(value: string): Row[] {
  const rows: Row[] = [];
  let fenced = false;
  for (const source of value.split("\n")) {
    if (/^\s*```\w*\s*$/u.test(source)) {
      fenced = !fenced;
      continue;
    }
    if (source.trim() === "") {
      rows.push({ text: "", code: fenced, bold: false });
      continue;
    }
    const normalized = fenced && source.startsWith("   ") ? source.slice(3) : source;
    const marker = fenced ? "" : /^(?:\d+\. |\s+- )/u.exec(normalized)?.[0] ?? "";
    const body = normalized.slice(marker.length).replaceAll("**", "").replaceAll("`", "").trimEnd();
    const wrapped = wrapTranscript(body, 46 - cells(marker), "en");
    for (const [index, row] of wrapped.entries()) {
      rows.push({
        text: (index === 0 ? marker : " ".repeat(cells(marker))) + row,
        code: fenced,
        bold: !fenced && /^\d+\. /u.test(normalized),
      });
    }
  }
  return rows;
}

const rowHeight = (row: Row) => row.text === "" ? 12 : 23;
const rowsHeight = (rows: Row[]) => rows.reduce((height, row) => height + rowHeight(row), 0);
const control = condition("codex-default");
const profile = condition("vibe-coder");
const controlRows = responseRows(control.responseText);
const profileRows = responseRows(profile.responseText);
const top = 116;
const cardHeight = 126 + Math.max(rowsHeight(controlRows), rowsHeight(profileRows)) + 18;

line(copy.title, 36, 52, 30, "#edf3f6", 700);
line(`Codex CLI · ${data.model} · ${data.reasoningEffort}`, 36, 84, 19, "#66d9dc", 700);

function renderCard(item: Condition, rows: Row[], x: number, title: string, detail: string): void {
  const width = 514;
  text.push(`<rect x="${x}" y="${top}" width="${width}" height="${cardHeight}" rx="14" fill="#1d232a" stroke="#34424d"/>`);
  line(title, x + 24, top + 42, 23, "#66d9dc", 700);
  line(copy.words(item.responseWords), x + width - 138, top + 42, 16, "#b8cbd4", 700);
  line(detail, x + 24, top + 72, 15, "#b8cbd4");
  text.push(`<path d="M${x + 24} ${top + 92}H${x + width - 24}" stroke="#34424d"/>`);
  let y = top + 124;
  for (const row of rows) {
    if (row.text !== "") line(row.text, x + 24, y, 16, row.code ? "#b8e5df" : "#edf3f6", row.bold ? 700 : 400);
    y += rowHeight(row);
  }
}

renderCard(control, controlRows, 36, copy.control, copy.controlDetail);
renderCard(profile, profileRows, 570, copy.profile, `$ ${data.profile.testCommand}`);
const footerY = top + cardHeight + 34;
line(`${copy.footer} · ${data.recordedOn}`, 36, footerY, 17, "#b8cbd4");

const description = `${data.instruction}\n\n${copy.control}\n${control.responseText}\n\n${copy.profile}\n${profile.responseText}`
  .split("\n").map(row => row.trimEnd()).join("\n");
const height = footerY + 30;
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}" role="img" aria-labelledby="title description">
<title id="title">${escape(copy.title)}</title>
<desc id="description">${escape(description)}</desc>
<rect width="1120" height="${height}" rx="16" fill="#171b20"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, system-ui">${text.join("\n")}</g>
</svg>\n`);
