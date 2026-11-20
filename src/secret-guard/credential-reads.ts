import { SHIP_TOKEN, TOKEN_PREFIX } from '../github/tokens.ts';
import { spawnSync } from 'node:child_process';
import type { LineRuns, ProgramRun } from '../package-guard/programs.ts';
import { isStaticWord, type ShellWord } from '../push-guard/tokenizer.ts';
import type { SecretFinding } from './findings.ts';

/** A way a shell line reads a saved credential, and how the refusal names it. */
interface CredentialRead {
  readonly label: string;
  readonly pattern: RegExp;
  /** A name the store holds a key under, not an API that reads it: a search of tracked source for it reads no store. */
  readonly name?: true;
}

/**
 * The commands that read a credential out of the host's store, matched over a run's line (`<program> <args>`, the
 * program as the guards compare it, in lowercase). Each lookahead starts at the line's start, so a match costs time in
 * proportion to the line. A quiet run counts too: a session that only captures a key (`T=$(gh auth token)`) holds it
 * all the same. `cmdkey /list` and the macOS lookups without `-w` print only the entries' names, but they name what to
 * read next, and a case-ignored pattern cannot tell `-g` (print the password) from `-G` (a filter).
 */
const STORE_COMMANDS: readonly CredentialRead[] = [
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
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What a line reads a saved credential with wherever it stands, matched over the whole line: an API that inline code,
 * a PowerShell type or a script calls (`CredReadW`, `PasswordVault`, `keyring.get_password`, `keytar`), and the names
 * teamrig saves its GitHub tokens under, so no session reads or replaces another's key by name. Reading the whole line
 * finds them in a `node -e` script or a PowerShell `Add-Type` block the program reading never opens.
 */
const STORE_TEXTS: readonly CredentialRead[] = [
  { label: 'CredRead', pattern: /\bCred(?:Read|Enumerate)[AW]?\b/i },
  { label: 'PasswordVault', pattern: /\bPasswordVault\b/i },
  { label: 'Get-StoredCredential', pattern: /\bGet-StoredCredential\b/i },
  { label: 'keyring.get_password', pattern: /\bkeyring\.get_(?:password|credential)\b/i },
  { label: 'keytar', pattern: /\bkeytar\b/i },
  { label: `${TOKEN_PREFIX}<owner>`, pattern: new RegExp(`\\b${literally(TOKEN_PREFIX)}`, 'i'), name: true },
  { label: SHIP_TOKEN, pattern: new RegExp(`\\b${literally(SHIP_TOKEN)}\\b`, 'i'), name: true },
];

/** An allow-list of options, spelled exactly: git takes any unique prefix of a long option, so a deny-list misses. */
interface Options {
  /** Options that take no value. */
  readonly plain: ReadonlySet<string>;
  /** Options that take the next word as their value, or a value joined to them (`-A3`, `--max-depth=2`). */
  readonly valued: ReadonlySet<string>;
}

/**
 * The git options allowed before `grep`: the pager stays off. `-C <dir>` is left out: with `grep.fallbackToNoIndex`
 * set, git searches a folder that is no repository as `--no-index` would, and the session's own checkout needs no `-C`.
 */
const GIT_OPTIONS: Options = { plain: new Set(['--no-pager', '-P']), valued: new Set() };

/**
 * The `git grep` options allowed after the subcommand: read-only matching and output options. Left out on purpose:
 * `--no-index` and `--untracked` (with a moved work tree) search folders outside the repository, `-O`/
 * `--open-files-in-pager` starts a program on the files found, and `--textconv` starts the configured converters.
 */
const GREP_OPTIONS: Options = {
  plain: new Set([
    ...['-n', '-i', '-w', '-v', '-l', '-L', '-c', '-h', '-H', '-I', '-o', '-q', '-z', '-E', '-F', '-G', '-P', '-W', '--'],
    ...['--line-number', '--ignore-case', '--word-regexp', '--invert-match', '--files-with-matches'],
    ...['--files-without-match', '--count', '--name-only', '--only-matching', '--quiet', '--null'],
    ...['--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--function-context'],
    ...['--heading', '--break', '--column', '--full-name', '--and', '--or', '--not', '--all-match', '--cached'],
  ]),
  valued: new Set(['-e', '-f', '-A', '-B', '-C', '-m', '--max-depth', '--max-count', '--threads', '--context']),
};

/**
 * Where the words from `at` stop being allowed options: the index of the first word that is not an option (or the
 * end), or -1 when an option is not on the list. A short-option bundle (`-niw`) passes when each of its letters is a
 * plain option; a valued option takes its value joined (`-A3`, `--threads=2`) or as the next word, whatever it holds.
 */
function optionsEnd(args: readonly string[], at: number, options: Options, untilEnd: boolean): number {
  for (; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    if (!arg.startsWith('-') || arg === '-') {
      if (untilEnd) continue;
      return at;
    }
    if (options.plain.has(arg)) continue;
    if (options.valued.has(arg)) {
      at += 1;
      continue;
    }
    const joined = arg.startsWith('--') ? (arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg) : arg.slice(0, 2);
    if (joined !== arg && options.valued.has(joined)) continue;
    const bundle = /^-[A-Za-z]{2,}$/.test(arg) && [...arg.slice(1)].every((letter) => options.plain.has(`-${letter}`));
    if (!bundle) return -1;
  }
  return at;
}

/**
 * True when `run` is a `git grep` that searches only the repository and starts nothing else (#1469): the program
 * word is a bare `git` (a PATH lookup, not a file named git that would get the name as an argument), no wrapper
 * feeds it arguments from stdin, no word is expanded by the shell (`$X` or an unquoted `*` may become any option, so
 * the allow-list could not read it), and every option on either side of the subcommand is on its allow-list above.
 */
function repoSearch(run: ProgramRun): boolean {
  const plain = run.dialect === 'bash' ? isStaticWord : (arg: ShellWord): boolean => !arg.dynamic;
  if (run.program.text !== 'git' || run.stdinArgs || !run.args.every(plain)) return false;
  const args = run.args.map((arg) => arg.text);
  const at = optionsEnd(args, 0, GIT_OPTIONS, false);
  return at >= 0 && args[at] === 'grep' && optionsEnd(args, at + 1, GREP_OPTIONS, true) >= 0;
}

/**
 * Where a line starts, for the repository-search exception: `git grep` outside a work tree searches the plain folder
 * when `grep.fallbackToNoIndex` is set, so the exception holds only for a search run where the line starts, and only
 * when git finds a work tree there.
 */
export interface SearchStart {
  /** The folder the line starts in, as the walker resolves it; undefined when unknown. */
  readonly dir: string | undefined;
  /** Whether `dir` lies inside a git work tree. */
  readonly inWorkTree: (dir: string) => boolean;
}

/** Git's own answer, so an empty or broken `.git` that git skips is no work tree; any failure reads as none. */
export function gitWorkTree(dir: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: WORK_TREE_TIMEOUT_MS });
  return result.status === 0 && result.stdout.trim() === 'true';
}

