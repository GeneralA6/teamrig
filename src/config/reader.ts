import { isRecord, type JsonRecord } from '../core/guards.ts';

export interface ConfigIssue {
  /** Where the problem is, e.g. `register.priorities[2].name`. */
  readonly path: string;
  readonly message: string;
}

/** Checks one value; returns why it is invalid, or undefined when it is fine. */
export type Check<T> = (value: T) => string | undefined;

export interface NumberBounds {
  readonly min?: number;
  readonly max?: number;
}

/**
 * Reads typed fields out of untrusted JSON. A missing field takes its default; a field of the
 * wrong type or failing its check is recorded as an issue and also takes its default, so one
 * pass reports every problem at once.
 */
export class ConfigReader {
  readonly issues: ConfigIssue[] = [];

  /** A nested object; a missing one reads as empty so its fields take their defaults. */
  section(parent: JsonRecord, key: string, path: string): JsonRecord {
    const value = parent[key];
    if (value === undefined) {
      return {};
    }
    if (isRecord(value)) {
      return value;
    }
    this.problem(join(path, key), 'an object', value);
    return {};
  }

  string(parent: JsonRecord, key: string, path: string, fallback: string, check?: Check<string>): string {
    return this.optionalString(parent, key, path, check) ?? fallback;
  }

  optionalString(parent: JsonRecord, key: string, path: string, check?: Check<string>): string | undefined {
    const value = parent[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.problem(join(path, key), 'a non-empty string', value);
      return undefined;
    }
    return this.checked(join(path, key), value, check);
  }

  /** A string the team must supply; there is no default. */
  requiredString(parent: JsonRecord, key: string, path: string, check?: Check<string>): string {
    if (parent[key] === undefined) {
      this.issues.push({ path: join(path, key), message: 'is required' });
      return '';
    }
    return this.optionalString(parent, key, path, check) ?? '';
  }

  integer(parent: JsonRecord, key: string, path: string, fallback: number, bounds: NumberBounds = {}): number {
    return this.numeric(parent, key, path, bounds, true) ?? fallback;
  }

  number(parent: JsonRecord, key: string, path: string, fallback: number, bounds: NumberBounds = {}): number {
    return this.numeric(parent, key, path, bounds, false) ?? fallback;
  }

  /** A whole number the config may leave out; an invalid one is an issue and reads as unset. */
  optionalInteger(parent: JsonRecord, key: string, path: string, bounds: NumberBounds = {}): number | undefined {
    return this.numeric(parent, key, path, bounds, true);
  }

  /** A number the config may leave out; an invalid one is an issue and reads as unset. */
  optionalNumber(parent: JsonRecord, key: string, path: string, bounds: NumberBounds = {}): number | undefined {
    return this.numeric(parent, key, path, bounds, false);
  }

  /** One number list item within `bounds`, for use inside `list` callbacks. */
  numberItem(value: unknown, itemPath: string, bounds: NumberBounds = {}): number | undefined {
    return this.checkedNumber(value, itemPath, bounds, false);
  }

  /** One whole-number item within `bounds`, for use inside list or map callbacks. */
  integerItem(value: unknown, itemPath: string, bounds: NumberBounds = {}): number | undefined {
    return this.checkedNumber(value, itemPath, bounds, true);
  }

