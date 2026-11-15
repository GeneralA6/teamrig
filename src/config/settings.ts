import { isDeepStrictEqual } from 'node:util';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import type { ConfigIssue } from './reader.ts';

/**
 * One key of the team config as a settings screen shows it: what the schema says of it, the value this team's file
 * holds, and whether `teamrig config set` may change it.
 */
export interface SettingRow {
  /** Dotted path from the config's top, e.g. `messages.maxLines`. */
  readonly path: string;
  /** The top-level key it sits under, e.g. `messages`. */
  readonly group: string;
  /** The schema's type: string, integer, number, boolean, array or object. */
  readonly type: string;
  /** For an array, the type of its items. */
  readonly items?: string;
  readonly enum?: readonly unknown[];
  readonly min?: number;
  readonly max?: number;
  /** The value as this team's file holds it, else the default; absent when neither exists. */
  readonly value?: unknown;
  readonly default?: unknown;
  /** The value equals the default, written or not. */
  readonly isDefault: boolean;
  /** The schema's description. */
  readonly meaning: string;
  readonly editable: boolean;
  /** The owner gate a change of it falls under; the owner decides it, never a session. */
  readonly gatedBy?: string;
  /** Why a row that is not editable is not, in plain words. */
  readonly readOnly?: string;
  /** What `config validate` finds wrong in its value: the key is read as its default until it is fixed. */
  readonly problem?: string;
}

/**
 * Keys whose change is an owner gate (core rule 6): the budget and everything that grants, guards or takes away what a
 * session may do. A path matches its own entry or the nearest one above it.
 */
const GATED_KEYS: ReadonlyMap<string, string> = new Map([
  ['budget', 'budget'],
  ['focus.allocation', 'budget'],
  ['permissions', 'permissions'],
  ['pushGuard', 'permissions'],
  ['secretGuard', 'permissions'],
  ['packageGuard', 'permissions'],
  ['commitGuard', 'permissions'],
  ['pickerGuard', 'permissions'],
  ['exec', 'permissions'],
  ['readonlyShell', 'permissions'],
  ['leadBoundary', 'permissions'],
  ['ownerGates', 'permissions'],
]);

/** The roster: who is on the team and what each holds, which only its own commands change. */
const ROSTER_KEYS: ReadonlySet<string> = new Set(['team', 'sessions', 'names', 'leads', 'roles']);
const ROSTER_NOTE = 'the roster: changed only by teamrig hire, retire, rename, promote and demote';
const VERSION_NOTE = 'the config format: teamrig config migrate writes it';
const STRUCTURE_NOTE = 'a list of records or a map: edit it in config.json or with its own command';
const SKIPPED_KEYS: ReadonlySet<string> = new Set(['$schema']);

/** Every key the schema describes, in its order, read against the team's file (`raw`) and its problems. */
export function settingRows(schema: JsonRecord, raw: JsonRecord, issues: readonly ConfigIssue[]): readonly SettingRow[] {
  const definitions = isRecord(schema['$defs']) ? schema['$defs'] : {};
  const rows: SettingRow[] = [];
  const walk = (properties: JsonRecord, parent: string, group: string | undefined, values: JsonRecord): void => {
    for (const [key, child] of Object.entries(properties)) {
      const path = parent === '' ? key : `${parent}.${key}`;
      const node = resolve(child, definitions);
      if (node === undefined || SKIPPED_KEYS.has(path)) {
        continue;
      }
      const top = group ?? key;
      const nested = isRecord(node['properties']) ? node['properties'] : undefined;
      if (node['type'] === 'object' && nested !== undefined && Object.keys(nested).length > 0) {
        const below = values[key];
        walk(nested, path, top, isRecord(below) ? below : {});
        continue;
      }
      rows.push(rowOf(path, top, node, values[key], issues));
    }
  };
  if (isRecord(schema['properties'])) {
    walk(schema['properties'], '', undefined, raw);
  }
  return rows;
}

/** The rows at `path` or under it; empty when the schema has no such key. */
export function rowsUnder(rows: readonly SettingRow[], path: string): readonly SettingRow[] {
  return rows.filter((row) => row.path === path || row.path.startsWith(`${path}.`));
}

function rowOf(path: string, group: string, node: JsonRecord, written: unknown, issues: readonly ConfigIssue[]): SettingRow {
  const fallback = node['default'];
  const value = written === undefined ? fallback : written;
  const type = typeOf(node);
  const items = isRecord(node['items']) ? typeOf(node['items']) : undefined;
  const gatedBy = gateOf(path);
  const readOnly = gatedBy !== undefined ? `owner gate: ${gatedBy}` : readOnlyNote(path, group, type, items);
  const problem = issues.find((issue) => isAtOrUnder(issue.path, path));
  return {
    path,
    group,
    type,
    ...(items === undefined ? {} : { items }),
    ...(Array.isArray(node['enum']) ? { enum: node['enum'] } : {}),
    ...boundsOf(node),
    ...(value === undefined ? {} : { value }),
    ...(fallback === undefined ? {} : { default: fallback }),
    isDefault: written === undefined || isDeepStrictEqual(written, fallback),
    meaning: typeof node['description'] === 'string' ? node['description'] : '',
    editable: readOnly === undefined,
    ...(gatedBy === undefined ? {} : { gatedBy }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(problem === undefined ? {} : { problem: problem.message }),
  };
}

function readOnlyNote(path: string, group: string, type: string, items: string | undefined): string | undefined {
  if (ROSTER_KEYS.has(group)) {
    return ROSTER_NOTE;
  }
  if (path === 'configVersion') {
    return VERSION_NOTE;
  }
  if (type === 'object' || (type === 'array' && (items === 'object' || items === 'array'))) {
    return STRUCTURE_NOTE;
  }
  return undefined;
}

function gateOf(path: string): string | undefined {
  const parts = path.split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const gate = GATED_KEYS.get(parts.slice(0, length).join('.'));
    if (gate !== undefined) {
      return gate;
    }
  }
  return undefined;
}

/** A node, or the `$defs` entry its `$ref` names, its own description kept over the definition's. */
function resolve(node: unknown, definitions: JsonRecord): JsonRecord | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const ref = node['$ref'];
  if (typeof ref !== 'string') {
    return node;
  }
  const target = definitions[ref.replace(/^#\/\$defs\//, '')];
  return isRecord(target) ? { ...target, ...node } : node;
}

/** The schema's type, or the type its enum's values share when it names none. */
function typeOf(node: JsonRecord): string {
  const stated = node['type'];
  if (typeof stated === 'string') {
    return stated;
  }
  const choices = node['enum'];
  if (Array.isArray(choices) && choices.length > 0) {
    const kinds = new Set(choices.map((choice) => (Number.isInteger(choice) ? 'integer' : typeof choice)));
    return kinds.size === 1 ? [...kinds][0] ?? 'string' : 'string';
  }
  return 'object';
}

function boundsOf(node: JsonRecord): { readonly min?: number; readonly max?: number } {
  const min = node['minimum'];
  const max = node['maximum'];
  return { ...(typeof min === 'number' ? { min } : {}), ...(typeof max === 'number' ? { max } : {}) };
}

/** `register.priorities[2].name` is under `register.priorities`, `delivery.repos.api` under `delivery.repos`. */
function isAtOrUnder(issuePath: string, path: string): boolean {
  return issuePath === path || issuePath.startsWith(`${path}.`) || issuePath.startsWith(`${path}[`);
}
