// Display width in terminal cells. Nothing in the standard library does this: Node's
// `util.getStringWidth` is internal and unexported, and ECMAScript regex property escapes
// cover `\p{Mn}` but not `East_Asian_Width`, which is why the two tables below exist and the
// zero-width case does not.
//
// **A column that mixes East Asian Width classes misaligns, and that was a real bug.** The
// gauge was `█` (Ambiguous) plus `░` (Neutral), so in a CJK locale the filled half rendered
// two cells and the empty half one — the bar's width varied with its own value. Every aligned
// column now holds glyphs of a single class, and this module is what makes that checkable.
//
// Two measures, deliberately. `cells` counts Ambiguous as one, which is what most emulators
// default to and therefore what to lay out with. `maxCells` counts it as two, which is what a
// CJK-locale user may see and therefore what to budget with. Laying out optimistically and
// budgeting pessimistically is the only combination where neither choice can surprise a user.
//
// **The tables are generated, not typed**, by `scripts/generate-width-table.py` — which writes
// this whole file, including this comment. Regenerate rather than edit. Produced from Python
// 3.14's `unicodedata`, Unicode 16.0.0, scanning U+0000 through U+3FFFF.

// East Asian Width W and F — always two cells. 123 ranges.
const WIDE =
  "1100:115f,231a:231b,2329:232a,23e9:23ec,23f0:23f0,23f3:23f3,25fd:25fe,2614:2615,2630:2637," +
  "2648:2653,267f:267f,268a:268f,2693:2693,26a1:26a1,26aa:26ab,26bd:26be,26c4:26c5,26ce:26ce," +
  "26d4:26d4,26ea:26ea,26f2:26f3,26f5:26f5,26fa:26fa,26fd:26fd,2705:2705,270a:270b,2728:2728," +
  "274c:274c,274e:274e,2753:2755,2757:2757,2795:2797,27b0:27b0,27bf:27bf,2b1b:2b1c,2b50:2b50," +
  "2b55:2b55,2e80:2e99,2e9b:2ef3,2f00:2fd5,2ff0:3029,302e:303e,3041:3096,309b:30ff,3105:312f," +
  "3131:318e,3190:31e5,31ef:321e,3220:3247,3250:a48c,a490:a4c6,a960:a97c,ac00:d7a3,f900:faff," +
  "fe10:fe19,fe30:fe52,fe54:fe66,fe68:fe6b,ff01:ff60,ffe0:ffe6,16fe0:16fe3,16ff0:16ff1,17000:187f7," +
  "18800:18cd5,18cff:18d08,1aff0:1aff3,1aff5:1affb,1affd:1affe,1b000:1b122,1b132:1b132,1b150:1b152," +
  "1b155:1b155,1b164:1b167,1b170:1b2fb,1d300:1d356,1d360:1d376,1f004:1f004,1f0cf:1f0cf,1f18e:1f18e," +
  "1f191:1f19a,1f200:1f202,1f210:1f23b,1f240:1f248,1f250:1f251,1f260:1f265,1f300:1f320,1f32d:1f335," +
  "1f337:1f37c,1f37e:1f393,1f3a0:1f3ca,1f3cf:1f3d3,1f3e0:1f3f0,1f3f4:1f3f4,1f3f8:1f43e,1f440:1f440," +
  "1f442:1f4fc,1f4ff:1f53d,1f54b:1f54e,1f550:1f567,1f57a:1f57a,1f595:1f596,1f5a4:1f5a4,1f5fb:1f64f," +
  "1f680:1f6c5,1f6cc:1f6cc,1f6d0:1f6d2,1f6d5:1f6d7,1f6dc:1f6df,1f6eb:1f6ec,1f6f4:1f6fc,1f7e0:1f7eb," +
  "1f7f0:1f7f0,1f90c:1f93a,1f93c:1f945,1f947:1f9ff,1fa70:1fa7c,1fa80:1fa89,1fa8f:1fac6,1face:1fadc," +
  "1fadf:1fae9,1faf0:1faf8,20000:2fffd,30000:3fffd";

