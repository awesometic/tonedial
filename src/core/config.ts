// Saved tone, user settings, seed provenance, and wiring ownership.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { catalogue, type Messages } from "./i18n.ts";
import { AXIS_DEFAULT, AXIS_ORDER, type Axes, type Axis, type Level } from "./anchors.ts";
import { PERSONA_DESCRIPTION_MAX, type Persona } from "./combos.ts";
import type { SpeechLevel } from "./compile.ts";
import { decodeTupleKey, emptyWiring, normalizeWiring, registrationKey, resourceKey } from "../wiring/ownership.ts";
import { AGENT_TOOLS } from "./paths.ts";

export const CONFIG_SCHEMA = 2 as const;
export const LEGACY_CONFIG_SCHEMA = 1 as const;

export const AGE_BANDS = ["unspecified", "teens", "20s", "30s", "40s", "50s+"] as const;
export const GENDERS = ["unspecified", "masculine", "feminine", "neutral"] as const;
export const SPEECH_LEVELS = ["auto", "polite", "plain"] as const;

export const WIRING_SCOPES = ["global", "project"] as const;
export type WiringScope = (typeof WIRING_SCOPES)[number];

export const RESOURCE_KINDS = ["hook", "skill", "shell", "reader", "command"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_TYPES = ["file", "directory", "symlink"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type ManagedSeed = {
  path: string;
  type: "file";
  version: number;
  sha256: string;
};

export type ManagedSeeds = Record<string, ManagedSeed>;

export type ResourceExpected = {
  type: ResourceType;
  linkTarget?: string;
  sha256?: string;
  files?: Record<string, string>;
};

/** Additional native events sharing one managed hook resource. */
export type ManagedHookEvent = {
  event: string;
  matchers: string[];
  command: string;
  args?: string[];
  statusMessage?: string;
  name?: string;
  description?: string;
};

/** The lexical access path a registration used for a physically shared text resource. */
export type ResourceAccess = {
  path: string;
  type: "file" | "symlink";
  linkTarget?: string;
};

export type ManagedResource = {
  path: string;
  kind: ResourceKind;
  created: boolean;
  createdDir: boolean;
  consumers: string[];
  /** Optional for older schema-2 records; keyed by registration, not by physical resource. */
  accessPaths?: Record<string, ResourceAccess>;
  expected: ResourceExpected;
  /** Native handler identities are per registration even when the settings file is shared. */
  managedByRegistration?: Record<string, ManagedResource["managed"]>;
  /** File-level description inserted by ToneDial, independent of its handler consumers. */
  documentDescription?: string;
  managed: {
    version: number;
    event?: string;
    /** One entry per matcher is written, so the record holds the set rather than one name. */
    matchers?: string[];
    matcher?: string;
    handlerSha256?: string;
    /** Installed hook identity, retained when the CLI's runtime path later changes. */
    command?: string;
    runtime?: string;
    args?: string[];
    /** Provider-supported display fields are part of the exact installed handler. */
    statusMessage?: string;
    name?: string;
    description?: string;
    regionId?: string;
    /** Additional event handlers in the same provider document. */
    events?: ManagedHookEvent[];
  };
};

export type WiringRegistration = {
  target: string;
  scope: WiringScope;
  destination: string;
  resourceIds: string[];
  /** Explicit native selection survives missing resources; legacy records omit it. */
  context?: "pair";
};

export type WiringRegistrationMap = Record<string, WiringRegistration>;
export type WiringResourceMap = Record<string, ManagedResource>;

export type WiringV2 = {
  registrations: WiringRegistrationMap;
  resources: WiringResourceMap;
};

/** Legacy ownership stays opaque until an approved migration records its evidence. */
export type ConfigWiring = {
  registrations?: WiringRegistrationMap;
  resources?: WiringResourceMap;
  [legacyKey: string]: unknown;
};

export type Config = {
  schema: number;
  /** Last applied or saved profile; retained when current tone settings diverge. */
  preset: string | null;
  /** True when tone settings have changed since the profile was applied or saved. */
  unsaved: boolean;
  axes: Axes;
  persona: Persona;
  safeword: string | null;
  speech_level: SpeechLevel;
  /** The interface language. Never reaches `tone.md`. */
  language: string;
  /** Destination/resource ownership. Schema 1 contains the legacy per-tool map. */
  wiring: ConfigWiring;
  /** Last successfully applied bytes for bundled state-root seeds. */
  managedSeeds: ManagedSeeds;
  /** Package-generation summary; managedSeeds records individual applied bytes. */
  seedVersion: number;
};

export type ConfigV2 = Omit<Config, "schema" | "wiring"> & {
  schema: typeof CONFIG_SCHEMA;
  wiring: WiringV2;
};

export type LegacyOwnershipEvidence = {
  schema: typeof LEGACY_CONFIG_SCHEMA;
  /** The old map is intentionally opaque: unknown provenance must survive for the journal. */
  wiring: Record<string, unknown>;
  managedSeeds: ManagedSeeds;
};

export type ApprovedConfigMigration = {
  config: ConfigV2;
  legacy: LegacyOwnershipEvidence;
};

export function defaultConfig(): Config {
  return {
    schema: CONFIG_SCHEMA,
    preset: null,
    unsaved: false,
    axes: { ...AXIS_DEFAULT },
    persona: { age: null, gender: null, address: null, note: null, user: null, agent: null },
    safeword: null,
    speech_level: "auto",
    language: "en",
    wiring: emptyWiring(),
    managedSeeds: {},
    seedVersion: 0,
  };
}

export class ConfigError extends Error {}

/** An object, and not an array — `typeof [] === "object"`, which let a JSON array through. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isLevel = (v: unknown): v is Level =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;

function readAxes(raw: unknown, t: Messages): Axes {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    throw new ConfigError(t.config.notAnObject("axes"));
  }
  const source = (raw ?? {}) as Record<string, unknown>;
  const axes = {} as Axes;
  for (const axis of AXIS_ORDER) {
    const value = source[axis];
    // A missing axis takes its default rather than failing: a config written by an older
    // version is a normal thing to meet, and the emit-all rule then covers it anyway.
    if (value === undefined) {
      axes[axis] = AXIS_DEFAULT[axis];
      continue;
    }
    if (!isLevel(value)) {
      throw new ConfigError(t.axis.range(`axes.${axis}`, JSON.stringify(value)));
    }
    axes[axis] = value;
  }
  for (const key of Object.keys(source)) {
    if (!(AXIS_ORDER as readonly string[]).includes(key)) {
      throw new ConfigError(t.axis.unknown(`axes.${key}`, null));
    }
  }
  return axes;
}

const asString = (v: unknown, field: string, t: Messages): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ConfigError(t.config.notAString(field));
  return v;
};

function readPersona(raw: unknown, t: Messages): Persona {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    throw new ConfigError(t.config.notAnObject("persona"));
  }
  const p = (raw ?? {}) as Record<string, unknown>;
  // `unspecified` is the closed set's own word for "not set", so it normalises to null here.
  // Two spellings of the same state diverged downstream: the compiler omitted the field and
  // `show` reported a persona the artifact did not carry.
  const unset = (v: string | null) => (v === null || v === "unspecified" ? null : v);
  const age = unset(asString(p.age, "persona.age", t));
  const gender = unset(asString(p.gender, "persona.gender", t));
  if (age !== null && !(AGE_BANDS as readonly string[]).includes(age)) {
    throw new ConfigError(t.persona.age(String(age), AGE_BANDS));
  }
  if (gender !== null && !(GENDERS as readonly string[]).includes(gender)) {
    throw new ConfigError(t.persona.gender(GENDERS));
  }
  if (p.address !== undefined && p.address !== null && !isRecord(p.address)) {
    throw new ConfigError(t.config.notAnObject("persona.address"));
  }
  const address = (p.address ?? null) as Record<string, unknown> | null;
  const self_ref = address ? asString(address.self_ref, "persona.address.self_ref", t) : null;
  const user_ref = address ? asString(address.user_ref, "persona.address.user_ref", t) : null;
  // The note's character budget warns on write; reading must retain an accepted long note.
  const note = asString(p.note, "persona.note", t);
  const description = (field: "user" | "agent"): string | null => {
    const rawValue = asString(p[field], `persona.${field}`, t);
    if (rawValue === null) return null;
    const value = rawValue.trim();
    if (value === "") return null;
    const count = [...value].length;
    if (count > PERSONA_DESCRIPTION_MAX) {
      throw new ConfigError(t.persona.descriptionOverCap(`persona.${field}`, count, PERSONA_DESCRIPTION_MAX));
    }
    return value;
  };
  return {
    age,
    gender,
    address: self_ref || user_ref ? { self_ref, user_ref } : null,
    note,
    user: description("user"),
    agent: description("agent"),
  };
}

const SHA256 = /^[a-f0-9]{64}$/i;

function invalidValue(field: string, t: Messages): never {
  throw new ConfigError(t.config.unreadable(`${field} has an invalid value`));
}

function requiredObject(raw: unknown, field: string, t: Messages): Record<string, unknown> {
  if (!isRecord(raw)) throw new ConfigError(t.config.notAnObject(field));
  return raw;
}

function requiredString(raw: unknown, field: string, t: Messages): string {
  if (typeof raw !== "string" || raw.length === 0) throw new ConfigError(t.config.notAString(field));
  return raw;
}

function absolutePath(raw: unknown, field: string, t: Messages): string {
  const value = requiredString(raw, field, t);
  if (!isAbsolute(value)) invalidValue(field, t);
  return value;
}

function requiredBoolean(raw: unknown, field: string, t: Messages): boolean {
  if (typeof raw !== "boolean") throw new ConfigError(t.config.notABoolean(field));
  return raw;
}

function requiredInteger(raw: unknown, field: string, t: Messages): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) invalidValue(field, t);
  return raw;
}

function hash(raw: unknown, field: string, t: Messages): string {
  const value = requiredString(raw, field, t);
  if (!SHA256.test(value)) invalidValue(field, t);
  return value.toLowerCase();
}

function optionalHash(raw: unknown, field: string, t: Messages): string | undefined {
  if (raw === undefined) return undefined;
  return hash(raw, field, t);
}

function rejectUnknown(source: Record<string, unknown>, allowed: readonly string[], field: string, t: Messages): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ConfigError(t.config.unknownKey(`${field}.${unknown.join(", ")}`, [...allowed]));
}

function stringArray(raw: unknown, field: string, t: Messages): string[] {
  if (!Array.isArray(raw)) invalidValue(field, t);
  const result: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || result.includes(value)) invalidValue(field, t);
    result.push(value);
  }
  return result;
}

function readManagedSeeds(raw: unknown, t: Messages): ManagedSeeds {
  if (raw === undefined) return {};
  const source = requiredObject(raw, "managedSeeds", t);
  const result: ManagedSeeds = {};
  for (const id of Object.keys(source).sort()) {
    if (id.length === 0) invalidValue("managedSeeds", t);
    const seed = requiredObject(source[id], `managedSeeds.${id}`, t);
    rejectUnknown(seed, ["path", "type", "version", "sha256"], `managedSeeds.${id}`, t);
    const type = requiredString(seed.type, `managedSeeds.${id}.type`, t);
    if (type !== "file") invalidValue(`managedSeeds.${id}.type`, t);
    result[id] = {
      path: absolutePath(seed.path, `managedSeeds.${id}.path`, t),
      type: "file",
      version: requiredInteger(seed.version, `managedSeeds.${id}.version`, t),
      sha256: hash(seed.sha256, `managedSeeds.${id}.sha256`, t),
    };
  }
  return result;
}

function readExpected(raw: unknown, field: string, t: Messages): ResourceExpected {
  const source = requiredObject(raw, field, t);
  rejectUnknown(source, ["type", "linkTarget", "sha256", "files"], field, t);
  const type = requiredString(source.type, `${field}.type`, t);
  if (!(RESOURCE_TYPES as readonly string[]).includes(type)) invalidValue(`${field}.type`, t);
  const linkTarget = source.linkTarget;
  if (type === "symlink" && typeof linkTarget !== "string") invalidValue(`${field}.linkTarget`, t);
  if (type !== "symlink" && linkTarget !== undefined) invalidValue(`${field}.linkTarget`, t);
  const sha256 = optionalHash(source.sha256, `${field}.sha256`, t);
  let files: Record<string, string> | undefined;
  if (source.files !== undefined) {
    if (type !== "directory") invalidValue(`${field}.files`, t);
    const fileSource = requiredObject(source.files, `${field}.files`, t);
    files = {};
    for (const relative of Object.keys(fileSource).sort()) {
      if (relative.length === 0 || isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        invalidValue(`${field}.files`, t);
      }
      files[relative] = hash(fileSource[relative], `${field}.files.${relative}`, t);
    }
  }
  const expected: ResourceExpected = { type: type as ResourceType };
  if (typeof linkTarget === "string") expected.linkTarget = linkTarget;
  if (sha256 !== undefined) expected.sha256 = sha256;
  if (files !== undefined) expected.files = files;
  return expected;
}

function readManagedEvent(raw: unknown, field: string, t: Messages): ManagedHookEvent {
  const source = requiredObject(raw, field, t);
  rejectUnknown(source, ["event", "matchers", "command", "args", "statusMessage", "name", "description"], field, t);
  const event = requiredString(source.event, `${field}.event`, t);
  if (event !== "UserPromptSubmit" && event !== "Stop") invalidValue(`${field}.event`, t);
  const matchers = source.matchers === undefined ? [] : stringArray(source.matchers, `${field}.matchers`, t);
  if (matchers.length !== 0) invalidValue(`${field}.matchers`, t);
  const result: ManagedHookEvent = { event, matchers, command: requiredString(source.command, `${field}.command`, t) };
  if (result.command.includes("\0")) invalidValue(`${field}.command`, t);
  if (source.args !== undefined) {
    const args = stringArray(source.args, `${field}.args`, t);
    if (args.some((arg) => arg.includes("\0"))) invalidValue(`${field}.args`, t);
    result.args = args;
  }
  for (const key of ["statusMessage", "name", "description"] as const) {
    if (source[key] === undefined) continue;
    const value = requiredString(source[key], `${field}.${key}`, t);
    if (value.includes("\0")) invalidValue(`${field}.${key}`, t);
    result[key] = value;
  }
  return result;
}

function readManaged(raw: unknown, field: string, t: Messages): ManagedResource["managed"] {
  const source = requiredObject(raw, field, t);
  rejectUnknown(source, ["version", "event", "matcher", "matchers", "handlerSha256", "command", "runtime", "args", "statusMessage", "name", "description", "regionId", "events"], field, t);
  const managed: ManagedResource["managed"] = {
    version: requiredInteger(source.version, `${field}.version`, t),
  };
  for (const key of ["event", "matcher", "command", "runtime", "regionId"] as const) {
    if (source[key] !== undefined) managed[key] = requiredString(source[key], `${field}.${key}`, t);
  }
  for (const key of ["statusMessage", "name", "description"] as const) {
    if (source[key] === undefined) continue;
    const value = requiredString(source[key], `${field}.${key}`, t);
    if (managed.version !== 2 || value.includes("\0")) invalidValue(`${field}.${key}`, t);
    managed[key] = value;
  }
  const handlerSha256 = optionalHash(source.handlerSha256, `${field}.handlerSha256`, t);
  if (handlerSha256 !== undefined) managed.handlerSha256 = handlerSha256;
  // A native record written before delivery could need several entries carries one `matcher`.
  // Read it as the one-element list it always was, so an existing installation keeps its
  // ownership. A retained legacy record is left exactly as found: it round-trips untouched, and
  // adding a field to it would rewrite provenance this tool only ever reads.
  if (source.matchers !== undefined) {
    if (!Array.isArray(source.matchers) || (source.matchers.length === 0 && managed.event !== "PreInvocation") ||
        new Set(source.matchers).size !== source.matchers.length ||
        source.matchers.some((matcher) => typeof matcher !== "string" || matcher === "" || matcher.includes("\0"))) {
      invalidValue(`${field}.matchers`, t);
    }
    managed.matchers = [...source.matchers as string[]];
  } else if (managed.matcher !== undefined && managed.version === 2) {
    if (managed.matcher.includes("\0")) invalidValue(`${field}.matcher`, t);
    managed.matchers = [managed.matcher];
  }
  if (source.args !== undefined) {
    if (!Array.isArray(source.args) || source.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      invalidValue(`${field}.args`, t);
    }
    managed.args = [...source.args as string[]];
  }
  if (source.events !== undefined) {
    if (!Array.isArray(source.events) || source.events.length === 0) invalidValue(`${field}.events`, t);
    managed.events = source.events.map((event, index) => readManagedEvent(event, `${field}.events.${index}`, t));
    if (new Set(managed.events.map((event) => event.event)).size !== managed.events.length) {
      invalidValue(`${field}.events`, t);
    }
  }
  return managed;
}

function readAccessPaths(raw: unknown, field: string, t: Messages): Record<string, ResourceAccess> | undefined {
  if (raw === undefined) return undefined;
  const source = requiredObject(raw, field, t);
  const result: Record<string, ResourceAccess> = {};
  for (const key of Object.keys(source).sort()) {
    const value = requiredObject(source[key], `${field}.${key}`, t);
    rejectUnknown(value, ["path", "type", "linkTarget"], `${field}.${key}`, t);
    const path = absolutePath(value.path, `${field}.${key}.path`, t);
    const type = requiredString(value.type, `${field}.${key}.type`, t);
    if (type !== "file" && type !== "symlink") invalidValue(`${field}.${key}.type`, t);
    const linkTarget = value.linkTarget;
    if (type === "symlink" && typeof linkTarget !== "string") invalidValue(`${field}.${key}.linkTarget`, t);
    if (type !== "symlink" && linkTarget !== undefined) invalidValue(`${field}.${key}.linkTarget`, t);
    result[key] = {
      path,
      type: type as ResourceAccess["type"],
      ...(typeof linkTarget === "string" ? { linkTarget } : {}),
    };
  }
  return result;
}

function readWiringV2(raw: unknown, t: Messages): WiringV2 {
  const source = requiredObject(raw, "wiring", t);
  rejectUnknown(source, ["registrations", "resources"], "wiring", t);
  const registrationSource = requiredObject(source.registrations, "wiring.registrations", t);
  const resourceSource = requiredObject(source.resources, "wiring.resources", t);
  const registrations: WiringRegistrationMap = {};
  const resources: WiringResourceMap = {};

  for (const key of Object.keys(registrationSource).sort()) {
    const tuple = decodeTupleKey(key, 3);
    if (!tuple) invalidValue(`wiring.registrations.${key}`, t);
    const value = requiredObject(registrationSource[key], `wiring.registrations.${key}`, t);
    rejectUnknown(value, ["target", "scope", "destination", "resourceIds", "context"], `wiring.registrations.${key}`, t);
    if (value.context !== undefined && value.context !== "pair") invalidValue(`wiring.registrations.${key}.context`, t);
    const target = requiredString(value.target, `wiring.registrations.${key}.target`, t);
    const scope = requiredString(value.scope, `wiring.registrations.${key}.scope`, t);
    if (!(WIRING_SCOPES as readonly string[]).includes(scope)) invalidValue(`wiring.registrations.${key}.scope`, t);
    const destination = absolutePath(value.destination, `wiring.registrations.${key}.destination`, t);
    if (registrationKey(target, scope as WiringScope, destination) !== key) invalidValue(`wiring.registrations.${key}`, t);
    registrations[key] = {
      target,
      scope: scope as WiringScope,
      destination,
      resourceIds: stringArray(value.resourceIds, `wiring.registrations.${key}.resourceIds`, t),
      ...(value.context === "pair" ? { context: "pair" as const } : {}),
    };
  }

  for (const key of Object.keys(resourceSource).sort()) {
    const tuple = decodeTupleKey(key, 2);
    if (!tuple) invalidValue(`wiring.resources.${key}`, t);
    const value = requiredObject(resourceSource[key], `wiring.resources.${key}`, t);
    rejectUnknown(value, ["path", "kind", "created", "createdDir", "consumers", "accessPaths", "expected", "managed", "managedByRegistration", "documentDescription"], `wiring.resources.${key}`, t);
    const canonicalPath = absolutePath(tuple[0], `wiring.resources.${key}`, t);
    const kind = requiredString(tuple[1], `wiring.resources.${key}`, t);
    if (!(RESOURCE_KINDS as readonly string[]).includes(kind)) invalidValue(`wiring.resources.${key}`, t);
    if (resourceKey(canonicalPath, kind as ResourceKind) !== key) invalidValue(`wiring.resources.${key}`, t);
    const path = absolutePath(value.path, `wiring.resources.${key}.path`, t);
    const expected = readExpected(value.expected, `wiring.resources.${key}.expected`, t);
    const accessPaths = readAccessPaths(value.accessPaths, `wiring.resources.${key}.accessPaths`, t);
    const managedByRegistration: NonNullable<ManagedResource["managedByRegistration"]> = {};
    const documentDescription = value.documentDescription === undefined ? undefined
      : requiredString(value.documentDescription, `wiring.resources.${key}.documentDescription`, t);
    if (documentDescription !== undefined && (kind !== "hook" || documentDescription.includes("\0"))) {
      invalidValue(`wiring.resources.${key}.documentDescription`, t);
    }
    if (value.managedByRegistration !== undefined) {
      for (const [id, metadata] of Object.entries(requiredObject(value.managedByRegistration, `wiring.resources.${key}.managedByRegistration`, t))) {
        const registration = registrations[id];
        if (!registration?.resourceIds.includes(key) || registration.context !== "pair"
          // `AGENT_TOOLS` rather than a list written out here. The list was a copy, and a copy is
          // a place a newly supported tool gets forgotten — its registrations would then read as
          // invalid config on a machine where setup had just written them.
          || !(AGENT_TOOLS as readonly string[]).includes(registration.target)) {
          invalidValue(`wiring.resources.${key}.managedByRegistration`, t);
        }
        managedByRegistration[id] = readManaged(metadata, `wiring.resources.${key}.managedByRegistration.${id}`, t);
        const managed = managedByRegistration[id]!;
        const completeRegularEvents = managed.events === undefined ||
          (managed.events.length === 2 && new Set(managed.events.map((event) => event.event)).size === 2 &&
            managed.events.some((event) => event.event === "UserPromptSubmit") &&
            managed.events.some((event) => event.event === "Stop"));
        const validEvent = registration.target === "antigravity"
          ? managed.event === "PreInvocation" && managed.matchers?.length === 0 && managed.events === undefined
          : managed.event === "SessionStart" && !!managed.matchers?.length &&
            completeRegularEvents;
        if (kind !== "hook" || managed.version !== 2 || !validEvent
          || !managed.command || managed.command.includes("\0") || !managed.handlerSha256
          || !managed.runtime || !isAbsolute(managed.runtime) || managed.runtime.includes("\0")) {
          invalidValue(`wiring.resources.${key}.managedByRegistration.${id}`, t);
        }
      }
    }
    // Ordinary files and directories are keyed by their physical path. A symlink is keyed by its
    // lexical link entry, so its retained path may legitimately differ from the tuple path.
    if (expected.type !== "symlink" && path !== canonicalPath) invalidValue(`wiring.resources.${key}.path`, t);
    resources[key] = {
      path,
      kind: kind as ResourceKind,
      created: requiredBoolean(value.created, `wiring.resources.${key}.created`, t),
      createdDir: requiredBoolean(value.createdDir, `wiring.resources.${key}.createdDir`, t),
      consumers: stringArray(value.consumers, `wiring.resources.${key}.consumers`, t),
      ...(accessPaths === undefined ? {} : { accessPaths }),
      ...(Object.keys(managedByRegistration).length ? { managedByRegistration } : {}),
      ...(documentDescription === undefined ? {} : { documentDescription }),
      expected,
      managed: readManaged(value.managed, `wiring.resources.${key}.managed`, t),
    };
  }

  for (const [registrationId, registration] of Object.entries(registrations)) {
    for (const resourceId of registration.resourceIds) {
      const resource = resources[resourceId];
      if (!resource || !resource.consumers.includes(registrationId)) invalidValue(`wiring.registrations.${registrationId}.resourceIds`, t);
      // A missing native identity is damaged ownership, never permission to use legacy cleanup.
      if (registration.context === "pair" && resource.kind === "hook" && !resource.managedByRegistration?.[registrationId]) {
        invalidValue(`wiring.resources.${resourceId}.managedByRegistration`, t);
      }
    }
  }
  for (const [resourceId, resource] of Object.entries(resources)) {
    for (const registrationId of resource.consumers) {
      const registration = registrations[registrationId];
      if (!registration || !registration.resourceIds.includes(resourceId)) invalidValue(`wiring.resources.${resourceId}.consumers`, t);
    }
    for (const registrationId of [...Object.keys(resource.accessPaths ?? {}), ...Object.keys(resource.managedByRegistration ?? {})]) {
      const registration = registrations[registrationId];
      if (!registration || !registration.resourceIds.includes(resourceId) || !resource.consumers.includes(registrationId)) {
        invalidValue(`wiring.resources.${resourceId}.accessPaths`, t);
      }
    }
  }
  return normalizeWiring({ registrations, resources });
}

function readLegacyWiring(raw: unknown, t: Messages): ConfigWiring {
  if (raw === undefined) return {};
  return { ...requiredObject(raw, "wiring", t) } as ConfigWiring;
}

export function isWiringV2(wiring: ConfigWiring): wiring is WiringV2 {
  return isRecord(wiring.registrations) && isRecord(wiring.resources) &&
    Object.keys(wiring).every((key) => key === "registrations" || key === "resources");
}

export function isConfigV2(config: Config): config is ConfigV2 {
  return config.schema === CONFIG_SCHEMA && isWiringV2(config.wiring);
}

/** Require the new graph before a mutating caller can prepare a schema-2 write. */
export function requireConfigV2(config: Config, t: Messages = catalogue("en").cli): ConfigV2 {
  if (config.schema !== CONFIG_SCHEMA) {
    throw new ConfigError(t.config.futureSchema(config.schema, CONFIG_SCHEMA));
  }
  if (!isWiringV2(config.wiring)) {
    const legacyKeys = Object.keys(config.wiring).filter((key) => key !== "registrations" && key !== "resources");
    if (legacyKeys.length) throw new ConfigError(t.config.unknownKey(`wiring.${legacyKeys.join(", ")}`, ["registrations", "resources"]));
    throw new ConfigError(t.config.notAnObject("wiring.registrations/resources"));
  }
  return config as ConfigV2;
}

/**
 * Why a safeword cannot be saved, or null when it can.
 *
 * The rule has one owner because it has two callers that need it at different moments:
 * `parseConfig` refuses a phrase already on disk, and `init`'s interview asks again rather
 * than letting the refusal arrive after every question has been answered. A second copy of
 * the predicate would let the interview accept a phrase the serializer then rejects.
 *
 * The quote is the rule that exists: the phrase is interpolated between double quotes in the
 * controls body, so a quote inside it would
 * end the delimiter early and leave the rest reading as an instruction.
 */
export function safewordRejection(phrase: string, t: Messages): string | null {
  if (phrase.trim() === "") return t.config.safewordBlank;
  if (phrase.includes('"')) return t.config.safewordQuote;
  return null;
}

export function parseConfig(text: string, t: Messages = catalogue("en").cli): Config {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigError(t.config.unreadable((cause as Error).message));
  }
  if (!isRecord(raw)) throw new ConfigError(t.config.rootNotAnObject);

  // An unknown key is refused by name rather than silently dropped on the next write. This
  // file is user-editable, and a tool that eats what a person typed has no business asking
  // them to trust it with someone else's files later.
  const KNOWN = ["schema", "preset", "unsaved", "axes", "persona", "safeword", "guards", "fixed_width",
    "speech_level", "language", "seedVersion", "managedSeeds", "wiring"];
  const unknown = Object.keys(raw).filter((k) => !KNOWN.includes(k));
  if (unknown.length) throw new ConfigError(t.config.unknownKey(unknown.join(", "), KNOWN));

  // An absent schema is an old config, not an invitation to write a guessed new graph.
  const schema = raw.schema === undefined ? LEGACY_CONFIG_SCHEMA : raw.schema;
  if (schema !== LEGACY_CONFIG_SCHEMA && schema !== CONFIG_SCHEMA) {
    throw new ConfigError(t.config.futureSchema(Number(schema), CONFIG_SCHEMA));
  }

  const speech = asString(raw.speech_level, "speech_level", t) ?? "auto";
  if (!(SPEECH_LEVELS as readonly string[]).includes(speech)) {
    throw new ConfigError(t.settings.speechLevel(SPEECH_LEVELS));
  }
  const safeword = asString(raw.safeword, "safeword", t);
  if (safeword !== null) {
    const rejection = safewordRejection(safeword, t);
    if (rejection !== null) throw new ConfigError(rejection);
  }
  // Retired guards and width keys are read-only compatibility inputs. Malformed old values still
  // fail normal parsing, but valid values never become active state or new serialized bytes.
  for (const [field, value] of [["guards", raw.guards], ["unsaved", raw.unsaved],
    ["fixed_width", raw.fixed_width]] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new ConfigError(t.config.notABoolean(field));
    }
  }

  const common = {
    preset: asString(raw.preset, "preset", t),
    unsaved: raw.unsaved === true,
    axes: readAxes(raw.axes, t),
    persona: readPersona(raw.persona, t),
    safeword,
    speech_level: speech as SpeechLevel,
    // Absent in a config written before these existed, which is a normal thing to meet: the
    // fallback language and a seed version of zero both say "this home predates the seeds".
    language: asString(raw.language, "language", t) ?? "en",
    seedVersion: typeof raw.seedVersion === "number" ? raw.seedVersion : 0,
    managedSeeds: readManagedSeeds(raw.managedSeeds, t),
  };
  if (schema === CONFIG_SCHEMA) {
    return { schema: CONFIG_SCHEMA, ...common, wiring: readWiringV2(raw.wiring, t) };
  }
  return { schema: LEGACY_CONFIG_SCHEMA, ...common, wiring: readLegacyWiring(raw.wiring, t) };
}

