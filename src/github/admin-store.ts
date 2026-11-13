import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { KIT_NAME } from '../core/home.ts';
import { newAdminKey, signAdminRole, verifyAdminRole, type AdminRoleRead } from './admin-role.ts';
import type { CredentialSave, CredentialStore } from './credentials.ts';

/**
 * Where a team's GitHub admin role lives (T2705): the signed role file in the team's home, and its key in the
 * operating system's credential store under a name of the team's own. Only the owner's `owner github-admin` command
 * writes either; every check reads both through `readAdminRole`.
 */

/** The team's role store: its files, the credential store and which team. */
export interface AdminRoleStore {
  readonly files: Files;
  readonly credentials: CredentialStore;
  /** `<kit home>/teams/<team>`. */
  readonly teamHome: string;
  readonly team: string;
}

/** The role file's name in the team's home. */
export const ADMIN_ROLE_FILE = 'github-admin.json';

/** The role file of the team whose home is `teamHome`. */
export function adminRolePath(teamHome: string): string {
  return join(teamHome, ADMIN_ROLE_FILE);
}

/** The credential the team's key is saved under: a team name is lowercase letters, digits, `.`, `_` or `-`. */
export function adminKeyName(team: string): string {
  return `${KIT_NAME}-github-admin-${team}`;
}

/**
 * The team's admin, or none when no role file exists, or broken with the reason: a key that is gone or cannot be
 * read, or a file the key did not sign. Every caller treats broken as no admin.
 */
export async function readAdminRole(store: AdminRoleStore): Promise<AdminRoleRead> {
  const text = await store.files.read(adminRolePath(store.teamHome));
  if (text === undefined) {
    return { kind: 'none' };
  }
  const name = adminKeyName(store.team);
  const key = await store.credentials.read(name);
  switch (key.kind) {
    case 'missing':
      return { kind: 'broken', reason: `the GitHub admin key ${name} is not in ${store.credentials.label}: the owner sets the role again` };
    case 'failed':
      return { kind: 'broken', reason: `the GitHub admin key ${name} could not be read: ${key.reason}` };
    case 'found':
      return verifyAdminRole(text, key.secret, store.team);
  }
}

/**
 * Makes `session` the team's admin as of `setAt`: saves a fresh key, then writes the file signed by it. The fresh
 * key is what makes every earlier file stop matching. A failed save writes no file, so the role stays as it was; a
 * file that fails to write after the save leaves the old file under the new key, which reads as broken: no admin.
 */
export async function setAdminRole(
  store: AdminRoleStore,
  session: string,
  setAt: string,
  random?: (bytes: number) => Buffer,
): Promise<CredentialSave> {
  const key = newAdminKey(random);
  const saved = await store.credentials.save(adminKeyName(store.team), key);
  if (saved.kind === 'failed') {
    return saved;
  }
  await store.files.write(adminRolePath(store.teamHome), signAdminRole({ team: store.team, session, setAt }, key));
  return saved;
}

/** Removes the team's role file, so no session is admin; true when there was one. The key stays, signing nothing. */
export async function clearAdminRole(store: AdminRoleStore): Promise<boolean> {
  return store.files.remove(adminRolePath(store.teamHome));
}

/** The session that is the team's admin, or undefined when none is or the role reads broken. */
export function adminSessionOf(read: AdminRoleRead): string | undefined {
  return read.kind === 'admin' ? read.role.session : undefined;
}
