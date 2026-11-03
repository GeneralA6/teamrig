/**
 * The shapes of secret teamrig refuses to write into a shared file (inbox lines, task titles, refs, notes and
 * evidence; see `SecretScanner`) and the scrub refuses in the repository (see `tools/scrub/rules.ts`).
 * This module is the one place they are defined, so both checks always agree.
 */
/**
 * Credential formats with a fixed prefix or frame, matched case-sensitively as the issuers print them.
 * Two guard against prose: the `sk-` and Slack shapes require a digit, as a random key always has one
 * and a long hyphenated word (`sk-learn-compatible-...`) does not.
 */
export const SECRET_TOKEN_PATTERNS = [
    { id: 'private-key', description: 'private key block', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
    { id: 'github-token', description: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
    { id: 'anthropic-key', description: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
    { id: 'sk-key', description: 'API key with an sk- prefix', pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/ },
    { id: 'aws-key', description: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { id: 'slack-token', description: 'Slack token', pattern: /\bxox[abeoprs]-(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{10,}/ },
    { id: 'google-key', description: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
    { id: 'stripe-key', description: 'Stripe live key', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}/ },
    { id: 'jwt', description: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];
/**
 * Secrets written as text rather than as a token: credentials inside a URL or an Authorization header and
 * `password=`-style assignments. Shared-file writes and redaction use them all; the write-time set and the scrub leave
 * out the broad `secret-assignment` for the stricter `ASSIGNED_SECRET`, as documentation shows placeholders such as
 * `password: ${VAULT}`.
 * An assignment's key word may end a longer name, as env vars and code write it (`DB_PASSWORD`, `clientSecret`):
 * no word boundary comes before it, since an underscore is a word character. A quoted key, as JSON and YAML write
 * it (`"password": `), counts too.
 * An assignment's key never ends a name with a `/` in it (a branch such as `feat/jwt-previous-secret`, a path):
 * a note naming one ahead of a colon names it, it does not assign it. A dotted key (`jwt.secret`), a header
 * (`X-Api-Key`) and a URL's query still count. That check follows the key word, so it runs only where one matched,
 * not at every place in a long run of word characters.
 * An Authorization header's credential is opaque, so its scheme word frames it: a placeholder in its place
 * (`$TOKEN`, `${TOKEN}`, `<token>`, `%TOKEN%`) or a word under 8 characters is not one.
 * A URL's password is the secret, except GitHub's fixed `x-oauth-basic`: there the login is the token.
 */
export const SECRET_TEXT_PATTERNS = [
    {
        id: 'url-credentials',
        description: 'credentials in a URL',
        pattern: /\b[a-z][a-z0-9+.-]*:\/\/(?<login>[^\s/:@]*):([^\s/@]+)@(?=(?<host>\[[0-9a-f:.]*\]|[a-z0-9._-]*))/i,
        secretGroup: 2,
        isAllowedValue: isOauthBasicWord,
    },
    {
        id: 'url-login-token',
        description: 'credentials in a URL',
        pattern: /\b[a-z][a-z0-9+.-]*:\/\/(?<login>[^\s/:@]+):x-oauth-basic@(?=(?<host>\[[0-9a-f:.]*\]|[a-z0-9._-]*))/i,
        secretGroup: 1,
    },
    {
        id: 'auth-header',
        description: 'credentials in an Authorization header',
        pattern: /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+((?![$<{%])[^\s"']{8,})/i,
        secretGroup: 1,
    },
    { id: 'secret-assignment', description: 'password or key assignment', pattern: /(?:password|passwd|secret|api[_-]?key)(?<!\/[\w.-]*)["']?\s*[=:]\s*\S/i },
];
/** True for GitHub's fixed password `x-oauth-basic`, which follows a token given as a URL's login: a word, not a secret. */
function isOauthBasicWord(value) {
    return value.toLowerCase() === 'x-oauth-basic';
}
/**
 * An identifier's name rather than a secret: two or more parts joined by `_`, `-` or `.`, each all lower-case or all
 * upper-case letters with optional trailing digits, or digits alone (`SOME_READ_TOKEN`, `app-api-secrets`, `v2.prod`).
 * A single word, a mixed-case part or a part with a digit inside (`3f9a8b7c-...`) still reads as a secret. Its own
 * case-sensitive pattern, as `ASSIGNED_SECRET`'s `i` flag would let a mixed-case part pass.
 */
const IDENTIFIER_NAME = /^(?:[a-z]+\d*|[A-Z]+\d*|\d+)(?:[._-](?:[a-z]+\d*|[A-Z]+\d*|\d+))+$/;
/** True when `value` is an identifier's name (`SOME_READ_TOKEN`), which names a secret rather than holds it. */
export function isIdentifierName(value) {
    return IDENTIFIER_NAME.test(value);
}
/**
 * A coordination id: a uuid, alone or after its holder's id and `#` or `:` (`worker-7#<uuid>`, a host name and a
 * `randomUUID()`), as a claim, lock, lease or fencing token holds one.
 */
const COORDINATION_ID = /^(?:[\w.-]+[#:])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * True when `value` is a coordination id given to a claim, lock, lease or fencing token (T1695): it marks who holds a
 * claim, grants nothing and ends with the claim. Any other token name, or such a token holding anything but that id,
 * is still a secret.
 */
function isCoordinationId(value, match) {
    return match.groups?.['coordination'] !== undefined && COORDINATION_ID.test(value);
}
/**
 * A quoted literal of 12 or more characters given to a secret-like name: the scrub's rule in the repository and part of
 * the write-time set. Stricter than `secret-assignment`, so documentation and prose pass. The key word may end a longer
 * name (`DB_PASSWORD`, `clientSecret`, `GITHUB_TOKEN`): no word boundary comes before it, since an underscore is a word
 * character. A value that is a name (`TOKEN="SOME_READ_TOKEN"`, `secret: "app-api-secrets"`) names the secret, it does
 * not hold it. A name that starts with claim, lock, lease or fencing and ends in token (`claimToken`, `LOCK_TOKEN`) is
 * the `coordination` group, and a coordination id there is no secret; one only ending in them (`unlockToken`) is not.
 */
export const ASSIGNED_SECRET = {
    id: 'assigned-secret',
    description: 'literal value assigned to a secret-like name',
    pattern: /(?:(?<coordination>(?<![\w$])(?:claim|lock|lease|fencing)[_-]?token)|password|passwd|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    secretGroup: 2,
    isAllowedValue: (value, match) => isIdentifierName(value) || isCoordinationId(value, match),
};
/**
 * Literal secrets the write-time set (`secret-shapes.ts`) adds to the tokens and the text frames: an API key header's
 * value (`x-api-key: ...`, `api-key: ...`) and `ASSIGNED_SECRET`. A header value needs 12 characters and a digit, as a
 * random key has, so a sentence naming the header (`set the x-api-key: header`) passes.
 */
export const SECRET_LITERAL_PATTERNS = [
    {
        id: 'api-key-header',
        description: 'key in an API key header',
        pattern: /\b(?:x-(?:[a-z0-9]+-)*)?api-key["']?\s*:\s*["']?(?=[^\s"']*\d)([^\s"']{12,})/i,
        secretGroup: 1,
    },
    ASSIGNED_SECRET,
];
