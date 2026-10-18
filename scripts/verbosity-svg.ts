// Render the recorded default-vs-profile replies; no provider or saved settings are read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLanguage, LANGUAGES, type Language } from "../src/core/i18n.ts";
import { wrapTranscript } from "./voice-wrap.ts";

type Condition = {
  id: string;
  responseText: string;
  proseWords: number;
};

type Copy = {
  title: string;
  control: string;
  controlDetail: string;
  profile: string;
  words: (count: number) => string;
  footer: string;
};

const language = process.argv[2];
if (language === undefined || !isLanguage(language) || process.argv.length !== 3) {
  throw new Error(`Usage: node scripts/verbosity-svg.ts [${LANGUAGES.join("|")}]`);
}

const labels: Record<Language, Copy> = {
  en: {
    title: "Same model. Less preamble.",
    control: "Codex default",
    controlDetail: "No ToneDial manner supplied",
    profile: "vibe-coder",
    words: count => `${count} prose words`,
    footer: "Same prompt · first completed reply · one sample per condition",
  },
  ko: {
    title: "같은 모델, 더 짧은 답",
    control: "Codex 기본값",
    controlDetail: "ToneDial 말투를 넣지 않음",
    profile: "vibe-coder",
    words: count => `설명 ${count}단어`,
    footer: "같은 질문 · 첫 완료 응답 · 조건별 1회",
  },
  ja: {
    title: "同じモデル、前置きは短く",
    control: "Codex デフォルト",
    controlDetail: "ToneDial の口調指定なし",
    profile: "vibe-coder",
    words: count => `説明 ${count}語`,
    footer: "同じ質問 · 最初の完了応答 · 条件ごとに1回",
  },
  zh: {
    title: "同一模型，更少铺垫",
    control: "Codex 默认设置",
    controlDetail: "未提供 ToneDial 语气",
    profile: "vibe-coder",
    words: count => `说明 ${count} 个词`,
    footer: "同一问题 · 首次完整回复 · 每种条件1次",
  },
  es: {
    title: "El mismo modelo. Menos rodeos.",
    control: "Codex predeterminado",
    controlDetail: "Sin instrucciones de ToneDial",
    profile: "vibe-coder",
    words: count => `${count} palabras`,
    footer: "Misma pregunta · primera respuesta completa · una muestra por condición",
  },
};

const data = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/media/readme/verbosity-comparison.json", import.meta.url)), "utf8")) as {
  question: string;
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
const splitResponse = (value: string) => {
  const match = /^(.*?)\n\n```js\n([\s\S]+)\n```$/u.exec(value);
  if (match === null) throw new Error("Recorded response must contain prose and one JavaScript block");
  return { prose: match[1]!, code: match[2]!.split("\n") };
};
const text: string[] = [];
const line = (value: string, x: number, y: number, size = 22, colour = "#edf3f6", weight = 400) =>
  text.push(`<text x="${x}" y="${y}" fill="${colour}" font-size="${size}" font-weight="${weight}" xml:space="preserve">${escape(value)}</text>`);

line(copy.title, 36, 52, 30, "#edf3f6", 700);
line(`Codex CLI · ${data.model} · ${data.reasoningEffort}`, 36, 84, 19, "#66d9dc", 700);

function renderCard(item: Condition, x: number, title: string, detail: string): void {
  const top = 116;
  const width = 514;
  text.push(`<rect x="${x}" y="${top}" width="${width}" height="358" rx="14" fill="#1d232a" stroke="#34424d"/>`);
  line(title, x + 24, top + 42, 23, "#66d9dc", 700);
  line(copy.words(item.proseWords), x + width - 150, top + 42, 16, "#b8cbd4", 700);
  line(detail, x + 24, top + 72, 15, "#b8cbd4");
  text.push(`<path d="M${x + 24} ${top + 92}H${x + width - 24}" stroke="#34424d"/>`);
  const response = splitResponse(item.responseText);
  let y = top + 128;
  for (const row of wrapTranscript(response.prose.replaceAll("`", ""), 38, "en")) {
    line(row, x + 24, y, 19);
    y += 28;
  }
  y += 14;
  for (const row of response.code) {
    line(row, x + 24, y, 18, "#b8e5df");
    y += 27;
  }
}

const control = condition("codex-default");
const profile = condition("vibe-coder");
renderCard(control, 36, copy.control, copy.controlDetail);
renderCard(profile, 570, copy.profile, `$ ${data.profile.testCommand}`);
line(`${copy.footer} · ${data.recordedOn}`, 36, 506, 17, "#b8cbd4");

const description = `${data.question}\n\n${copy.control}\n${control.responseText}\n\n${copy.profile}\n${profile.responseText}`;
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="536" viewBox="0 0 1120 536" role="img" aria-labelledby="title description">
<title id="title">${escape(copy.title)}</title>
<desc id="description">${escape(description)}</desc>
<rect width="1120" height="536" rx="16" fill="#171b20"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, system-ui">${text.join("\n")}</g>
</svg>\n`);
