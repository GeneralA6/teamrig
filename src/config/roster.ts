import type { KitConfig, RolesConfig } from './types.ts';

/** The roles a config can assign, by their key under `roles`. */
export const ROLES = ['lead', 'coordinatorOwner'] as const satisfies readonly (keyof RolesConfig)[];

export type Role = (typeof ROLES)[number];

export function isRole(text: string): text is Role {
  return ROLES.some((role) => role === text);
}

/** A session found by id or name, or why none was. */
export type SessionLookup = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };

/**
 * The team's sessions by id and by name. Ids are the stable keys of every file and record; names
 * are what people and Claude Code call a session, so a rename orphans nothing. An id the config
 * does not name is called `<team>-<id>`, so two teams on one machine never share a session name.
 */
export class Roster {
  readonly ids: readonly string[];
  private readonly names: ReadonlyMap<string, string>;
  private readonly roles: RolesConfig;

  constructor(config: Pick<KitConfig, 'sessions' | 'names' | 'roles'>, team: string) {
    const named = new Map(Object.entries(config.names));
    this.ids = config.sessions;
    this.names = new Map(config.sessions.map((id) => [id, named.get(id) ?? `${team}-${id}`]));
    this.roles = config.roles;
  }

  /** The name to message a session by; undefined for an id not on the team. */
  nameOf(id: string): string | undefined {
    return this.names.get(id);
  }

  /** The session holding a role, if the team assigns it. */
  holderOf(role: Role): string | undefined {
    return this.roles[role];
  }

  /** The roles a session holds. */
  rolesOf(id: string): Role[] {
    return ROLES.filter((role) => this.roles[role] === id);
  }

  /** An id, else a current name, to the session's id. An unknown name, or one two sessions share, is refused. */
  lookup(text: string): SessionLookup {
    if (this.ids.includes(text)) {
      return { ok: true, id: text };
    }
    const matches = this.ids.filter((id) => this.names.get(id) === text);
    const [id] = matches;
    if (matches.length === 1 && id !== undefined) {
      return { ok: true, id };
    }
    return {
      ok: false,
      error:
        matches.length === 0
          ? `${text} is not a session on this team (sessions: ${this.describe()})`
          : `${text} is the name of ${matches.length} sessions (${matches.join(', ')}); use the id`,
    };
  }

  /** Every session as `id (name)`. */
  describe(): string {
    return this.ids.map((id) => `${id} (${this.names.get(id) ?? id})`).join(', ');
  }
}
