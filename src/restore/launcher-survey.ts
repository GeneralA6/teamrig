import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';

/**
 * What starts the restore on this machine, as the launcher record (launcher-refresh.ts) keeps it for `teamrig check`
 * (src/cli/launcher-record-check.ts): each part teamrig set up, with the program and the script it starts, which the
 * check looks up to find one gone; and each part of teamrig's name that starts anything else and was left as it was
 * (one a refresh found while its launcher was missing, or one an uninstall kept).
 */

/** The part of the machine that starts the restore: the logon entry or a shortcut. */
export type LauncherPartKind = 'logon' | 'shortcut';

/** A part teamrig set up: it starts `script` under `program`. */
export interface RegisteredPart {
  readonly kind: LauncherPartKind;
  /** Where the part is: the logon entry's place, or the shortcut's path. */
  readonly where: string;
  readonly program: string;
  readonly script: string;
}

/** A part of teamrig's name that starts something else, as it was found. */
export interface FoundPart {
  readonly kind: LauncherPartKind;
  readonly where: string;
  /** What it starts, as a line of `restore install`. */
  readonly runs: string;
}

export interface LauncherSurvey {
  readonly registered: readonly RegisteredPart[];
  readonly found: readonly FoundPart[];
}

/** A machine where nothing starts the restore. */
export const EMPTY_SURVEY: LauncherSurvey = { registered: [], found: [] };

function kindOf(value: unknown): LauncherPartKind | undefined {
  return value === 'logon' || value === 'shortcut' ? value : undefined;
}

function registeredOf(value: unknown): RegisteredPart | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = kindOf(value['kind']);
  const [where, program, script] = (['where', 'program', 'script'] as const).map((key) => stringField(value, key));
  return kind === undefined || where === undefined || program === undefined || script === undefined ? undefined : { kind, where, program, script };
}

function foundOf(value: unknown): FoundPart | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = kindOf(value['kind']);
  const [where, runs] = (['where', 'runs'] as const).map((key) => stringField(value, key));
  return kind === undefined || where === undefined || runs === undefined ? undefined : { kind, where, runs };
}

/** Each item of `value` as `parse` reads it; undefined when it is no list or any item is damaged. */
function listOf<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(parse).filter((item): item is T => item !== undefined);
  return items.length === value.length ? items : undefined;
}

/** The survey a record holds; undefined when it holds none, or a damaged one. */
export function surveyOf(record: JsonRecord): LauncherSurvey | undefined {
  const registered = listOf(record['registered'], registeredOf);
  const found = listOf(record['found'], foundOf);
  return registered === undefined || found === undefined ? undefined : { registered, found };
}

/** The survey as the record's fields hold it. */
export function surveyFields(survey: LauncherSurvey): { readonly registered: readonly RegisteredPart[]; readonly found: readonly FoundPart[] } {
  return {
    registered: survey.registered.map(({ kind, where, program, script }) => ({ kind, where, program, script })),
    found: survey.found.map(({ kind, where, runs }) => ({ kind, where, runs })),
  };
}

/** Whether two surveys list the same parts in the same order. */
export function sameSurvey(a: LauncherSurvey, b: LauncherSurvey): boolean {
  return JSON.stringify(surveyFields(a)) === JSON.stringify(surveyFields(b));
}
