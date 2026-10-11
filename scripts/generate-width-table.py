#!/usr/bin/env python3
"""Generate the East Asian Width tables embedded in src/ui/width.ts.

    python3 scripts/generate-width-table.py > src/ui/width.ts

This is the one piece of Python in a TypeScript repository, and it is here because Node ships
no East Asian Width data: `util.getStringWidth` is internal and unexported, and ECMAScript
regex property escapes cover `\\p{Mn}` but not `East_Asian_Width`. Embedding the table in
source is what keeps the package free of both a runtime dependency and a package-relative read
at run time, either of which would break the binary packagers the stack constraints protect.

It runs only when the tables need regenerating — on a Unicode version bump, or if the scan
bound below ever needs to move. It is never imported, never shipped, and never run at build
time; the normal TypeScript build consumes the committed generated module.
"""

import sys
import unicodedata as u

# Through the end of plane 3. Planes 4 through 13 are unassigned, and plane 14 holds only tag
# and variation-selector characters, which are format characters the module handles by regex.
# Plane 3 must be inside the bound: CJK Extension G and H live there and are Wide, so a
# narrower scan would measure a Han character as one cell in a function whose whole contract is
# to over-count rather than under-count.
SCAN_END = 0x40000

# The one format character kept in the tables. U+00AD SOFT HYPHEN is `Cf`, but it is drawn —
# so treating it as zero-width the way the module treats the rest of `Cf` would under-count it.
KEPT_FORMAT = {0x00AD}


def eaw_ranges(target):
    """Contiguous codepoint ranges whose East Asian Width is in `target`.

    Marks and format characters are skipped: the module tests those with a regex first, so
    including them here would count them twice.
    """
    out, start, prev = [], None, None
    for cp in range(0, SCAN_END):
        ch = chr(cp)
        cat = u.category(ch)
        skip = cat in ("Mn", "Me") or (cat == "Cf" and cp not in KEPT_FORMAT)
        hit = (not skip) and u.east_asian_width(ch) in target
        if hit:
            if start is None:
                start = cp
            prev = cp
        elif start is not None:
            out.append((start, prev))
            start = None
    if start is not None:
        out.append((start, prev))
    return out


def emit(name, ranges, note):
    packed = ",".join(f"{a:x}:{b:x}" for a, b in ranges)
    body, line = "", ""
    for chunk in packed.split(","):
        if len(line) + len(chunk) + 1 > 96:
            body += f'  "{line}," +\n'
            line = chunk
        else:
            line = f"{line},{chunk}" if line else chunk
    body += f'  "{line}";'
    return f"// {note}\nconst {name} =\n{body}\n"


wide = eaw_ranges(("W", "F"))
amb = eaw_ranges(("A",))