  boolean(parent: JsonRecord, key: string, path: string, fallback: boolean): boolean {
    const value = parent[key];
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'boolean') {
      this.problem(join(path, key), 'true or false', value);
      return fallback;
    }
    return value;
  }

  /**
   * A list whose items are read by `item`; an item that returns undefined is dropped (it recorded
   * its issue). A list longer than `maxItems` is an issue and takes the default.
   */
  list<T>(
    parent: JsonRecord,
    key: string,
    path: string,
    fallback: readonly T[],
    item: (value: unknown, itemPath: string) => T | undefined,
    maxItems = Number.POSITIVE_INFINITY,
  ): readonly T[] {
    const value = parent[key];
    if (value === undefined) {
      return fallback;
    }
    if (!Array.isArray(value)) {
      this.problem(join(path, key), 'a list', value);
      return fallback;
    }
    if (value.length > maxItems) {
      this.problem(join(path, key), `a list of at most ${maxItems} items`, value);
      return fallback;
    }
    const items: T[] = [];
    value.forEach((entry: unknown, index) => {
      const read = item(entry, `${join(path, key)}[${index}]`);
      if (read !== undefined) {
        items.push(read);
      }
    });
    return items;
  }

  stringList(
    parent: JsonRecord,
    key: string,
    path: string,
    fallback: readonly string[],
    check?: Check<string>,
    maxItems?: number,
  ): readonly string[] {
    return this.list(parent, key, path, fallback, (value, itemPath) => this.stringItem(value, itemPath, check), maxItems);
  }

  /** One string list item, for use inside `list` callbacks. */
  stringItem(value: unknown, itemPath: string, check?: Check<string>): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      this.problem(itemPath, 'a non-empty string', value);
      return undefined;
    }
    return this.checked(itemPath, value, check);
  }

  /** One list of strings, such as a program and its arguments, for use inside `list` callbacks; an empty list is an issue. */
  stringListItem(value: unknown, itemPath: string, maxItems: number): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
      this.problem(itemPath, `a list of 1 to ${maxItems} strings`, value);
      return undefined;
    }
    const items = value.map((entry: unknown, index) => this.stringItem(entry, `${itemPath}[${index}]`));
    const strings = items.filter((item): item is string => item !== undefined);
    return strings.length === items.length ? strings : undefined;
  }

  /** One object list item, for use inside `list` callbacks. */
  objectItem(value: unknown, itemPath: string): JsonRecord | undefined {
    if (!isRecord(value)) {
      this.problem(itemPath, 'an object', value);
      return undefined;
    }
    return value;
  }

  /** Records a rule that spans several fields, such as "the lead must be one of the sessions". */
  report(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  /** A key this config format no longer reads: flagged, so a hand-written one is not silently ignored. */
  dropped(parent: JsonRecord, key: string, path: string, why: string): void {
    if (parent[key] !== undefined) {
      this.report(join(path, key), `is no longer read: ${why}; delete it`);
    }
  }

  /** The value, or undefined when it is missing or invalid (an invalid one is recorded as an issue). */
  private numeric(parent: JsonRecord, key: string, path: string, bounds: NumberBounds, integer: boolean): number | undefined {
    const value = parent[key];
    return value === undefined ? undefined : this.checkedNumber(value, join(path, key), bounds, integer);
  }

  private checkedNumber(value: unknown, path: string, bounds: NumberBounds, integer: boolean): number | undefined {
    const expected = `${integer ? 'an integer' : 'a number'}${describeBounds(bounds)}`;
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      this.problem(path, expected, value);
      return undefined;
    }
    if ((bounds.min !== undefined && value < bounds.min) || (bounds.max !== undefined && value > bounds.max)) {
      this.problem(path, expected, value);
      return undefined;
    }
    return value;
  }

  private checked(path: string, value: string, check: Check<string> | undefined): string | undefined {
    const problem = check?.(value);
    if (problem !== undefined) {
      this.issues.push({ path, message: `${problem} (got ${describe(value)})` });
      return undefined;
    }
    return value;
  }

  private problem(path: string, expected: string, value: unknown): void {
    this.issues.push({ path, message: `expected ${expected}, got ${describe(value)}` });
  }
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function describeBounds(bounds: NumberBounds): string {
  if (bounds.min !== undefined && bounds.max !== undefined) {
    return ` from ${bounds.min} to ${bounds.max}`;
  }
  if (bounds.min !== undefined) {
    return ` of at least ${bounds.min}`;
  }
  return bounds.max === undefined ? '' : ` of at most ${bounds.max}`;
}

/** A short, safe rendering of a bad value for an error message. */
export function describe(value: unknown): string {
  const text = value === undefined ? 'nothing' : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function formatIssue(issue: ConfigIssue): string {
  return `${issue.path}: ${issue.message}`;
}

/** One line of at most `maxLength` characters that also passes `check`; for text printed into the rules. */
export function shortLine(maxLength: number, check?: Check<string>): Check<string> {
  return (value) => {
    if (/[\r\n]/.test(value)) {
      return 'expected a single line';
    }
    return value.length > maxLength ? `expected at most ${maxLength} characters` : check?.(value);
  };
}

/** Validates a regular expression source; used for team-supplied patterns. */
export const isValidRegex: Check<string> = (source) => {
  try {
    new RegExp(source, 'u');
    return undefined;
  } catch (error) {
    return `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
};