/** Stable key order, two-space indent, one trailing newline — so a diff shows a real change. */
export function serializeConfig(config: Config, t: Messages = catalogue("en").cli): string {
  const current = requireConfigV2(config, t);
  const axes: Record<string, Level> = {};
  for (const axis of AXIS_ORDER) axes[axis] = current.axes[axis];
  // Normalize graph and seed ordering before serialization; the later parse only validates.
  const managedSeeds = readManagedSeeds(current.managedSeeds, t);
  const wiring = readWiringV2(current.wiring, t);
  const text =
    JSON.stringify(
      {
        schema: CONFIG_SCHEMA,
        preset: current.preset,
        unsaved: current.unsaved,
        axes,
        persona: current.persona,
        safeword: current.safeword,
        speech_level: current.speech_level,
        language: current.language,
        wiring,
        managedSeeds,
        seedVersion: current.seedVersion,
      },
      null,
      2,
    ) + "\n";
  // The parser owns remaining settings rules, including safeword syntax. Raw editor saves
  // deliberately bypass this serializer so invalid edits remain recoverable.
  parseConfig(text, t);
  return text;
}

/**
 * Prepare, but do not write, a schema-1 config for an explicitly approved migration. The old
 * ownership map remains opaque evidence; destination-level positive identification belongs to
 * the operation journal and must not be guessed here.
 */