print(f'''// Display width in terminal cells. Nothing in the standard library does this: Node's
// `util.getStringWidth` is internal and unexported, and ECMAScript regex property escapes
// cover `\\p{{Mn}}` but not `East_Asian_Width`, which is why the two tables below exist and the
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
// {sys.version_info.major}.{sys.version_info.minor}'s `unicodedata`, Unicode {u.unidata_version}, scanning U+0000 through U+3FFFF.

{emit("WIDE", wide, f"East Asian Width W and F — always two cells. {len(wide)} ranges.")}
{emit("AMBIGUOUS", amb, f"East Asian Width A — one cell in a Latin locale, two in a CJK one. {len(amb)} ranges.")}
/**
 * Marks and format characters occupy no cell of their own.
 *
 * U+00AD SOFT HYPHEN is the exception the generator keeps in the width tables: it is `Cf` but
 * it is drawn, so the tables are consulted before this can zero it. Tested first for everything
 * else, which is why no mark appears in either table.
 */
const ZERO_WIDTH = /[\\p{{Mn}}\\p{{Me}}\\p{{Cf}}]/u;

/** Packed `start:end` hex pairs into a flat sorted array, once per process. */
function decode(packed: string): number[] {{
  const out: number[] = [];
  for (const pair of packed.split(",")) {{
    const colon = pair.indexOf(":");
    out.push(parseInt(pair.slice(0, colon), 16), parseInt(pair.slice(colon + 1), 16));
  }}
  return out;
}}

const WIDE_RANGES = decode(WIDE);
const AMBIGUOUS_RANGES = decode(AMBIGUOUS);
const SEGMENTER = new Intl.Segmenter("en", {{ granularity: "grapheme" }});
const EMOJI_SEQUENCE = /\\p{{Regional_Indicator}}{{2}}|[0-9#*]\\uFE0F?\\u20E3|\\p{{Extended_Pictographic}}.*(?:\\uFE0F|\\u200D|\\p{{Emoji_Modifier}})/u;

function* graphemes(s: string): Generator<string> {{
  for (const {{ segment }} of SEGMENTER.segment(s.normalize("NFC"))) yield segment;
}}

function inRanges(ranges: number[], cp: number): boolean {{
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {{
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid * 2]!) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }}
  return false;
}}

function width(s: string, ambiguousIsWide: boolean): number {{
  // NFC first: on macOS a Spanish or Japanese string often arrives decomposed, and composing it
  // turns a base plus a combining mark into the single codepoint the terminal actually draws.
  let total = 0;
  for (const cluster of graphemes(s)) {{
    // Joined emoji, flags and keycaps are one two-cell glyph, not a sum of their components.
    if (EMOJI_SEQUENCE.test(cluster)) {{
      total += 2;
      continue;
    }}
    for (const ch of cluster) {{
      const cp = ch.codePointAt(0)!;
      if (inRanges(WIDE_RANGES, cp)) total += 2;
      else if (ZERO_WIDTH.test(ch)) continue;
      else if (ambiguousIsWide && inRanges(AMBIGUOUS_RANGES, cp)) total += 2;
      else total += 1;
    }}
  }}
  return total;
}}

/** Internal prose fallback when no usable terminal dimensions are available. */
export const UNKNOWN_WIDTH = 100;

/** A measured terminal owns the budget; leave its last cursor column unwritten. */
export function resolveBudget(columns: number | undefined): number {{
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return UNKNOWN_WIDTH;
  return Math.max(1, Math.floor(columns) - 1);
}}

/** Cells this string occupies where Ambiguous renders narrow. Lay out with this. */
export function cells(s: string): number {{
  return width(s, false);
}}

/** Cells this string can occupy where Ambiguous renders wide. Budget with this. */
export function maxCells(s: string): number {{
  return width(s, true);
}}

/** `String.prototype.padEnd` counts UTF-16 units, which is the wrong unit for a column. */
export function padEnd(s: string, target: number): string {{
  const gap = target - cells(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}}

const ELLIPSIS = "…";

/**
 * Shorten to fit, marking that something was cut. For user text with no length limit — a preset
 * display name, a path — where folding would be worse than losing the tail.
 */
export function truncate(s: string, budget: number): string {{
  if (maxCells(s) <= budget) return s;
  // The ellipsis is U+2026, which is Ambiguous and therefore two cells in a CJK locale. Budgeting
  // one for it put every truncated Korean string a cell over the limit it was cut to fit.
  const room = budget - maxCells(ELLIPSIS);
  if (room <= 0) return ELLIPSIS;
  let out = "";
  for (const ch of graphemes(s)) {{
    if (maxCells(out + ch) > room) break;
    out += ch;
  }}
  return `${{out}}${{ELLIPSIS}}`;
}}

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
export function wrap(s: string, budget: number): string[] {{
  // A non-positive budget used to return the whole string unwrapped, which is the one outcome
  // this function exists to prevent. One cell is the narrowest thing that can still make
  // progress, and a caller that computed a budget of zero has a bug worth seeing folded.
  const fit = Math.max(1, budget);
  // A newline already is a break. Folding around one rather than through it keeps an embedded
  // line ending from reaching a caller that adds its own continuation indent.
  if (s.includes("\\n")) return s.split("\\n").flatMap((part) => wrap(part, fit));

  const out: string[] = [];
  let line = "";

  const flush = () => {{
    if (line !== "") out.push(line);
    line = "";
  }};

  for (const word of s.split(" ")) {{
    const candidate = line === "" ? word : `${{line}} ${{word}}`;
    if (maxCells(candidate) <= fit) {{
      line = candidate;
      continue;
    }}
    flush();
    if (maxCells(word) <= fit) {{
      line = word;
      continue;
    }}
    // Preserve a whole grapheme even when an impossibly small budget cannot hold that glyph.
    for (const ch of graphemes(word)) {{
      if (maxCells(line + ch) > fit) flush();
      line += ch;
    }}
  }}
  flush();
  return out.length ? out : [""];
}}
''')
