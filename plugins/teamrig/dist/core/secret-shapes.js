import { createHash } from 'node:crypto';
import { SECRET_LITERAL_PATTERNS, SECRET_TEXT_PATTERNS, SECRET_TOKEN_PATTERNS } from "./secret-patterns.js";
import { configuredPatterns } from "./secrets.js";
/** `password: x` is ordinary prose in a prompt or a note, so the broad assignment shape stays out of the write-time set. */
const PROSE_SHAPES = new Set(['secret-assignment']);
/**
 * The write-time set (T1369 R11): the shapes a secret a session writes (a prompt, a command line, a file) is found by,
 * so every check that refuses one agrees: the tokens, the framed text shapes, an API key header and a quoted literal
 * given to a secret-like name. The broad `SecretScanner` set stays for register and inbox text.
 */
export const WRITE_TIME_SHAPES = [
    ...SECRET_TOKEN_PATTERNS,
    ...SECRET_TEXT_PATTERNS.filter(({ id }) => !PROSE_SHAPES.has(id)),
    ...SECRET_LITERAL_PATTERNS,
];
/** A framed value shorter than this is a word, not a secret (`https://u:p@host` in an example); security's tools skip them too. */
const MIN_FRAMED_SECRET = 6;
/**
 * A value that refers to a secret kept elsewhere: `${TOKEN}`, `$TOKEN`, `$(cat f)`, `<token>`, `%TOKEN%`, `{token}`,
 * `[token]`. A `%` must close the name, as a percent-encoded password (`%40bc...`) is a real one.
 */
const REFERENCE = /^(?:[<{[]|\$[{(A-Za-z_]|%[A-Za-z_]\w*%)/;
/** A value masked, redacted or cut short: `*****`, `ab***yz`, `ab12...`, `ab12…`, one character repeated (`xxxxxxxx`, `00000000`). */
const MASKED = /\*{3}|\.{3}|…|^(.)\1+$/;
/** A word that stands in for a secret: `password`, `changeme`, `your_token`, `put-key-here`. */
const PLACEHOLDER_WORD = /^(?:pass(?:word|wd)?|pwd|secret|token|user(?:name)?|changeme|example|sample|dummy|placeholder|redacted|your[\w-]*|[\w-]*[_-]here)$/i;
/** A search for a secret's shape: a regex class inside the value, as `postgres://[^:]+:[^@]+@` frames `]+:[^`. */
const REGEX_SOURCE = /\[\^|\][+*?{]/;
/** Code that splices a variable into a string, its quotes closing one string and opening the next: `'+process.env.API_KEY+'`. */
const SPLICE = /^\+[A-Za-z_$][\w$.]*\+$/;
/**
 * The SHA-256 of sample tokens every tutorial prints, held as hashes because the scrub refuses their shape: jwt.io's
 * HS256 samples, the classic one and the one with `"admin": true`.
 */
const SAMPLE_HASHES = new Set([
    '7f75367e7881255134e1375e723d1dea8ad5f6a4fdb79d938df1f1754a830606',
    'c794fa6d20c64efb9adf980ae93af472a1679775862d421ffe55d4a57fad5b3e',
]);
/**
 * True when a framing shape's `value` only stands in for a secret, or is the text of a search or of code around one. The
 * value alone is judged, never the host or the whole match (T1099 gap 1): a real password on `localhost` or a host
 * named `example` is still a credential.
 */
export function isPlaceholderValue(value) {
    return value.length < MIN_FRAMED_SECRET || standsInForSecret(value);
}
/** True when `value` refers to, masks or stands in for a secret, or is the text of a search or of code around one, whatever its length. */
function standsInForSecret(value) {
    return REFERENCE.test(value) || MASKED.test(value) || PLACEHOLDER_WORD.test(value) || REGEX_SOURCE.test(value) || SPLICE.test(value) || isSample(value);
}
/** True when the value a framing `shape` caught is not a secret: a placeholder, or a value the shape itself allows. */
export function isFramedPlaceholder(shape, value) {
    return isPlaceholderValue(value) || (shape.isAllowedValue?.(value) ?? false);
}
/** True when `value` is a published sample token rather than anyone's secret. */
function isSample(value) {
    return SAMPLE_HASHES.has(createHash('sha256').update(value, 'utf8').digest('hex'));
}
/** Finds the secrets a text holds by the write-time set plus a team's own patterns. */
export class SecretShapes {
    patterns;
    /** The shapes whose whole match is the secret, the tokens and the team's own, which a URL's login is judged by. */
    tokenShapes;
    /** `extra` are the team config's `secretPatterns` sources, matched case-insensitively. */
    constructor(extra = []) {
        const shapes = [...WRITE_TIME_SHAPES, ...configuredPatterns(extra)];
        this.patterns = shapes.map((shape) => ({ shape, global: new RegExp(shape.pattern.source, `${shape.pattern.flags}g`) }));
        this.tokenShapes = shapes.filter(({ secretGroup }) => secretGroup === undefined);
    }
    /**
     * Every secret in `text`, shape by shape in the order found. A placeholder in a framing shape is not one, nor is a
     * published sample token: a token shape's prefix already says it is a credential, so only the samples pass.
     */
    hitsIn(text) {
        const hits = [];
        for (const { shape, global } of this.patterns) {
            for (const match of text.matchAll(global)) {
                const value = shape.secretGroup === undefined ? match[0] : match[shape.secretGroup];
                if (value === undefined || value === '' || (shape.secretGroup === undefined ? isSample(value) : isFramedPlaceholder(shape, value)))
                    continue;
                const account = this.accountOf(match.groups, value);
                hits.push({ id: shape.id, description: shape.description, value, ...(account === undefined ? {} : { account }) });
            }
        }
        return hits;
    }
    /**
     * The account a framed `value` belongs to, from its shape's `login` and `host` groups; undefined for a shape without
     * them. A login is named only when it is no secret by the token shapes and the stand-in judge (security, T1545 B3), so
     * an account never carries a secret into a task. A short login is named: the length floor is for values.
     */
    accountOf(groups, value) {
        const login = groups?.['login'];
        const host = groups?.['host'];
        if (login === undefined || host === undefined)
            return undefined;
        const secretLike = login === value || standsInForSecret(login) || this.tokenShapes.some(({ pattern }) => pattern.test(login));
        const named = login === '' ? 'no login' : secretLike ? 'a login' : `login ${login}`;
        return `${named} at ${hostOf(host)}`;
    }
}
/** A dotted IPv4 address. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A URL's host as an account names it: its last two labels, lower-cased (`github.com`); an address or no name says so. */
function hostOf(host) {
    if (host.startsWith('[') || IPV4.test(host))
        return 'an IP address';
    const labels = host.toLowerCase().split('.').filter((label) => label !== '');
    return labels.length === 0 ? 'an unnamed host' : labels.slice(-2).join('.');
}
