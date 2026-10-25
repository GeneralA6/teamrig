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
 * Names Claude Code keeps for itself (2.1.310): its SendMessage refuses an agent name of `main`, `team-lead` (its
 * agent-teams leader), `user` or `system` and routes a message to one of them to its own mailbox, so a session by such
 * a name never receives a message. Claude Code folds a name first (NFKC, lowercase, spaces to dashes), which leaves a
 * {@link NAME_PATTERN} name as it is, so comparing the name itself covers every spelling.
 */
export const RESERVED_NAMES: readonly string[] = ['main', 'team-lead', 'user', 'system'];

/** Why a reserved name cannot be a session's, after the name. */
export const RESERVED_RULE = 'is a name Claude Code keeps for itself, so a message sent to it never reaches a session';

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.includes(name);
}

/**
 * A Claude Code tab title as a session id or name. Ids and names are lowercase, so a title that is a
 * valid name but for its case reads as that name (`Shop-Web` is `shop-web`); any other title stays
 * as typed, so a refusal quotes it as the person wrote it.
 */
export function titleKey(title: string): string {
  const lower = title.toLowerCase();
  return NAME_PATTERN.test(lower) ? lower : title;
}

/**
 * A session's name without its team's prefix: the default name `<team>-<id>` reads as the id beside the team it
 * already names (`app-lead` of team app is `lead`); a name that is only the prefix, or another team's, stays.
 */
export function bareName(team: string, name: string): string {
  const prefix = `${team}-`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

/**
 * How a session reads where people see it (a tab's title, the pane's header): its team once, in brackets, before
 * its bare name, `[app] lead`. Only for text written for people: the Claude Code session name stays the
 * session's name, the address SendMessage takes, which a space or a bracket would break.
 */
export function sessionDisplay(team: string, name: string): string {
  return `[${team}] ${bareName(team, name)}`;
}

/** A title's team and name: `team` is undefined for a title that names no team. */
export interface TitleParts {
  readonly team: string | undefined;
  readonly name: string;
}

/** `[<team>] <name>`, the {@link sessionDisplay} form. */
const DISPLAY_PATTERN = /^\[([^\]]*)\]\s+(\S.*)$/;

/**
 * A title in the {@link sessionDisplay} form, whatever the team's case, as its team and name; any other title,
 * one whose brackets hold no team id among them, is a bare name, kept whole.
 */
export function titleParts(title: string): TitleParts {
  const match = DISPLAY_PATTERN.exec(title.trim());
  const team = match?.[1]?.trim().toLowerCase();
  const name = match?.[2]?.trim();
  return team !== undefined && name !== undefined && ID_PATTERN.test(team) ? { team, name } : { team: undefined, name: title };
}
