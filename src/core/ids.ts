/**
 * Team, session and area ids: a lowercase letter, then lowercase letters, digits or dashes, at most
 * 32 characters. Each one names a folder or file, so it is safe in a path on every OS, and being
 * lowercase-only two ids can never differ by case alone on a case-insensitive filesystem.
 */
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Why a value is not an id, worded for a person fixing a config or a command line. */
export const ID_RULE = 'a lowercase letter, then lowercase letters, digits or -, at most 32 characters';

/**
 * A session's display and Claude Code session name: an id's characters, long enough for the default
 * name `<team>-<id>` (32 + 1 + 32), so a name is as safe on a command line as an id.
 */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,64}$/;

/** Why a value is not a session name. */
export const NAME_RULE = 'a lowercase letter, then lowercase letters, digits or -, at most 65 characters';

/**
 * A Claude Code tab title as a session id or name. Ids and names are lowercase, so a title that is a
 * valid name but for its case reads as that name (`Shop-Web` is `shop-web`); any other title stays
 * as typed, so a refusal quotes it as the person wrote it.
 */
export function titleKey(title: string): string {
  const lower = title.toLowerCase();
  return NAME_PATTERN.test(lower) ? lower : title;
}