// East Asian Width A — one cell in a Latin locale, two in a CJK one. 174 ranges.
const AMBIGUOUS =
  "a1:a1,a4:a4,a7:a8,aa:aa,ad:ae,b0:b4,b6:ba,bc:bf,c6:c6,d0:d0,d7:d8,de:e1,e6:e6,e8:ea,ec:ed,f0:f0," +
  "f2:f3,f7:fa,fc:fc,fe:fe,101:101,111:111,113:113,11b:11b,126:127,12b:12b,131:133,138:138,13f:142," +
  "144:144,148:14b,14d:14d,152:153,166:167,16b:16b,1ce:1ce,1d0:1d0,1d2:1d2,1d4:1d4,1d6:1d6,1d8:1d8," +
  "1da:1da,1dc:1dc,251:251,261:261,2c4:2c4,2c7:2c7,2c9:2cb,2cd:2cd,2d0:2d0,2d8:2db,2dd:2dd,2df:2df," +
  "391:3a1,3a3:3a9,3b1:3c1,3c3:3c9,401:401,410:44f,451:451,2010:2010,2013:2016,2018:2019,201c:201d," +
  "2020:2022,2024:2027,2030:2030,2032:2033,2035:2035,203b:203b,203e:203e,2074:2074,207f:207f," +
  "2081:2084,20ac:20ac,2103:2103,2105:2105,2109:2109,2113:2113,2116:2116,2121:2122,2126:2126," +
  "212b:212b,2153:2154,215b:215e,2160:216b,2170:2179,2189:2189,2190:2199,21b8:21b9,21d2:21d2," +
  "21d4:21d4,21e7:21e7,2200:2200,2202:2203,2207:2208,220b:220b,220f:220f,2211:2211,2215:2215," +
  "221a:221a,221d:2220,2223:2223,2225:2225,2227:222c,222e:222e,2234:2237,223c:223d,2248:2248," +
  "224c:224c,2252:2252,2260:2261,2264:2267,226a:226b,226e:226f,2282:2283,2286:2287,2295:2295," +
  "2299:2299,22a5:22a5,22bf:22bf,2312:2312,2460:24e9,24eb:254b,2550:2573,2580:258f,2592:2595," +
  "25a0:25a1,25a3:25a9,25b2:25b3,25b6:25b7,25bc:25bd,25c0:25c1,25c6:25c8,25cb:25cb,25ce:25d1," +
  "25e2:25e5,25ef:25ef,2605:2606,2609:2609,260e:260f,261c:261c,261e:261e,2640:2640,2642:2642," +
  "2660:2661,2663:2665,2667:266a,266c:266d,266f:266f,269e:269f,26bf:26bf,26c6:26cd,26cf:26d3," +
  "26d5:26e1,26e3:26e3,26e8:26e9,26eb:26f1,26f4:26f4,26f6:26f9,26fb:26fc,26fe:26ff,273d:273d," +
  "2776:277f,2b56:2b59,3248:324f,e000:f8ff,fffd:fffd,1f100:1f10a,1f110:1f12d,1f130:1f169," +
  "1f170:1f18d,1f18f:1f190,1f19b:1f1ac";

/**
 * Marks and format characters occupy no cell of their own.
 *
 * U+00AD SOFT HYPHEN is the exception the generator keeps in the width tables: it is `Cf` but
 * it is drawn, so the tables are consulted before this can zero it. Tested first for everything
 * else, which is why no mark appears in either table.
 */
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** Packed `start:end` hex pairs into a flat sorted array, once per process. */
function decode(packed: string): number[] {
  const out: number[] = [];
  for (const pair of packed.split(",")) {
    const colon = pair.indexOf(":");
    out.push(parseInt(pair.slice(0, colon), 16), parseInt(pair.slice(colon + 1), 16));
  }
  return out;
}

const WIDE_RANGES = decode(WIDE);
const AMBIGUOUS_RANGES = decode(AMBIGUOUS);
const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMOJI_SEQUENCE = /\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}.*(?:\uFE0F|\u200D|\p{Emoji_Modifier})/u;

function* graphemes(s: string): Generator<string> {
  for (const { segment } of SEGMENTER.segment(s.normalize("NFC"))) yield segment;
}

