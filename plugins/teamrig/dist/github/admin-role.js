import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord, stringField } from "../core/guards.js";
/** The bytes of a fresh key, as SHA-256 wants for its block. */
export const ADMIN_KEY_BYTES = 32;
/** The signed text's first line: a later format changes it, so a file of another format never verifies. */
const SIGNED_HEADER = 'teamrig github-admin v1';
/** A key as the store holds it: base64url text, which is printable ASCII with no spaces. */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** A signature as the file holds it: SHA-256 as lowercase hex. */
const SIGNATURE_TEXT = /^[0-9a-f]{64}$/;
/** A fresh random key, as base64url text. */
export function newAdminKey(random = randomBytes) {
    return random(ADMIN_KEY_BYTES).toString('base64url');
}
/** True when `text` is a key `newAdminKey` could have made. */
export function isAdminKey(text) {
    return KEY_TEXT.test(text);
}
/** The text the signature covers: each field on its own line, so no field can borrow another's characters. */
function signedText(role) {
    return [SIGNED_HEADER, role.team, role.session, role.setAt].join('\n');
}
function signatureOf(role, key) {
    return createHmac('sha256', Buffer.from(key, 'base64url')).update(signedText(role), 'utf8').digest('hex');
}
/** The role file's text: the role and its signature by `key`, as JSON with a trailing newline. */
export function signAdminRole(role, key) {
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
export function verifyAdminRole(text, key, team) {
    if (!isAdminKey(key)) {
        return { kind: 'broken', reason: 'the saved GitHub admin key is not one teamrig made' };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
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
    const role = { team: fileTeam, session, setAt };
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signatureOf(role, key), 'hex'))) {
        return { kind: 'broken', reason: 'the GitHub admin role file does not match its signature: it was changed after the owner set it' };
    }
    if (fileTeam !== team) {
        return { kind: 'broken', reason: `the GitHub admin role file was set for team ${fileTeam}, not ${team}` };
    }
    return { kind: 'admin', role };
}
