// SessionStart JSON transforms preserve unrelated settings and handlers. A native delivery is
// one or more entries sharing a handler, identified by that handler and the matchers it is
// written under; the historical string selector remains for scoped legacy recognition and
// cleanup, not new setup. Provider command protocols live in targets.ts.

import { ConfigError } from "../core/config.ts";
import { shellQuote } from "../core/paths.ts";
import type { Messages } from "../core/i18n.ts";

/** Startup and resume. A hook that fired on neither would be a hook nothing runs. */
const MATCHER = "startup|resume";

/** Historical token override, retained for legacy fingerprints only. New hooks use host defaults. */
const CONTEXT_LIMIT = 5000;

/** Legacy fingerprints expand $HOME inside quotes; a quoted tilde would stay literal. */
export function hookCommand(toneAbsolute: string, home: string): string {
  const underHome = home !== "" && toneAbsolute.startsWith(`${home}/`);
  const path = underHome ? `$HOME${shellQuote(toneAbsolute.slice(home.length))}` : shellQuote(toneAbsolute);
  return `cat "${path}"`;
}

/** A concrete command handler as it appears in a native provider settings file. */
export type HookHandler = {
  type: "command";
  command: string;
  args?: string[];
  statusMessage?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
};

/**
 * One provider's SessionStart delivery: the lifecycle matchers it needs, and the handler they
 * all run.
 *
 * A list rather than one matcher, because how a provider names the sessions it wants is the
 * provider's business. Some accept an alternation in one entry; for at least one the reading is
 * that its sources are exact names, and an alternation there would match none of them — a hook
 * that is written, looks right, and silently never fires. Writing one entry per matcher is
 * correct whichever reading holds, so the shape that survives both is the one stored.
 */
export type HookSpec = {
  matchers: readonly string[];
  handler: HookHandler;
  /** Separately owned file-level metadata; never part of a handler fingerprint. */
  documentDescription?: string;
};

type HookEntry = {
  type?: string;
  command?: string;
  args?: unknown;
  [key: string]: unknown;
};
type Matcher = { matcher?: string; hooks?: HookEntry[]; [key: string]: unknown };
type Document = { hooks?: Record<string, Matcher[]> } & Record<string, unknown>;

/**
 * Parse, or refuse.
 *
 * A `hooks.json` this tool cannot read is not a file it may overwrite: the user's other hooks are
 * in there, and replacing the document to add one entry would delete them. Absent is the only
 * thing treated as empty.
 */
function parse(before: string | null, path: string, t: Messages): Document {
  if (before === null || before.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(before);
  } catch (cause) {
    throw new ConfigError(t.errors.hooksNotJson(path, (cause as Error).message));
  }
  if (!isPlainObject(value)) throw new ConfigError(t.errors.hooksNotJson(path, ""));
  // **Shape, not only syntax.** Parsing said this is JSON; it did not say `hooks` is an object or
  // that `SessionStart` is an array, and assuming either destroyed the user's file rather than
  // refusing it: spreading a string `hooks` produced `{"0":"n","1":"o",…}`, and an object
  // `SessionStart` threw a raw `TypeError` out of the command whose job is to survive a broken
  // install. A file this tool cannot make sense of is refused with its bytes intact.
  const hooks = (value as Document).hooks;
  if (hooks !== undefined) {
    if (!isPlainObject(hooks)) throw new ConfigError(t.errors.hooksNotJson(path, ""));
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) throw new ConfigError(t.errors.hooksNotJson(path, ""));
      for (const [index, block] of entries.entries()) {
        if (!isPlainObject(block)) {
          throw new ConfigError(t.errors.hooksNotJson(path, `hooks.${event}[${index}] must be an object`));
        }
        if (block.hooks !== undefined) {
          if (!Array.isArray(block.hooks)) {
            throw new ConfigError(t.errors.hooksNotJson(path, `hooks.${event}[${index}].hooks must be an array`));
          }
          for (const [handlerIndex, handler] of block.hooks.entries()) {
            if (!isPlainObject(handler)) {
              throw new ConfigError(
                t.errors.hooksNotJson(path, `hooks.${event}[${index}].hooks[${handlerIndex}] must be an object`),
              );
            }
          }
        }
      }
    }
  }
  return value as Document;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Two-space indent and a trailing newline, which is what an editor and a diff both expect. */
const serialize = (doc: Document): string => `${JSON.stringify(doc, null, 2)}\n`;

const entriesOf = (doc: Document): Matcher[] => doc.hooks?.SessionStart ?? [];

/** Read the file-level slot without treating a non-string user value as an absent slot. */
export function hookDocumentDescription(before: string | null, path: string, t: Messages): unknown {
  return parse(before, path, t).description;
}

/** Whether a legacy handler is our command, rather than another handler with a similar payload. */
const ownsLegacyHandler = (handler: HookEntry, command: string): boolean =>
  handler.type === "command" && handler.command === command;

/** Compare parsed JSON values without making object key order part of ownership. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

/** Native ownership includes the matcher set and the complete handler shape, including absent args. */
const ownsNativeHandler = (block: Matcher, handler: HookEntry, spec: HookSpec): boolean =>
  typeof block.matcher === "string" && spec.matchers.includes(block.matcher) &&
  sameJsonValue(handler, spec.handler);

/** Select a legacy command by its historical identity, or a native entry by its full shape. */
const ownsHandler = (block: Matcher, handler: HookEntry, selector: string | HookSpec): boolean =>
  typeof selector === "string" ? ownsLegacyHandler(handler, selector) : ownsNativeHandler(block, handler, selector);