function inRanges(ranges: number[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid * 2]!) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

function width(s: string, ambiguousIsWide: boolean): number {
  // NFC first: on macOS a Spanish or Japanese string often arrives decomposed, and composing it
  // turns a base plus a combining mark into the single codepoint the terminal actually draws.
  let total = 0;
  for (const cluster of graphemes(s)) {
    // Joined emoji, flags and keycaps are one two-cell glyph, not a sum of their components.
    if (EMOJI_SEQUENCE.test(cluster)) {
      total += 2;
      continue;
    }
    for (const ch of cluster) {
      const cp = ch.codePointAt(0)!;
      if (inRanges(WIDE_RANGES, cp)) total += 2;
      else if (ZERO_WIDTH.test(ch)) continue;
      else if (ambiguousIsWide && inRanges(AMBIGUOUS_RANGES, cp)) total += 2;
      else total += 1;
    }
  }
  return total;
}

/** Internal prose fallback when no usable terminal dimensions are available. */
export const UNKNOWN_WIDTH = 100;

/** A measured terminal owns the budget; leave its last cursor column unwritten. */
export function resolveBudget(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return UNKNOWN_WIDTH;
  return Math.max(1, Math.floor(columns) - 1);
}

/** Cells this string occupies where Ambiguous renders narrow. Lay out with this. */
export function cells(s: string): number {
  return width(s, false);
}

/** Cells this string can occupy where Ambiguous renders wide. Budget with this. */
export function maxCells(s: string): number {
  return width(s, true);
}

/** `String.prototype.padEnd` counts UTF-16 units, which is the wrong unit for a column. */
export function padEnd(s: string, target: number): string {
  const gap = target - cells(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

const ELLIPSIS = "…";

/**
 * Shorten to fit, marking that something was cut. For user text with no length limit — a preset
 * display name, a path — where folding would be worse than losing the tail.
 */
export function truncate(s: string, budget: number): string {
  if (maxCells(s) <= budget) return s;
  // The ellipsis is U+2026, which is Ambiguous and therefore two cells in a CJK locale. Budgeting
  // one for it put every truncated Korean string a cell over the limit it was cut to fit.
  const room = budget - maxCells(ELLIPSIS);
  if (room <= 0) return ELLIPSIS;
  let out = "";
  for (const ch of graphemes(s)) {
    if (maxCells(out + ch) > room) break;
    out += ch;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * Fold prose to a cell budget, measured pessimistically so a CJK-locale terminal cannot be the
 * first place an overflow appears.
 *
 * Breaking falls back to mid-word when a single word does not fit, which is not a nicety:
 * Japanese and Chinese put no spaces between words, so a whole sentence arrives as one token
 * and a space-only wrapper would emit it as a single over-long line.
 *
 * **Pass plain text.** Escape sequences carry no cells but plenty of characters, so a painted
 * string measures wrong and can be cut through the middle of an escape. Wrap first, paint after.
 */
export function wrap(s: string, budget: number): string[] {
  // A non-positive budget used to return the whole string unwrapped, which is the one outcome
  // this function exists to prevent. One cell is the narrowest thing that can still make
  // progress, and a caller that computed a budget of zero has a bug worth seeing folded.
  const fit = Math.max(1, budget);
  // A newline already is a break. Folding around one rather than through it keeps an embedded
  // line ending from reaching a caller that adds its own continuation indent.
  if (s.includes("\n")) return s.split("\n").flatMap((part) => wrap(part, fit));

  const out: string[] = [];
  let line = "";

  const flush = () => {
    if (line !== "") out.push(line);
    line = "";
  };

  for (const word of s.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (maxCells(candidate) <= fit) {
      line = candidate;
      continue;
    }
    flush();
    if (maxCells(word) <= fit) {
      line = word;
      continue;
    }
    // Preserve a whole grapheme even when an impossibly small budget cannot hold that glyph.
    for (const ch of graphemes(word)) {
      if (maxCells(line + ch) > fit) flush();
      line += ch;
    }
  }
  flush();
  return out.length ? out : [""];
}