export function prepareApprovedMigration(
  legacy: Config,
  t: Messages = catalogue("en").cli,
): ApprovedConfigMigration {
  if (legacy.schema !== LEGACY_CONFIG_SCHEMA) {
    throw new ConfigError(t.config.futureSchema(legacy.schema, CONFIG_SCHEMA));
  }
  const legacyWiring = structuredClone(legacy.wiring) as Record<string, unknown>;
  const managedSeeds = readManagedSeeds(legacy.managedSeeds, t);
  return {
    config: {
      schema: CONFIG_SCHEMA,
      preset: legacy.preset,
      unsaved: legacy.unsaved,
      axes: { ...legacy.axes },
      persona: structuredClone(legacy.persona),
      safeword: legacy.safeword,
      speech_level: legacy.speech_level,
      language: legacy.language,
      wiring: emptyWiring(),
      managedSeeds: structuredClone(managedSeeds),
      seedVersion: legacy.seedVersion,
    },
    legacy: {
      schema: LEGACY_CONFIG_SCHEMA,
      wiring: legacyWiring,
      managedSeeds,
    },
  };
}

export const USER_SETTING_KEYS = ["preset", "unsaved", "axes", "persona", "safeword", "speech_level", "language"] as const;

export type SettingsRecovery = {
  config: ConfigV2;
  recovered: string[];
  invalid: string[];
  metadataLost: boolean;
  /** Known absent-field defaults, distinct from surviving stored values and damaged values. */
  defaulted?: string[];
  /** Historical schema-1 data only; these flags never authorize external mutation. */
  legacy?: LegacyOwnershipEvidence | null;
};

