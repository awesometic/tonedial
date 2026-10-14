// Native JSON transforms preserve unrelated settings and handlers. A native delivery is
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

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "PreInvocation";

/** One native event in a multi-event delivery. */
export type HookEventSpec = {
  event: HookEvent;
  matchers: readonly string[];
  handler: HookHandler;
};

/** SessionStart uses lifecycle matchers; Antigravity's PreInvocation runs the handler directly. */
export type HookSpec = {
  /** The primary event; omitted means the historical SessionStart event. */
  event?: HookEvent;
  matchers: readonly string[];
  handler: HookHandler;
  /** Separately owned file-level metadata; never part of a handler fingerprint. */
  documentDescription?: string;
  /** Additional managed events sharing this registration and physical settings file. */
  events?: readonly HookEventSpec[];
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
function parse(before: string | null, path: string, t: Messages, named = false): Document {
  if (before === null || before.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(before);
  } catch (cause) {
    throw new ConfigError(t.errors.hooksNotJson(path, (cause as Error).message));
  }
  if (!isPlainObject(value)) throw new ConfigError(t.errors.hooksNotJson(path, ""));
  if (named) return value as Document;
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

const eventOf = (spec: HookSpec): HookEvent => spec.event ?? "SessionStart";

const partsOf = (spec: HookSpec): HookEventSpec[] => [
  { event: eventOf(spec), matchers: spec.matchers, handler: spec.handler },
  ...(spec.events ?? []),
];

const entriesOf = (doc: Document, event: HookEvent = "SessionStart"): Matcher[] => doc.hooks?.[event] ?? [];

function namedDefinition(doc: Document, path: string, t: Messages): Record<string, unknown> | null {
  if (doc.tonedial === undefined) return null;
  if (!isPlainObject(doc.tonedial) || (doc.tonedial.PreInvocation !== undefined &&
      (!Array.isArray(doc.tonedial.PreInvocation) || doc.tonedial.PreInvocation.some(handler => !isPlainObject(handler))))) {
    throw new ConfigError(t.errors.hooksNotJson(path, "tonedial.PreInvocation must be an array of handlers"));
  }
  return doc.tonedial;
}

const invocationHandlers = (definition: Record<string, unknown> | null): HookEntry[] =>
  (definition?.PreInvocation as HookEntry[] | undefined) ?? [];

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
const ownsNativeHandler = (block: Matcher, handler: HookEntry, spec: HookEventSpec): boolean =>
  (spec.matchers.length === 0
    ? block.matcher === undefined
    : typeof block.matcher === "string" && spec.matchers.includes(block.matcher)) &&
  sameJsonValue(handler, spec.handler);

/** Select a legacy command by its historical identity, or a native entry by its full shape. */
const ownsHandler = (block: Matcher, handler: HookEntry, selector: string | HookEventSpec): boolean =>
  typeof selector === "string" ? ownsLegacyHandler(handler, selector) : ownsNativeHandler(block, handler, selector);

/** Remove only our handlers from one matcher block, preserving its siblings and unknown fields. */
const withoutOurs = (block: Matcher, selector: string | HookEventSpec): Matcher | null => {
  if (block.hooks === undefined) return block;
  const kept = block.hooks.filter((h) => !ownsHandler(block, h, selector));
  if (kept.length === block.hooks.length) return block;
  if (kept.length) return { ...block, hooks: kept };
  const hasUnknownFields = Object.keys(block).some((key) => key !== "matcher" && key !== "hooks");
  return hasUnknownFields ? { ...block, hooks: [] } : null;
};

/** Remove our handlers from every SessionStart block, retaining blocks that still have siblings. */
const withoutOursFromEntries = (entries: Matcher[], selector: string | HookEventSpec): Matcher[] =>
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
  if (typeof selector !== "string" && eventOf(selector) === "PreInvocation") {
    return ownedHook(before, selector, path, t) !== null;
  }
  const document = parse(before, path, t);
  if (typeof selector === "string") return entriesOf(document).some((block) =>
    block.hooks?.some((handler) => ownsHandler(block, handler, selector)) ?? false);
  return partsOf(selector).every((part) => {
    const entries = entriesOf(document, part.event);
    const present = (matcher: string | undefined) => entries.some((block) =>
      (matcher === undefined ? block.matcher === undefined : block.matcher === matcher) &&
      (block.hooks?.some((handler) => ownsHandler(block, handler, part)) ?? false));
    return part.matchers.length ? part.matchers.every(present) : present(undefined);
  });
}

/** Positions of exact managed handlers in the host's unfiltered matcher/handler arrays. */
export function ownedHookLocations(before: string | null, selector: HookSpec, path: string, t: Messages): readonly (readonly [number, number])[] {
  const primary = partsOf(selector)[0]!;
  if (primary.event !== "SessionStart") return [];
  return entriesOf(parse(before, path, t), primary.event).flatMap((block, matcher) =>
    (block.hooks ?? []).flatMap((handler, index) => ownsHandler(block, handler, primary) ? [[matcher, index] as const] : []));
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
  if (typeof selector !== "string" && eventOf(selector) === "PreInvocation") {
    const definition = namedDefinition(parse(before, path, t, true), path, t);
    const selected = invocationHandlers(definition).filter(handler => sameJsonValue(handler, selector.handler));
    return selected.length ? serialize({ tonedial: { PreInvocation: selected } }) : null;
  }
  const document = parse(before, path, t);
  const selected: Record<string, Matcher[]> = {};
  const parts: HookEventSpec[] = typeof selector === "string"
    ? [{ event: "SessionStart", matchers: [], handler: { type: "command", command: selector } }]
    : partsOf(selector);
  for (const part of parts) {
    const entries = entriesOf(document, part.event).flatMap((block) => {
      const hooks = block.hooks?.filter((handler) => ownsHandler(block, handler, typeof selector === "string" ? selector : part)) ?? [];
      return hooks.length ? [{ ...block, hooks }] : [];
    });
    if (entries.length) {
      // Code-unit order, not localeCompare: identity must not depend on the environment.
      entries.sort((left, right) => {
        const [a, b] = [String(left.matcher ?? ""), String(right.matcher ?? "")];
        return a < b ? -1 : a > b ? 1 : 0;
      });
      selected[part.event] = [...(selected[part.event] ?? []), ...entries];
    }
  }
  const hooks = Object.fromEntries(Object.entries(selected).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return Object.keys(hooks).length ? serialize({ hooks }) : null;
}

/**
 * The document with our delivery present, exactly once — one entry per matcher the spec names.
 *
 * Idempotent by replacement rather than by append: a second run must not leave a duplicate, and
 * an entry whose shape moved between versions has to be brought up to date rather than left
 * beside its older self.
 */
export function withHook(before: string | null, selector: string | HookSpec, path: string, t: Messages): string {
  if (typeof selector !== "string" && eventOf(selector) === "PreInvocation") {
    const doc = parse(before, path, t, true);
    const definition = namedDefinition(doc, path, t);
    const kept = invocationHandlers(definition).filter(handler => !sameJsonValue(handler, selector.handler));
    return serialize({ ...doc, tonedial: { enabled: true, ...definition, PreInvocation: [...kept, { ...selector.handler }] } });
  }
  const doc = parse(before, path, t);
  const parts: HookEventSpec[] = typeof selector === "string"
    ? [{ event: "SessionStart", matchers: [MATCHER], handler: { type: "command", command: selector, additionalContextLimit: CONTEXT_LIMIT } }]
    : partsOf(selector);
  const hooks: Record<string, Matcher[]> = { ...doc.hooks };
  for (const part of parts) {
    const kept = withoutOursFromEntries(entriesOf(doc, part.event), typeof selector === "string" ? selector : part);
    const ours = part.matchers.length
      ? part.matchers.map((matcher) => ({ matcher, hooks: [{ ...part.handler }] }))
      : [{ hooks: [{ ...part.handler }] }];
    hooks[part.event] = [...kept, ...ours];
  }
  if (typeof selector !== "string" && selector.documentDescription !== undefined && doc.description === undefined) {
    doc.description = selector.documentDescription;
  }
  return serialize({ ...doc, hooks });
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
  if (typeof selector !== "string" && eventOf(selector) === "PreInvocation") {
    const doc = parse(before, path, t, true);
    const definition = namedDefinition(doc, path, t);
    const handlers = invocationHandlers(definition);
    const kept = handlers.filter(handler => !sameJsonValue(handler, selector.handler));
    if (kept.length === handlers.length) return before;
    const remaining = { ...definition };
    if (kept.length) remaining.PreInvocation = kept;
    else delete remaining.PreInvocation;
    if (Object.keys(remaining).every(key => key === "enabled")) delete doc.tonedial;
    else doc.tonedial = remaining;
    return Object.keys(doc).length === 0 && empty === "content" ? "" : serialize(doc);
  }
  const doc = parse(before, path, t);
  const parts: HookEventSpec[] = typeof selector === "string"
    ? [{ event: "SessionStart", matchers: [], handler: { type: "command", command: selector } }]
    : partsOf(selector);
  const hooks: Record<string, Matcher[]> = { ...doc.hooks };
  let changed = false;
  for (const part of parts) {
    const entries = entriesOf(doc, part.event);
    if (!entries.some((block) => block.hooks?.some((handler) => ownsHandler(block, handler, typeof selector === "string" ? selector : part)))) continue;
    changed = true;
    const kept = withoutOursFromEntries(entries, typeof selector === "string" ? selector : part);
    if (kept.length) hooks[part.event] = kept;
    else delete hooks[part.event];
  }
  if (!changed) return before;

  const rest: Document = { ...doc };
  if (Object.keys(hooks).length) rest.hooks = hooks;
  else delete rest.hooks;
  if (typeof selector !== "string" && selector.documentDescription !== undefined &&
    rest.description === selector.documentDescription) delete rest.description;

  return Object.keys(rest).length === 0 && empty === "content" ? "" : serialize(rest);
}
