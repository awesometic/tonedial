// Legacy imports and shell PATH regions preserve surrounding bytes on insert/remove.
// Appending one newline retains the distinction between files with and without a final newline.
export type Markers = { begin: string; end: string };

export const MARKDOWN: Markers = { begin: "<!-- tonedial:begin -->", end: "<!-- tonedial:end -->" };
export const SHELL: Markers = { begin: "# tonedial:begin", end: "# tonedial:end" };

export type Found = {
  /** Offset of the begin marker. */
  start: number;
  /** Offset just past the end marker's own newline, if it has one. */
  end: number;
  /** What sits between the markers, with no trailing newline. */
  content: string;
};

/** Why a file cannot be read as carrying at most one well-formed region. */
export type Damage = "unclosed" | "unopened" | "duplicated";

export class RegionError extends Error {
  // Declared and assigned rather than a parameter property: `erasableSyntaxOnly` rejects the
  // shorthand, because type stripping cannot erase something that also emits an assignment.
  damage: Damage;

  constructor(damage: Damage, message: string) {
    super(message);
    this.name = "RegionError";
    this.damage = damage;
  }
}

/**
 * A marker only counts at the start of its own line.
 *
 * Matching anywhere let a marker quoted mid-sentence become the live region: `upsert` on
 * `keep this <!-- tonedial:begin --> and this <!-- tonedial:end --> too` deleted "and this",
 * and the round-trip claim failed outright. Requiring column 0 is what makes prose *about*
 * this tool safe to have in a file this tool edits.
 */
function atLineStart(text: string, marker: string, from = 0): number {
  for (let i = text.indexOf(marker, from); i >= 0; i = text.indexOf(marker, i + 1)) {
    if (i === 0 || text[i - 1] === "\n") return i;
  }
  return -1;
}

/** The exact bytes a region occupies, markers included. */
export function block(content: string, m: Markers = MARKDOWN): string {
  return `${m.begin}\n${content}\n${m.end}\n`;
}

/**
 * Locate the region, or `null` when the file has none.
 *
 * Damage is thrown rather than repaired. A second begin marker, or one without its end, means
 * something edited this file in a way that leaves no safe guess about which bytes are ours —
 * and guessing wrong deletes a line of someone else's configuration.
 */
export function find(text: string, m: Markers = MARKDOWN): Found | null {
  const start = atLineStart(text, m.begin);
  if (start < 0) {
    if (atLineStart(text, m.end) >= 0) {
      throw new RegionError("unopened", `${m.end} appears without ${m.begin}`);
    }
    return null;
  }
  if (atLineStart(text, m.begin, start + m.begin.length) >= 0) {
    throw new RegionError("duplicated", `${m.begin} appears more than once`);
  }

  const endMarker = atLineStart(text, m.end, start);
  if (endMarker < 0) throw new RegionError("unclosed", `${m.begin} has no ${m.end}`);
  if (atLineStart(text, m.end, endMarker + m.end.length) >= 0) {
    throw new RegionError("duplicated", `${m.end} appears more than once`);
  }

  const inner = text.slice(start + m.begin.length, endMarker);
  const after = endMarker + m.end.length;
  return {
    start,
    end: text[after] === "\n" ? after + 1 : after,
    // One newline belongs to each marker; anything else the user put there is theirs.
    content: inner.replace(/^\n/, "").replace(/\n$/, ""),
  };
}

/**
 * Add the region, or replace its content where one already exists. Running this twice with the
 * same content returns the input unchanged, which is the whole of what idempotence means here.
 */
export function upsert(text: string, content: string, m: Markers = MARKDOWN): string {
  const found = find(text, m);
  if (found) return text.slice(0, found.start) + block(content, m) + text.slice(found.end);
  return text === "" ? block(content, m) : `${text}\n${block(content, m)}`;
}

/**
 * Take the region back out, including the single newline `upsert` put in front of it. Returns
 * the text untouched when there is no region, so `eject` on an unwired file is a no-op rather
 * than an error.
 */
export function remove(text: string, m: Markers = MARKDOWN): string {
  const found = find(text, m);
  if (!found) return text;
  const before = found.start > 0 && text[found.start - 1] === "\n" ? found.start - 1 : found.start;
  return text.slice(0, before) + text.slice(found.end);
}
