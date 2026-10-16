import { maxCells, wrap } from "../src/ui/width.ts";
import type { Language } from "../src/core/i18n.ts";

const closingPunctuation = /^[\p{Pe}\p{Pf}。，、！？；：,.!?;:）》」』】〕〉》…]+$/u;
const displayed = (value: string) => value.replaceAll("**", "").replaceAll("`", "");
const displayedCells = (value: string) => maxCells(displayed(value));

function repairOrphanedPunctuation(rows: string[], budget: number, language: Language): string[] {
  if (rows.length < 2 || !closingPunctuation.test(displayed(rows.at(-1)!))) return rows;
  const segmenter = new Intl.Segmenter(language, { granularity: "grapheme" });
  const previous = [...segmenter.segment(rows.at(-2)!)].map(({ segment }) => segment);
  let moved = "";
  while (previous.length > 0 && displayedCells(moved) === 0) moved = previous.pop()! + moved;
  if (moved === "" || displayedCells(moved + rows.at(-1)!) > budget) return rows;
  rows[rows.length - 2] = previous.join("");
  rows[rows.length - 1] = moved + rows.at(-1)!;
  return rows.filter((row) => row !== "");
}

/** Keep fitting inline code whole and closing punctuation attached within the cell budget. */
export function wrapTranscript(source: string, budget: number, language: Language): string[] {
  const fit = Math.max(1, budget);
  const wordSegmenter = new Intl.Segmenter(language, { granularity: "word" });
  const tokens: string[] = [];
  let offset = 0;
  for (const match of source.matchAll(/`[^`\n]*`|\*\*/gu)) {
    const start = match.index;
    if (start > offset) tokens.push(...[...wordSegmenter.segment(source.slice(offset, start))].map(({ segment }) => segment));
    if (match[0].startsWith("`") && displayedCells(match[0]) > fit) {
      throw new Error(`Inline code exceeds the ${fit}-cell transcript width.`);
    }
    tokens.push(match[0]);
    offset = start + match[0].length;
  }
  if (offset < source.length) tokens.push(...[...wordSegmenter.segment(source.slice(offset))].map(({ segment }) => segment));

  const out: string[] = [];
  let line: string[] = [];
  const current = () => line.join("");
  const flush = () => {
    if (current().trimEnd() !== "") out.push(current().trimEnd());
    line = [];
  };
  for (const token of tokens) {
    if (/^\s+$/u.test(token) && line.length === 0) continue;
    if (displayedCells(current() + token) <= fit) {
      line.push(token);
      continue;
    }
    if (line.length > 0 && closingPunctuation.test(token)) {
      const moved: string[] = [];
      while (line.length > 0 && (/^\s+$/u.test(line.at(-1)!) || displayedCells(line.at(-1)!) === 0)) {
        moved.unshift(line.pop()!);
      }
      if (line.length > 0) moved.unshift(line.pop()!);
      flush();
      const combined = [...moved.filter((part, index) => index > 0 || !/^\s+$/u.test(part)), token].join("");
      if (/`[^`\n]*`/u.test(combined)) {
        throw new Error(`Inline code and closing punctuation exceed the ${fit}-cell transcript width.`);
      }
      const folded = repairOrphanedPunctuation(wrap(combined, fit), fit, language);
      out.push(...folded.slice(0, -1));
      line = [folded.at(-1) ?? ""];
      continue;
    }
    flush();
    if (displayedCells(token) <= fit) {
      line = [token.trimStart()];
      continue;
    }
    const fallback = wrap(token, fit);
    out.push(...fallback.slice(0, -1));
    line = [fallback.at(-1) ?? ""];
  }
  flush();
  return out.length ? out : [""];
}
