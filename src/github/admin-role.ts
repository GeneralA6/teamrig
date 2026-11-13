import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord, stringField } from '../core/guards.ts';

/**
 * The GitHub admin role (T2705): the one session of a team the owner lets manage every issue, pull request and
 * branch of the team's repositories; every other session acts only on its own. The owner sets it from their own
 * terminal or the pane, and the role file it writes is signed with an HMAC-SHA256 key kept in the operating
 * system's credential store, never in the file. Why signed: every session runs as the owner's OS user, so a guard
 * on the file alone leaves a script it cannot read free to rewrite it; without the key, a rewritten file cannot
 * carry a signature that matches, and it reads as no admin. Each set makes a fresh key, so an older signed file
 * stops matching too. This module is the document alone: no file, no store.
 */

/** The role as the owner set it. */
export interface AdminRole {
  readonly team: string;
  readonly session: string;
  /** When the owner set it, an ISO time. */
  readonly setAt: string;
}

/** What a role file reads as: an admin, no file at all, or a file that does not hold a role the key signed. */
export type AdminRoleRead =
  | { readonly kind: 'admin'; readonly role: AdminRole }
  | { readonly kind: 'none' }
  | { readonly kind: 'broken'; readonly reason: string };

/** The bytes of a fresh key, as SHA-256 wants for its block. */
export const ADMIN_KEY_BYTES = 32;

/** The signed text's first line: a later format changes it, so a file of another format never verifies. */
const SIGNED_HEADER = 'teamrig github-admin v1';

/** A key as the store holds it: base64url text, which is printable ASCII with no spaces. */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** A signature as the file holds it: SHA-256 as lowercase hex. */
const SIGNATURE_TEXT = /^[0-9a-f]{64}$/;

/** A fresh random key, as base64url text. */
export function newAdminKey(random: (bytes: number) => Buffer = randomBytes): string {
  return random(ADMIN_KEY_BYTES).toString('base64url');
}

/** True when `text` is a key `newAdminKey` could have made. */
export function isAdminKey(text: string): boolean {
  return KEY_TEXT.test(text);
}

/** The text the signature covers: each field on its own line, so no field can borrow another's characters. */
function signedText(role: AdminRole): string {
  return [SIGNED_HEADER, role.team, role.session, role.setAt].join('\n');
}

function signatureOf(role: AdminRole, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(signedText(role), 'utf8').digest('hex');
}

/** The role file's text: the role and its signature by `key`, as JSON with a trailing newline. */
export function signAdminRole(role: AdminRole, key: string): string {
  if (!isAdminKey(key)) {
    throw new Error('the GitHub admin key is not a key teamrig made');
  }
  for (const [field, value] of Object.entries(role)) {
    if (value === '' || value.includes('\n')) {
      throw new Error(`the GitHub admin role's ${field} must be one line of text`);
    }
  }
  return `${JSON.stringify({ team: role.team, session: role.session, setAt: role.setAt, signature: signatureOf(role, key) }, null, 2)}\n`;
}

/**
 * What the role file `text` holds for `team` under `key`: the admin only when the file is the one the owner's set
 * wrote with that key for that team. Any other file is broken, with the reason, and every caller treats broken as
 * no admin: an edit can turn the role off but never hand it to a session.
 */
export function verifyAdminRole(text: string, key: string, team: string): AdminRoleRead {
  if (!isAdminKey(key)) {
    return { kind: 'broken', reason: 'the saved GitHub admin key is not one teamrig made' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'broken', reason: 'the GitHub admin role file is not JSON' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'broken', reason: 'the GitHub admin role file is not a JSON object' };
  }
  const fileTeam = stringField(parsed, 'team');
  const session = stringField(parsed, 'session');
  const setAt = stringField(parsed, 'setAt');
  const signature = stringField(parsed, 'signature');
  if (fileTeam === undefined || session === undefined || setAt === undefined || signature === undefined) {
    return { kind: 'broken', reason: 'the GitHub admin role file lacks its team, session, setAt or signature' };
  }
  if (!SIGNATURE_TEXT.test(signature)) {
    return { kind: 'broken', reason: 'the GitHub admin role file has no signature teamrig wrote' };
  }
  const role: AdminRole = { team: fileTeam, session, setAt };
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signatureOf(role, key), 'hex'))) {
    return { kind: 'broken', reason: 'the GitHub admin role file does not match its signature: it was changed after the owner set it' };
  }
  if (fileTeam !== team) {
    return { kind: 'broken', reason: `the GitHub admin role file was set for team ${fileTeam}, not ${team}` };
  }
  return { kind: 'admin', role };
}