/** Recover supported user values only. Opaque delivery metadata never becomes new authority. */
export function recoverSettings(text: string, t: Messages = catalogue("en").cli): SettingsRecovery | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isRecord(raw) || (raw.schema !== undefined && raw.schema !== LEGACY_CONFIG_SCHEMA && raw.schema !== CONFIG_SCHEMA)) return null;
  const schema = raw.schema ?? LEGACY_CONFIG_SCHEMA;
  let complete: Config | null = null;
  try {
    complete = parseConfig(text, t);
  } catch {
    // Recovery reports known field names, never parser excerpts or unrecognized private keys.
  }
  const config = complete === null ? requireConfigV2(defaultConfig(), t)
    : isConfigV2(complete) ? complete : prepareApprovedMigration(complete, t).config;
  const recovered: string[] = [];
  const invalid: string[] = [];
  const defaulted: string[] = [];
  if (raw.fixed_width !== undefined && typeof raw.fixed_width !== "boolean") invalid.push("fixed_width");
  if (raw.guards !== undefined && typeof raw.guards !== "boolean") invalid.push("guards");
  let metadataLost = schema === LEGACY_CONFIG_SCHEMA;
  let legacy: LegacyOwnershipEvidence | null = null;
  const accept = (name: string, candidate: ConfigV2): ConfigV2 | null => {
    try { return requireConfigV2(parseConfig(JSON.stringify(candidate), t), t); }
    catch { invalid.push(name); return null; }
  };
  for (const key of USER_SETTING_KEYS) {
    if (key === "axes" || key === "persona") continue;
    if (raw[key] === undefined) { defaulted.push(key); continue; }
    const parsed = accept(key, { ...config, [key]: raw[key] } as ConfigV2);
    if (parsed !== null) {
      Object.assign(config, { [key]: parsed[key] });
      recovered.push(key);
    }
  }
  if (!isRecord(raw.axes)) invalid.push("axes");
  else {
    let completeAxes = true;
    for (const axis of AXIS_ORDER) {
      const name = `axes.${axis}`;
      const value = raw.axes[axis];
      if (!isLevel(value)) {
        invalid.push(name);
        if (value === undefined) defaulted.push(name);
        completeAxes = false;
      } else {
        config.axes[axis] = value;
        recovered.push(name);
      }
    }
    if (completeAxes) recovered.push("axes");
    if (Object.keys(raw.axes).some(key => !(AXIS_ORDER as readonly string[]).includes(key))) invalid.push("axes.unknown");
  }
  if (raw.persona === undefined) defaulted.push("persona");
  else if (raw.persona === null) recovered.push("persona");
  else if (!isRecord(raw.persona)) invalid.push("persona");
  else {
    const firstInvalid = invalid.length;
    for (const key of ["age", "gender", "note", "user", "agent"] as const) {
      const name = `persona.${key}`;
      if (raw.persona[key] === undefined) { defaulted.push(name); continue; }
      try {
        config.persona[key] = readPersona({ [key]: raw.persona[key] }, t)[key];
        recovered.push(name);
      } catch { invalid.push(name); }
    }
    const address = raw.persona.address;
    if (address === undefined) defaulted.push("persona.address");
    else if (address === null) recovered.push("persona.address");
    else if (!isRecord(address)) invalid.push("persona.address");
    else {
      const refs = { self_ref: null as string | null, user_ref: null as string | null };
      for (const key of ["self_ref", "user_ref"] as const) {
        const name = `persona.address.${key}`;
        if (address[key] === undefined) { defaulted.push(name); continue; }
        try {
          refs[key] = asString(address[key], name, t);
          recovered.push(name);
        } catch { invalid.push(name); }
      }
      config.persona.address = refs.self_ref || refs.user_ref ? refs : null;
      if (Object.keys(address).some(key => key !== "self_ref" && key !== "user_ref")) invalid.push("persona.address.unknown");
      if (["self_ref", "user_ref"].every(key => address[key] !== undefined) &&
        !invalid.some(name => name.startsWith("persona.address."))) recovered.push("persona.address");
    }
    if (Object.keys(raw.persona).some(key => !["age", "gender", "note", "user", "agent", "address"].includes(key))) invalid.push("persona.unknown");
    if (invalid.length === firstInvalid) recovered.push("persona");
  }

  // Metadata is validated independently of damaged user fields. Old maps remain historical.
  if (complete === null) {
    if (schema === CONFIG_SCHEMA) {
      try { config.wiring = readWiringV2(raw.wiring, t); }
      catch { metadataLost = true; invalid.push("wiring"); }
    }
    try { config.managedSeeds = readManagedSeeds(raw.managedSeeds, t); }
    catch { metadataLost = true; invalid.push("managedSeeds"); }
    if (raw.seedVersion !== undefined) {
      if (typeof raw.seedVersion === "number" && Number.isSafeInteger(raw.seedVersion) && raw.seedVersion >= 0) {
        config.seedVersion = raw.seedVersion;
      } else { metadataLost = true; invalid.push("seedVersion"); }
    }
  }
  if (schema === LEGACY_CONFIG_SCHEMA) {
    try {
      legacy = {
        schema: LEGACY_CONFIG_SCHEMA,
        wiring: structuredClone(readLegacyWiring(raw.wiring, t)),
        managedSeeds: structuredClone(config.managedSeeds),
      };
    } catch {
      metadataLost = true;
      invalid.push("wiring");
    }
  }
  const known = ["schema", ...USER_SETTING_KEYS, "guards", "fixed_width", "wiring", "managedSeeds", "seedVersion"];
  if (Object.keys(raw).some(key => !known.includes(key))) invalid.push("unknown-fields");
  return {
    config,
    recovered: [...new Set(recovered)],
    invalid: [...new Set(invalid)],
    metadataLost,
    defaulted,
    legacy,
  };
}

