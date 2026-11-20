import type { JsonRecord } from './guards.ts';

/**
 * The field a stored record names its host session by: the session of the host a team session's tab runs in, a
 * Claude Code session id today. Records written before the rename name it `claudeSession`, and three stores `claude`.
 * Every reader takes both names, so a store's writer moves to this one only a release after its readers did: a tab
 * keeps the teamrig it loaded until it reloads, and old and new code share the stores meanwhile.
 */
export const HOST_SESSION_FIELD = 'hostSession';

/** The field a store's records named the host session by before `HOST_SESSION_FIELD`. */
export type LegacyHostSessionField = 'claudeSession' | 'claude';

/**
 * The record's host session as stored, unchecked: `HOST_SESSION_FIELD` when the record has it, null included, else
 * the store's old field. A reader that keeps a null or checks the id's shape starts here.
 */
export function hostSessionValue(record: JsonRecord, legacy: LegacyHostSessionField): unknown {
  return Object.hasOwn(record, HOST_SESSION_FIELD) ? record[HOST_SESSION_FIELD] : record[legacy];
}

/** The record's host session; undefined when it names none, or names it by anything but text. */
export function hostSessionOf(record: JsonRecord, legacy: LegacyHostSessionField): string | undefined {
  const value = hostSessionValue(record, legacy);
  return typeof value === 'string' ? value : undefined;
}
