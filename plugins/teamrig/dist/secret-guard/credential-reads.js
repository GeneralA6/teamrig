import { SHIP_TOKEN, TOKEN_PREFIX } from "../github/tokens.js";
/**
 * The commands that read a credential out of the host's store, matched over a run's line (`<program> <args>`, the
 * program as the guards compare it, in lowercase). Each lookahead starts at the line's start, so a match costs time in
 * proportion to the line. A quiet run counts too: a session that only captures a key (`T=$(gh auth token)`) holds it
 * all the same. `cmdkey /list` and the macOS lookups without `-w` print only the entries' names, but they name what to
 * read next, and a case-ignored pattern cannot tell `-g` (print the password) from `-G` (a filter).
 */
const STORE_COMMANDS = [
    { label: 'git credential fill', pattern: /^git(?=\s)(?=[\s\S]*\scredential\s+fill(?:\s|$))/i },
    { label: 'git credential-<helper> get', pattern: /^git(?=\s)(?=[\s\S]*\scredential-[\w-]+\s+get(?:\s|$))/i },
    { label: 'git-credential-<helper> get', pattern: /^git-credential-[\w-]+(?=\s)(?=[\s\S]*\sget(?:\s|$))/i },
    { label: 'gh auth token', pattern: /^gh(?=\s)(?=[\s\S]*\sauth\s+token(?:\s|$))/i },
    { label: 'gh auth status --show-token', pattern: /^gh(?=\s)(?=[\s\S]*\sauth\s+status(?:\s|$))(?=[\s\S]*\s(?:-t|--show-token(?:=true)?)(?:\s|$))/i },
    { label: 'security find-*-password', pattern: /^security(?=\s)(?=[\s\S]*\s(?:find-(?:generic|internet)-password|dump-keychain)(?:\s|$))/i },
    { label: 'secret-tool lookup', pattern: /^secret-tool(?=\s)(?=[\s\S]*\s(?:lookup|search)(?:\s|$))/i },
    { label: 'cmdkey /list', pattern: /^cmdkey(?=\s)(?=[\s\S]*\s[/-]list(?::\S*)?(?:\s|$))/i },
    { label: 'vaultcmd /listcreds', pattern: /^vaultcmd(?=\s)(?=[\s\S]*\s[/-]listcreds(?::\S*)?(?:\s|$))/i },
    { label: 'keyring get', pattern: /^keyring(?=\s)(?=[\s\S]*\sget(?:\s|$))/i },
    { label: 'Get-Secret', pattern: /^get-secret(?:\s|$)/i },
];
/** A regular expression source that matches `text` as written. */
function literally(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * What a line reads a saved credential with wherever it stands, matched over the whole line: an API that inline code,
 * a PowerShell type or a script calls (`CredReadW`, `PasswordVault`, `keyring.get_password`, `keytar`), and the names
 * teamrig saves its GitHub tokens under, so no session reads or replaces another's key by name. Reading the whole line
 * finds them in a `node -e` script or a PowerShell `Add-Type` block the program reading never opens.
 */
const STORE_TEXTS = [
    { label: 'CredRead', pattern: /\bCred(?:Read|Enumerate)[AW]?\b/i },
    { label: 'PasswordVault', pattern: /\bPasswordVault\b/i },
    { label: 'Get-StoredCredential', pattern: /\bGet-StoredCredential\b/i },
    { label: 'keyring.get_password', pattern: /\bkeyring\.get_(?:password|credential)\b/i },
    { label: 'keytar', pattern: /\bkeytar\b/i },
    { label: `${TOKEN_PREFIX}<owner>`, pattern: new RegExp(`\\b${literally(TOKEN_PREFIX)}`, 'i') },
    { label: SHIP_TOKEN, pattern: new RegExp(`\\b${literally(SHIP_TOKEN)}\\b`, 'i') },
];
/**
 * The saved credentials a shell line reads: each run whose command reads the store, printed or not, then each store API
 * or teamrig credential name the line's text holds. Once the guard refuses these, a key saved for one tool draws a line
 * between sessions; until then any session could read every key its user saved.
 */
export function credentialReadFindings(command, runs) {
    const lines = runs.map((run) => [run.name, ...run.args.map((arg) => arg.text)].join(' '));
    const byRun = STORE_COMMANDS.filter(({ pattern }) => lines.some((line) => pattern.test(line)));
    const byText = STORE_TEXTS.filter(({ pattern }) => pattern.test(command));
    return [...byRun, ...byText].map(({ label }) => ({ kind: 'credential', via: label }));
}