export function loadConfig(path: string, t: Messages = catalogue("en").cli): Config {
  try {
    return parseConfig(readFileSync(path, "utf8"), t);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultConfig();
    // A permission or type error on the state file is the user's situation, not a defect, so
    // it gets a message rather than a stack trace out of an uncaught exception.
    if (code) throw new ConfigError(t.config.unreadable((cause as Error).message));
    throw cause;
  }
}

/**
 * Written to a neighbouring temp file and renamed. `writeFileSync` truncates first, so an
 * interrupted write left a zero-byte `config.json` that every command then refused to parse,
 * with hand-editing as the only recovery.
 */
export function writeAtomic(path: string, contents: string): void {
  // Resolved first, because `rename(2)` over a symlink replaces the **link**, not its target.
  // A global CLAUDE.md is commonly a link into a dotfiles repository, and writing "atomically"
  // to the link path silently breaks the link and leaves the repository copy diverging. The
  // temp file has to live beside the real path too, or the rename crosses a filesystem and
  // stops being atomic.
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  // The temp name carries the pid, because a fixed one lets two runs truncate each other's
  // staging file between the write and the rename.
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, contents);
    // `writeFileSync` creates a fresh inode at the process umask, and `rename` moves that inode
    // into place — so a file the user deliberately restricted came back world-readable. The
    // mode is copied across before the rename, never after, or there is a window where it is not.
    if (existsSync(target)) chmodSync(temp, statSync(target).mode & 0o7777);
    renameSync(temp, target);
  } finally {
    // A failure between the write and the rename used to leave staging litter in a directory
    // this tool does not own, which `eject` then never removed.
    rmSync(temp, { force: true });
  }
}

