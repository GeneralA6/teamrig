import { isIdentifierName } from "../core/secret-patterns.js";
import { isPlaceholderValue } from "../core/secret-shapes.js";
/**
 * `NAME=value` as an environment dump, a `.env` file or `docker inspect` prints it: an upper-case name with no space
 * around `=`. Source code writes `token = x` or `token: string`, so a Read or Grep of code passes. The value stops at
 * a space, a quote or a shell operator, save a URL's `&`, which joins its parameters; a quoted value is the
 * quoted-literal shape's.
 */
const ASSIGNMENT = /(?<![\w$])([A-Z][A-Z0-9_]*)=(<[^\s<>"'`;,&|()]*>[^\s"'`;,&|()<>]*|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`;,|()<>]+|[^\s"'`;,&|()<>]+)/g;
/**
 * The one placeholder a whole value may be (T192): a printf conversion (`%s`, `%-10s`), `$NAME`, `${NAME}` or an angle
 * placeholder. Exact, so anything glued on (`%sAKIA...`, `$X-secret`, `<x>sk-...`) is still a value. `${NAME:-default}`
 * is not one: a default is a value.
 */
const EXACT_PLACEHOLDER = /^(?:%[-+ #0]*\d*[sdqvx]|\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|<[^\s<>]*>)$/;
/** A value that opens like a placeholder, so only an exact one passes. */
const PLACEHOLDER_OPENING = /^[%$<]/;
/** A shell or printf `\n` written as two characters, where a printf format line ends a value. */
const NEWLINE_ESCAPE = '\\n';
/** A URL's userinfo, path, query and fragment, the parts that can carry a secret; the scheme and the host never do. */
const URL_PARTS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:([^/?#]*)@)?[^/?#]*([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
/** A path segment shaped like a token, as a webhook URL carries its secret: 16 or more word characters, a letter and a digit among them. */
const TOKEN_SEGMENT = /^(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{16,}$/;
/** A number: a limit, a port or a count (`TOKEN_LIMIT=200000`). */
const NUMBER = /^\d+(?:\.\d+)?$/;
/** A path to the secret, not the secret: `KEY_FILE=/a/b.pem`, `C:\k.pem`, `~/.ssh/id`, `./key`. */
const PATH = /^(?:[A-Za-z]:)?[\\/~.]/;
/** One plain lower-case word: a mode or a kind (`AUTH_MODE=oauth`, `TOKEN_TYPE=bearer`). */
const PLAIN_WORD = /^[a-z]+$/;
/** Git's own variable for a setting's name; the setting's value sits in `GIT_CONFIG_VALUE_<n>`. */
const GIT_CONFIG_KEY = /^GIT_CONFIG_KEY_\d+$/;
/** A section and a dot, which git requires of every setting's name (`core.hooksPath`). */
const GIT_SETTING = /^[A-Za-z][A-Za-z0-9-]*\./;
/**
 * The output-only shape of T1369 R7: the value of a secret variable, the name judged by the team's `SecretNames`.
 * Output is not prose, so the unquoted form is in here; prompts and notes stay without it.
 */
export class EnvAssignments {
    names;
    constructor(names) {
        this.names = names;
    }
    /** Every secret variable's value in `text`, in the order found; a value that only names or points to one passes. */
    hitsIn(text) {
        const hits = [];
        for (const [, name = '', value = ''] of text.matchAll(ASSIGNMENT)) {
            const end = value.indexOf(NEWLINE_ESCAPE);
            // A printf format line runs its assignments together with `\n`: the value ends at the escape, and what follows is
            // scanned again as text, so a real secret after a placeholder is still found (T192).
            if (end >= 0 && EXACT_PLACEHOLDER.test(value.slice(0, end))) {
                hits.push(...this.hitsIn(value.slice(end + NEWLINE_ESCAPE.length)));
                continue;
            }
            if (!this.names.secret(name) || !this.holdsSecret(name, value))
                continue;
            hits.push({ id: 'env-assignment', description: 'value of a secret variable', value });
        }
        return hits;
    }
    /**
     * True when `value`, assigned to `name`, holds a secret. A URL is judged by the parts that carry one (T1549): its login
     * and password, a query or fragment parameter with a secret name, a token-shaped path segment. A connection string
     * without them, its credential a file on disk, is plain; one with them is a hit as a whole. A git setting's name is
     * plain, but only past the URL test: `url.<base>.insteadOf` holds a URL, whose login can be a token (T2001).
     */
    holdsSecret(name, value) {
        const url = URL_PARTS.exec(value);
        if (url === null)
            return !isPlainValue(value) && !isGitSetting(name, value);
        const [, userinfo = '', path = '', query = '', fragment = ''] = url;
        const [login = '', ...password] = userinfo.split(':');
        const parts = [
            login,
            password.join(':'),
            ...path.split('/').filter((segment) => TOKEN_SEGMENT.test(segment)),
            ...secretParamValues(`${query}&${fragment}`, (name) => this.names.secret(name)),
        ];
        return parts.some((part) => !isPlainValue(part));
    }
}
/** The values of the `&`-joined `name=value` parameters in `params` whose name `secret` takes for a secret one. */
function secretParamValues(params, secret) {
    return params.split('&').flatMap((param) => {
        const equals = param.indexOf('=');
        return equals > 0 && secret(param.slice(0, equals)) ? [param.slice(equals + 1)] : [];
    });
}
/** True when `value` is the name of a git setting, assigned to git's own variable for one. */
function isGitSetting(name, value) {
    return GIT_CONFIG_KEY.test(name) && GIT_SETTING.test(value);
}
/** True when an assigned `value` is not a secret: a placeholder, a name, a number, a path or a plain word. */
function isPlainValue(value) {
    // `$` alone is what stops at a `$(command)`; any longer value opening with a placeholder must be exactly one.
    if (value !== '$' && PLACEHOLDER_OPENING.test(value))
        return EXACT_PLACEHOLDER.test(value);
    return isPlaceholderValue(value) || isIdentifierName(value) || NUMBER.test(value) || PATH.test(value) || PLAIN_WORD.test(value);
}
