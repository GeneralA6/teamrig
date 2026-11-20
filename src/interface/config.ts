import { isRecord } from '../core/guards.ts';
import { ServedText, type Cut, type SecretShapes } from './text.ts';

/** A setting's value as JSON holds one. */
export type ServedValue = string | number | boolean | null | readonly ServedValue[] | { readonly [key: string]: ServedValue };

/** What a row says in place of the value of a key that names where a secret is kept. */
export const KEPT_NOTE = 'this key names where a secret is kept, so its value is not served; teamrig config get shows it on the machine';

/** What a row says of a value the config check finds wrong; the check's own words may quote the value. */
export const SETTING_PROBLEM = 'the value fails the config check and the default is used; teamrig config validate says why';

/**
 * One key of the team config, as the `config` document serves it. Every field is always there, null when the key
 * has none, so a reader takes a row apart with no test for a missing field.
 */
export interface ServedSetting {
  /** Dotted path from the config's top, such as `messages.maxLines`. */
  readonly path: string;
  /** The top-level key it sits under. */
  readonly group: string;
  /** The schema's type: string, integer, number, boolean, array or object. */
  readonly type: string;
  /** For an array, the type of its items. */
  readonly items: string | null;
  readonly enum: readonly ServedValue[] | null;
  readonly min: number | null;
  readonly max: number | null;
  /** What the team's file holds, else the default; null when neither exists, and on a row with `kept`. */
  readonly value: ServedValue;
  readonly default: ServedValue;
  /** The value equals the default, written or not. */
  readonly isDefault: boolean;
  /** The schema's description. */
  readonly meaning: string;
  /** Whether `teamrig config set` may change it. */
  readonly editable: boolean;
  /** The owner gate a change of it falls under. */
  readonly gatedBy: string | null;
  /** Why a row that is not editable is not. */
  readonly readOnly: string | null;
  /** One fixed text when the config check finds the value wrong; the key is then read as its default. */
  readonly problem: string | null;
  /** One fixed text on a key that names where a secret is kept: its `value` is null whatever the file holds. */
  readonly kept: string | null;
}

/** The `config` document's own fields. */
export interface ConfigBody {
  /** The team read; null when the run has no team. */
  readonly team: string | null;
  /** With no team, the teams of this machine to join one of; empty otherwise. */
  readonly teams: readonly string[];
  /** The zone the team reads and types times in, as an IANA name. */
  readonly timeZone: string;
  /** The names of the team's priorities, the first the highest. */
  readonly priorities: readonly string[];
  readonly settings: readonly ServedSetting[];
  readonly cuts: readonly Cut[];
}

/**
 * A setting as it is handed in: a row of `settingRows` (src/config/settings.ts) with how its key is served. It is
 * declared here and not imported, since that file reaches a `node:` module and nothing in this folder may.
 */
export interface SettingInput {
  readonly path: string;
  readonly group: string;
  readonly type: string;
  readonly items?: string;
  readonly enum?: readonly unknown[];
  readonly min?: number;
  readonly max?: number;
  /** As the file holds it, already less every key the schema does not name. */
  readonly value?: unknown;
  readonly default?: unknown;
  readonly isDefault: boolean;
  readonly meaning: string;
  readonly editable: boolean;
  readonly gatedBy?: string;
  readonly readOnly?: string;
  /** The config check's own words; only that there are some is served. */
  readonly problem?: string;
  /** `location`: the key names where a secret is kept, and is served without its value. */
  readonly served: 'value' | 'location';
}

/** What the `config` document is built from. */
export interface ConfigInput {
  readonly team: string | null;
  readonly teams: readonly string[];
  readonly timeZone: string;
  readonly priorities: readonly string[];
  readonly settings: readonly SettingInput[];
  readonly shapes: SecretShapes;
}

/**
 * The `config` document's body. A value is the team's own words wherever it holds a text, so every string of it is
 * looked at for a secret's shape by itself: each element of a list, each text inside an object, and each key of a
 * map, whose entry is left out when the key itself is cut. The schema's own texts (`meaning`, `enum`, `readOnly`,
 * `gatedBy`) are teamrig's and are served as they are.
 */
export function configBody(input: ConfigInput): ConfigBody {
  const served = new ServedText(input.shapes);
  const settings = input.settings.map((row): ServedSetting => {
    const location = row.served === 'location';
    return {
      path: row.path,
      group: row.group,
      type: row.type,
      items: row.items ?? null,
      enum: row.enum === undefined ? null : row.enum.map((choice) => valueOf(choice, AS_WRITTEN)),
      min: row.min ?? null,
      max: row.max ?? null,
      value: location ? null : valueOf(row.value, scanOf(served, row.path, 'value')),
      default: valueOf(row.default, scanOf(served, row.path, 'default')),
      isDefault: row.isDefault,
      meaning: row.meaning,
      editable: row.editable,
      gatedBy: row.gatedBy ?? null,
      readOnly: row.readOnly ?? null,
      problem: row.problem === undefined ? null : SETTING_PROBLEM,
      kept: location ? KEPT_NOTE : null,
    };
  });
  return {
    team: input.team,
    teams: [...input.teams],
    timeZone: input.timeZone,
    priorities: input.priorities.map((name) => served.plain('register.priorities', 'name', name)),
    settings,
    cuts: served.cuts,
  };
}

/** How a value's texts and a map's keys pass on their way out. */
interface Scan {
  text(text: string): string;
  keeps(key: string): boolean;
}

const AS_WRITTEN: Scan = { text: (text) => text, keeps: () => true };

function scanOf(served: ServedText, path: string, field: string): Scan {
  return {
    text: (text) => served.plain(path, field, text),
    // Asking is what lists the cut, under the field `key`, so a reader learns an entry was left out and why.
    keeps: (key) => served.plain(path, 'key', key) === key,
  };
}

/** `value` as JSON holds it; what JSON cannot hold (an unset value, a number that is none) is null. */
function valueOf(value: unknown, scan: Scan): ServedValue {
  if (typeof value === 'string') {
    return scan.text(value);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((element: unknown) => valueOf(element, scan));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => scan.keeps(key))
        .map(([key, child]): [string, ServedValue] => [key, valueOf(child, scan)]),
    );
  }
  return null;
}
