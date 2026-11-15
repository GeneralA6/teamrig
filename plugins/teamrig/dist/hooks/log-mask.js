import { redact } from "../exec/redact.js";
/**
 * The mask a command line passes before a hook log keeps it (T1986, design M3): the log is values-free, so a
 * session's triage line never carries a secret the call held. `redact` already takes a URL's user part and the
 * scanner's shapes (tokens, an Authorization header's credential, `password=`); this closes the forms it misses, each
 * judged on the line's text alone, the safe side: masking a value that was no secret costs a triage reader one word.
 */
/** What a masked value becomes. */
export const MASKED_VALUE = '[redacted]';
/** The end of a name that holds a secret, in any case: `...TOKEN`, `...KEY`, `...SECRET`, `...PASSWORD`, `...URI`. */
const SECRET_NAME_END = String.raw `(?:token|key|secret|password|passwd|pwd|uri|auth|credentials?)`;
/** A value: double-quoted (escapes kept inside), single-quoted (spaces inside), or a run up to a space, a quote or a shell operator. */
const VALUE = String.raw `(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'&;|<>()]+)`;
/**
 * `NAME=value` where the name ends in a secret word: an env assignment (`API_TOKEN=v cmd`, `export DB_URI=v`), a
 * PowerShell one with spaces (`$env:GH_TOKEN = 'v w'`), a query's parameter (`?access_token=v`) or a flag's
 * (`--token=v`). The name starts where no name character comes before it.
 */
const SECRET_ASSIGNMENT = new RegExp(String.raw `(?<![\w.$:-])((?:-{1,2}|\$env:)?[\w.-]*?${SECRET_NAME_END})(\s*=\s*)(${VALUE})`, 'gi');
/** A flag named for a secret and its value after a space: `--token v`, `--password v`, `--api-key v`, `-Secret v`. */
const SECRET_FLAG = new RegExp(String.raw `(?<![\w-])(-{1,2}[\w-]*?${SECRET_NAME_END})(\s+)(?!-)(${VALUE})`, 'gi');
/** A login and password a flag gives together: curl's `-u user:pass`, `--user user:pass`, `--proxy-user user:pass`. */
const USER_PASSWORD_FLAG = /(?<![\w-])(-u|--user|--proxy-user)(\s*)(["']?)([^\s:"']*):([^\s"']+)\3/g;
/** A password a tool takes as `-p`: sshpass's `-p v`, and mysql's `-pv` (a bare `-p` prompts for it). */
const PASSWORD_P_FLAG = /(\bsshpass\b[^;&|\n]*?\s-p)(\s*)([^\s;&|]+)|(\bmysql(?:dump|admin)?\b[^;&|\n]*?\s-p)([^\s;&|]+)/g;
/** A run of base64 characters over 40 long, as a key or a token encodes one; `looksRandom` tells it from a path. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{41,}={0,2}/g;
const DIGIT_AND_BOTH_CASES = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])/;
/** The class of a letter or digit: 0 upper-case, 1 lower-case, 2 a digit; undefined for any other character. */
function charClass(char) {
    return /[A-Z]/.test(char) ? 0 : /[a-z]/.test(char) ? 1 : /\d/.test(char) ? 2 : undefined;
}
/**
 * True when a base64 `run` reads as random, not as a path or a name: it holds a digit and both cases, and its letters
 * and digits change class at least once every four of them. Random base64 changes class about twice in three; a path
 * (`/c/Work/app/t1986-log-mask/src`) or a camelCase name changes a few times in all, and a hex hash has no upper case.
 */
function looksRandom(run) {
    const classes = Array.from(run, charClass).filter((one) => one !== undefined);
    const changes = classes.filter((one, index) => index > 0 && one !== classes[index - 1]).length;
    return DIGIT_AND_BOTH_CASES.test(run) && changes * 4 >= classes.length;
}
/**
 * `command` with every value it may hold a secret in masked, ready for a hook log. Masks the forms above first, then
 * runs `redact` (a URL's user part, the scanner's shapes), so a token assigned to a secret name goes as one value.
 */
export function maskCommand(command, scanner) {
    const masked = command
        .replace(SECRET_ASSIGNMENT, (_whole, name, equals) => `${name}${equals}${MASKED_VALUE}`)
        .replace(SECRET_FLAG, (_whole, flag, space) => `${flag}${space}${MASKED_VALUE}`)
        .replace(USER_PASSWORD_FLAG, (_whole, flag, space, quote, login) => `${flag}${space}${quote}${login}:${MASKED_VALUE}${quote}`)
        .replace(PASSWORD_P_FLAG, (whole, sshpass, space, _value, mysql) => sshpass !== undefined ? `${sshpass}${space ?? ''}${MASKED_VALUE}` : mysql !== undefined ? `${mysql}${MASKED_VALUE}` : whole)
        .replace(BASE64_RUN, (run) => (looksRandom(run) ? MASKED_VALUE : run));
    return redact(masked, [], scanner);
}