/** Well inside a guard's time limit; a git slower than this leaves the credential name refused. */
const WORK_TREE_TIMEOUT_MS = 3_000;

/** No folder known: the exception never holds, as for a line run on another host. */
export const NO_SEARCH_START: SearchStart = { dir: undefined, inWorkTree: () => false };

/**
 * True when the line runs only repository searches (`repoSearch`) and nothing else: no command that starts no
 * program (a shell variable set alone), none whose program the walker cannot name, no shell fed from a pipe, and no
 * environment set for what it starts (`NAME=value git`, `env NAME=value git`), since the environment can name a
 * program git starts. Each search runs where the line starts, on a line that moves no folder or folder stack at all
 * (no `cd`, `pushd`, `popd` or `Set-Location`, even one that seems to come back), so no misread of a move can place
 * a search elsewhere, and that folder lies inside a git work tree, asked last as it starts git.
 */
function onlyRepoSearches(runs: LineRuns, start: SearchStart): boolean {
  const dir = start.dir;
  return (
    dir !== undefined &&
    runs.programs.length > 0 &&
    runs.programs.every((run) => repoSearch(run) && run.dir === dir) &&
    runs.moves.length === 0 &&
    runs.bare.length === 0 &&
    runs.opaque.length === 0 &&
    runs.fedShells.length === 0 &&
    runs.foreignShells.length === 0 &&
    runs.envEdits.length === 0 &&
    start.inWorkTree(dir)
  );
}

/**
 * The saved credentials a shell line reads: each run whose command reads the store, printed or not, then each store API
 * or teamrig credential name the line's text holds. Once the guard refuses these, a key saved for one tool draws a line
 * between sessions; until then any session could read every key its user saved. A credential name stands aside on a
 * line that runs only repository searches: it is text being looked for there, and a search of tracked files reads no
 * store.
 */
export function credentialReadFindings(command: string, runs: LineRuns, start: SearchStart): SecretFinding[] {
  const lines = runs.programs.map((run) => [run.name, ...run.args.map((arg) => arg.text)].join(' '));
  const byRun = STORE_COMMANDS.filter(({ pattern }) => lines.some((line) => pattern.test(line)));
  const named = STORE_TEXTS.filter(({ pattern }) => pattern.test(command));
  // Asked only when a credential name is on the line, as the work-tree check starts git.
  const onlySearches = named.some(({ name }) => name === true) && onlyRepoSearches(runs, start);
  const byText = named.filter(({ name }) => !(name === true && onlySearches));
  return [...byRun, ...byText].map(({ label }): SecretFinding => ({ kind: 'credential', via: label }));
}