export const isAxis = (name: string): name is Axis =>
  (AXIS_ORDER as readonly string[]).includes(name);

/**
 * Everything `set <key>=<value>` takes that is not an axis.
 *
 * Shared by key discovery, setting reads, and the did-you-mean match in `set`.
 * Assignment retains its own validation.
 *
 * Command tests exercise this inventory through both setting and reading values.
 */
export const SETTING_KEYS = [
  "safeword", "speech_level", "language",
  "persona.age", "persona.gender", "persona.self_ref", "persona.user_ref", "persona.note",
  "persona.user", "persona.agent",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettableKey = Axis | SettingKey;

/** Current editable values, without presentation labels or internal ownership metadata. */
export function settingValues(config: Config) {
  return {
    ...Object.fromEntries(AXIS_ORDER.map(axis => [axis, config.axes[axis]])) as Axes,
    safeword: config.safeword,
    speech_level: config.speech_level,
    language: config.language,
    "persona.age": config.persona.age,
    "persona.gender": config.persona.gender,
    "persona.self_ref": config.persona.address?.self_ref ?? null,
    "persona.user_ref": config.persona.address?.user_ref ?? null,
    "persona.note": config.persona.note,
    "persona.user": config.persona.user,
    "persona.agent": config.persona.agent,
  };
}

/** Levenshtein-lite: enough to say "did you mean critique?" and no more. */
export function nearest<T extends string>(name: string, candidates: readonly T[]): T | null {
  const distance = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i]![j] = Math.min(
          d[i - 1]![j]! + 1,
          d[i]![j - 1]! + 1,
          d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return d[a.length]![b.length]!;
  };
  let best: T | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = distance(name.toLowerCase(), candidate);
    if (score < bestScore) [best, bestScore] = [candidate, score];
  }
  return bestScore <= Math.max(2, Math.floor(name.length / 2)) ? best : null;
}

export const nearestAxis = (name: string): Axis | null => nearest(name, AXIS_ORDER);