/** Remove only our handlers from one matcher block, preserving its siblings and unknown fields. */
const withoutOurs = (block: Matcher, selector: string | HookSpec): Matcher | null => {
  if (block.hooks === undefined) return block;
  const kept = block.hooks.filter((h) => !ownsHandler(block, h, selector));
  if (kept.length === block.hooks.length) return block;
  if (kept.length) return { ...block, hooks: kept };
  const hasUnknownFields = Object.keys(block).some((key) => key !== "matcher" && key !== "hooks");
  return hasUnknownFields ? { ...block, hooks: [] } : null;
};

/** Remove our handlers from every SessionStart block, retaining blocks that still have siblings. */
const withoutOursFromEntries = (entries: Matcher[], selector: string | HookSpec): Matcher[] =>
  entries.flatMap((block) => {
    const kept = withoutOurs(block, selector);
    return kept ? [kept] : [];
  });

/**
 * Whether this document already carries our delivery, complete.
 *
 * Complete, not partial: a provider whose delivery is several entries is present only when all
 * of them are, because that is what the fingerprint means and what removal would take away.
 */
export function hasHook(before: string | null, selector: string | HookSpec, path: string, t: Messages): boolean {
  const entries = entriesOf(parse(before, path, t));
  const present = (matcher: string | undefined) => entries.some((block) =>
    (matcher === undefined || block.matcher === matcher) &&
    (block.hooks?.some((handler) => ownsHandler(block, handler, selector)) ?? false));
  return typeof selector === "string" ? present(undefined) : selector.matchers.every(present);
}

/** Positions of exact managed handlers in the host's unfiltered matcher/handler arrays. */
export function ownedHookLocations(before: string | null, selector: HookSpec, path: string, t: Messages): readonly (readonly [number, number])[] {
  return entriesOf(parse(before, path, t)).flatMap((block, matcher) =>
    (block.hooks ?? []).flatMap((handler, index) => ownsHandler(block, handler, selector) ? [[matcher, index] as const] : []));
}

/**
 * The owned event/matcher/handlers only; unrelated settings do not become our fingerprint.
 *
 * Sorted by matcher, because a provider whose delivery is several entries would otherwise have
 * its identity depend on the order they happen to sit in — and that order belongs to whoever
 * last edited the file. Someone adding an unrelated hook, or an editor tidying the array, would
 * change nothing of ours and still make every command refuse to recognise it. This is the same
 * reasoning that keeps object key order out of ownership one level down.
 */
export function ownedHook(before: string | null, selector: string | HookSpec, path: string, t: Messages): string | null {
  const selected = entriesOf(parse(before, path, t)).flatMap((block) => {
    const hooks = block.hooks?.filter((handler) => ownsHandler(block, handler, selector)) ?? [];
    return hooks.length ? [{ ...block, hooks }] : [];
  });
  // Code-unit order, not `localeCompare`: this sort exists so identity does not depend on the
  // environment, and a locale collation is the one comparator that does.
  selected.sort((left, right) => {
    const [a, b] = [String(left.matcher ?? ""), String(right.matcher ?? "")];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return selected.length ? serialize({ hooks: { SessionStart: selected } }) : null;
}

/**
 * The document with our delivery present, exactly once — one entry per matcher the spec names.
 *
 * Idempotent by replacement rather than by append: a second run must not leave a duplicate, and
 * an entry whose shape moved between versions has to be brought up to date rather than left
 * beside its older self.
 */
export function withHook(before: string | null, selector: string | HookSpec, path: string, t: Messages): string {
  const doc = parse(before, path, t);
  const ours: Matcher[] = typeof selector === "string"
    ? [{
        matcher: MATCHER,
        hooks: [{ type: "command", command: selector, additionalContextLimit: CONTEXT_LIMIT }],
      }]
    : selector.matchers.map((matcher) => ({ matcher, hooks: [{ ...selector.handler }] }));
  const kept = withoutOursFromEntries(entriesOf(doc), selector);
  if (typeof selector !== "string" && selector.documentDescription !== undefined && doc.description === undefined) {
    doc.description = selector.documentDescription;
  }
  return serialize({ ...doc, hooks: { ...doc.hooks, SessionStart: [...kept, ...ours] } });
}

/**
 * The document with our entry gone, or empty content when removing it leaves nothing.
 *
 * Empty content is not permission to delete its container: removal uses recorded creation
 * provenance for that decision. Native removal preserves a valid empty JSON document when
 * its caller cannot prove ownership of the whole file. Leave unrelated documents byte-identical.
 */
export function withoutHook(
  before: string,
  selector: string | HookSpec,
  path: string,
  t: Messages,
  empty: "content" | "document" = "content",
): string {
  const doc = parse(before, path, t);
  if (!entriesOf(doc).some((block) => block.hooks?.some((handler) => ownsHandler(block, handler, selector)))) {
    return before;
  }
  const kept = withoutOursFromEntries(entriesOf(doc), selector);
  const hooks: Record<string, Matcher[]> = { ...doc.hooks };
  if (kept.length) hooks.SessionStart = kept;
  else delete hooks.SessionStart;

  const rest: Document = { ...doc };
  if (Object.keys(hooks).length) rest.hooks = hooks;
  else delete rest.hooks;
  if (typeof selector !== "string" && selector.documentDescription !== undefined &&
    rest.description === selector.documentDescription) delete rest.description;

  return Object.keys(rest).length === 0 && empty === "content" ? "" : serialize(rest);
}
