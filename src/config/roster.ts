import { splitAddress, type SessionAddress } from '../core/address.ts';
import type { Rename } from '../names/rename.ts';
import type { KitConfig, RolesConfig } from './types.ts';

/** The roles a config can assign, by their key under `roles`. */
export const ROLES = ['lead', 'deliveryOwner', 'securityReviewer'] as const satisfies readonly (keyof RolesConfig)[];

export type Role = (typeof ROLES)[number];

/** The roles a child team may leave to a team above it, naming that team's holder as `<team>/<id>` (T1143); never the lead. */
export const ANCESTOR_ROLES = ['deliveryOwner', 'securityReviewer'] as const satisfies readonly Role[];

export type AncestorRole = (typeof ANCESTOR_ROLES)[number];

export function isRole(text: string): text is Role {
  return ROLES.some((role) => role === text);
}

/**
 * The session holding a role, if the team assigns it: a bare id is a session of `team` itself, and `<team>/<id>` one of
 * a team above it (T1143), as a child team with no reviewer or coordinator of its own names its parent's.
 */
export function roleHolderOf(roles: RolesConfig, role: Role, team: string): SessionAddress | undefined {
  const holder = roles[role];
  if (holder === undefined) {
    return undefined;
  }
  const address = splitAddress(holder);
  return { team: address?.team ?? team, id: address?.session ?? holder };
}

/**
 * A session found by id or name, or why none was. `pastId` is the id a former name belonged to
 * when that session is no longer on the team, so its old records stay reachable.
 */
export type SessionLookup =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly error: string; readonly pastId?: string };

/**
 * The team's sessions by id and by name. Ids are the stable keys of every file and record; names
 * are what people and Claude Code call a session, so a rename orphans nothing. An id the config
 * does not name is called `<team>-<id>`, so two teams on one machine never share a session name.
 * The rename log, applied in order over the config, gives each session its current name, and
 * every former name keeps finding the session that held it last.
 */
export class Roster {
  readonly ids: readonly string[];
  private readonly names: ReadonlyMap<string, string>;
  /** Every name the config or a rename mentions, to the session that held it last. */
  private readonly holders: ReadonlyMap<string, string>;
  private readonly roles: RolesConfig;

  constructor(config: Pick<KitConfig, 'sessions' | 'names' | 'roles'>, team: string, renames: readonly Rename[] = []) {
    const named = new Map(Object.entries(config.names));
    const names = new Map(config.sessions.map((id) => [id, named.get(id) ?? `${team}-${id}`]));
    const holders = new Map([...names].map(([id, name]) => [name, id]));
    for (const rename of renames) {
      holders.set(rename.from, rename.id);
      holders.set(rename.to, rename.id);
      if (names.has(rename.id)) {
        names.set(rename.id, rename.to);
      }
    }
    this.ids = config.sessions;
    this.names = names;
    this.holders = holders;
    this.roles = config.roles;
  }

  /** The name to message a session by; undefined for an id not on the team. */
  nameOf(id: string): string | undefined {
    return this.names.get(id);
  }

  /** The names a session had before its current one, in the order they first appeared. */
  formerNamesOf(id: string): string[] {
    return [...this.holders].filter(([name, holder]) => holder === id && name !== this.names.get(id)).map(([name]) => name);
  }

  /** The sessions whose current name is `name`: at most one, unless the config or rename log is damaged. */
  idsCalled(name: string): string[] {
    return this.ids.filter((id) => this.names.get(id) === name);
  }

  /** Every name ever used, with the session that held it last, on the team or not. */
  allNames(): ReadonlyMap<string, string> {
    return this.holders;
  }

  /** The session holding a role, if the team assigns it, as the config writes it: `<team>/<id>` for one of a team above (roleHolderOf). */
  holderOf(role: Role): string | undefined {
    return this.roles[role];
  }

  /** The roles a session holds. */
  rolesOf(id: string): Role[] {
    return ROLES.filter((role) => this.roles[role] === id);
  }

  /**
   * An id, a current name or a former name to the session's id; a current name wins over a former
   * one. An unknown name, a current name two sessions share, or a name of a session no longer on
   * the team is refused.
   */
  lookup(text: string): SessionLookup {
    if (this.ids.includes(text)) {
      return { ok: true, id: text };
    }
    const matches = this.idsCalled(text);
    const [id] = matches;
    if (matches.length === 1 && id !== undefined) {
      return { ok: true, id };
    }
    if (matches.length > 1) {
      return { ok: false, error: `${text} is the name of ${matches.length} sessions (${matches.join(', ')}); use the id` };
    }
    const holder = this.holders.get(text);
    if (holder === undefined) {
      return { ok: false, error: `${text} is not a session on this team (sessions: ${this.describe()})` };
    }
    if (this.ids.includes(holder)) {
      return { ok: true, id: holder };
    }
    return { ok: false, error: `${text} was the name of ${holder}, which is no longer on this team (sessions: ${this.describe()})`, pastId: holder };
  }

  /** Every session as `id (name)`. */
  describe(): string {
    return this.ids.map((id) => `${id} (${this.names.get(id) ?? id})`).join(', ');
  }
}
