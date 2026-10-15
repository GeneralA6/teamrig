import { isAssignment, launch, programName, staticWord, type Assignment, type Launch } from './launchers.ts';
import { Location, resolveDir } from './location.ts';
import { stdinUse } from './stdin.ts';
import { parseShell, type ShellCommand, type ShellDialect, type ShellWord } from './tokenizer.ts';
import { resolveLiteralVariables } from './variables.ts';

/** One git config value: set, unset (git exits 1), or unreadable (git failed or is missing). */
export type ConfigValue = { readonly kind: 'set'; readonly value: string } | { readonly kind: 'unset' } | { readonly kind: 'unreadable' };

/** Reads git config as git in a folder sees it; the hook asks git, tests pass a fake. */
export interface GitConfigReader {
  config(dir: string, key: string): ConfigValue;
}

/** One git command a command line runs, after aliases are expanded. */
export interface GitInvocation {
  /** The folder git runs in, after `cd`, `-C`, `--git-dir` and `GIT_DIR`; undefined when it is only known when the line runs. */
  readonly dir: string | undefined;
  readonly subcommand: string;
  readonly args: readonly ShellWord[];
  /** True when `-c`, `--config-env` or a `GIT_CONFIG*` variable may change remotes, branches or push defaults. */
  readonly configOverride: boolean;
}

/** Why the guard cannot read part of a command line with confidence. */
export interface Doubt {
  /** A phrase that completes "the guard cannot tell whether this command pushes to a protected branch: ...". */
  readonly reason: string;
  /** True when it matters only on a command line that mentions a push anywhere; false when it always asks. */
  readonly gated: boolean;
}

/** Every git command a command line runs, in order, and what the guard could not read. */
export interface GitInvocations {
  readonly invocations: readonly GitInvocation[];
  readonly doubts: readonly Doubt[];
  /** True when the line, or a script or alias it runs, says `push` anywhere. */
  readonly mentionsPush: boolean;
}

export interface FinderContext {
  readonly cwd: string;
  /** The user's home folder, for `cd ~`. */
  readonly home: string;
  readonly dialect: ShellDialect;
  readonly git: GitConfigReader;
}

/** Git's own commands; an alias never overrides one. */
const BUILTINS: ReadonlySet<string> = new Set(
  (
    'add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap ' +
    'check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config ' +
    'count-objects credential cvsexportcommit cvsimport cvsserver daemon describe diagnose diff diff-files diff-index diff-tree ' +
    'difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc ' +
    'get-tar-commit-id gitk grep gui hash-object help hook http-backend http-fetch http-push imap-send index-pack init instaweb ' +
    'interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index ' +
    'merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id prune ' +
    'prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote repack replace replay ' +
    'request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email send-pack shortlog show show-branch show-index ' +
    'show-ref sparse-checkout stage stash status stripspace submodule subtree svn switch symbolic-ref tag unpack-file unpack-objects ' +
    'update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version ' +
    'whatchanged worktree write-tree'
  ).split(' '),
);
/** Git options that only print something and run no command. */
const GIT_INFO_OPTIONS: ReadonlySet<string> = new Set(['--help', '-h', '--version', '-v', '--html-path', '--man-path', '--info-path', '--exec-path']);
/** Git options that take a value, as the next word or after `=`. */
const GIT_VALUED_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);
/** Config sections that change which remote branch a push updates. */
const PUSH_CONFIG = /^(?:remote|push|branch)\./i;
/** `git config` forms that read or remove, never set. */
const CONFIG_READS: ReadonlySet<string> = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--unset', '--unset-all', '--remove-section', '--rename-section', '-e', '--edit']);
const CONFIG_VALUED: ReadonlySet<string> = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
const CONFIG_SUBCOMMANDS: ReadonlySet<string> = new Set(['get', 'list', 'unset', 'edit', 'rename-section', 'remove-section']);
const FILTER_OPTIONS: ReadonlySet<string> = new Set(['--setup', '--env-filter', '--tree-filter', '--index-filter', '--msg-filter', '--commit-filter', '--parent-filter', '--tag-name-filter']);

/** How deep scripts (`bash -c "eval ..."`) and git aliases may nest before the guard stops reading. */
const MAX_SCRIPT_DEPTH = 8;
const MAX_ALIAS_DEPTH = 8;
const DIALECT_NAMES: Readonly<Record<ShellDialect, string>> = { bash: 'bash', powershell: 'PowerShell', cmd: 'cmd' };

/** Variables that move git to another repository; set in the shell earlier in the line, they move every later git command. */
const GIT_DIR_VARIABLES = /^GIT_(?:DIR|COMMON_DIR)$/i;
/** Variables that change the config git reads. */
const GIT_CONFIG_VARIABLES = /^GIT_CONFIG/i;
/** Bash builtins that set variables for the rest of the shell, such as `export GIT_DIR=x`. */
const BASH_SETTERS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
/** PowerShell commands that set an `env:` item. */
const PS_ENV_SETTERS = /^(?:set-item|si|new-item|ni)$/i;
/** A word that stands for a value only known when the line runs, such as a `GIT_DIR` set earlier in the shell. */
const UNKNOWN_WORD: ShellWord = { text: '', dynamic: true };

/** The name `pattern` captures from a word, if any. */
const capturedName =
  (pattern: RegExp) =>
  (word: ShellWord): string[] => {
    const name = pattern.exec(word.text)?.[1];
    return name === undefined ? [] : [name];
  };

/**
 * The variables a command sets for the rest of its shell: bash `export X=1` or a bare `X=1`,
 * PowerShell `$env:X = 1` or `Set-Item env:X 1`, cmd `set X=1`. Variables a launcher sets for one
 * program (`X=1 git push`) are not here; see `launch`.
 */
export function shellVariables(words: readonly ShellWord[], dialect: ShellDialect): string[] {
  const [head, ...rest] = words;
  if (head === undefined) {
    return [];
  }
  const assigned = capturedName(/^([A-Za-z_]\w*)=/);
  switch (dialect) {
    case 'bash':
      if (BASH_SETTERS.has(head.text)) {
        return rest.flatMap(assigned);
      }
      return words.every((word) => isAssignment(word.text)) ? words.flatMap(assigned) : [];
    case 'powershell': {
      if (PS_ENV_SETTERS.test(head.text)) {
        return rest.flatMap(capturedName(/^env:\\?([A-Za-z_]\w*)$/i));
      }
      const target = /^\$env:([A-Za-z_]\w*)(\s*[-+*/]?=)?/i.exec(head.text);
      const assigns = target?.[2] !== undefined || /^[-+*/]?=/.test(rest[0]?.text ?? '');
      return target?.[1] !== undefined && assigns ? [target[1]] : [];
    }
    case 'cmd':
      return head.text.toLowerCase() === 'set' ? rest.flatMap(assigned) : [];
  }
}

/** What one git run inherits: its folder, whether config is overridden, and the aliases its `-c` options set. */
interface GitState {
  /** The folder git starts in, after `cd` and `-C`. */
  readonly dir: string | undefined;
  /** A `GIT_DIR` or `--git-dir`, which git resolves from {@link dir} after every `-C`; a dynamic word when only known when it runs. */
  readonly gitDir: ShellWord | undefined;
  readonly configOverride: boolean;
  /** Aliases from `-c alias.x=...`; undefined marks one whose value is only known when it runs. */
  readonly aliases: ReadonlyMap<string, string | undefined>;
  /** True when a `-c` or `GIT_CONFIG*` setting may define aliases the guard cannot read. */
  readonly aliasesUnknown: boolean;
}

/** Quotes a word for a bash command line, so a git shell alias gets its arguments as typed. */
function shellQuote(word: ShellWord): string {
  return word.dynamic ? word.text : `'${word.text.replace(/'/g, `'\\''`)}'`;
}


/** True when a command takes its stdin from a redirection, such as `< file`, rather than from a pipe. */
function redirectsInput(command: ShellCommand): boolean {
  return command.redirections.some((redirection) => /^0?</.test(redirection.operator));
}

/** Splits `--option=value` into its name and attached value. */
function splitOption(text: string): readonly [string, string | undefined] {
  const equals = text.startsWith('--') ? text.indexOf('=') : -1;
  return equals === -1 ? [text, undefined] : [text.slice(0, equals), text.slice(equals + 1)];
}

/**
 * Finds every git command a command line runs. It reads the line as its shell would (see `parseShell`),
 * follows `cd` and friends, sees through launchers (see `launch`) into nested scripts, reads git's global
 * options, and expands git aliases (from `-c`, from a `git config alias.x` earlier in the line, or from git
 * config), including `!` shell aliases. Commands git itself runs (`submodule foreach`, `rebase --exec`,
 * `bisect run`, `filter-branch` filters) are read too. Whatever it cannot read becomes a {@link Doubt}.
 */
class GitInvocationFinder {
  private readonly invocations: GitInvocation[] = [];
  private readonly doubts: Doubt[] = [];
  private readonly texts: string[] = [];
  /** Aliases a `git config alias.x value` earlier in the line sets; undefined marks one only known when it runs. */
  private readonly lineAliases = new Map<string, string | undefined>();
  /** True once the line sets a `GIT_DIR`-like variable in its shell, so later git commands run in a repository the guard cannot place. */
  private shellMovesRepo = false;
  /** True once the line sets a `GIT_CONFIG*` variable in its shell. */
  private shellOverridesConfig = false;
  private readonly context: FinderContext;

  constructor(context: FinderContext) {
    this.context = context;
  }

  find(command: string): GitInvocations {
    this.visitScript(staticWord(command), this.context.dialect, new Location(this.context.cwd, this.context.home), 0);
    return { invocations: this.invocations, doubts: this.doubts, mentionsPush: this.texts.some((text) => /\bpush\b/i.test(text)) };
  }

  private doubt(reason: string, gated: boolean): void {
    this.doubts.push({ reason, gated });
  }


  /**
   * Visits each command of a script in order. A heredoc or here-string is its command's stdin, and a plain
   * `cat` hands its stdin down a pipe to the next command, so `cat <<EOF | bash` runs the body as commands.
   */
  private visitScript(script: ShellWord, dialect: ShellDialect, location: Location, depth: number): void {
    if (depth > MAX_SCRIPT_DEPTH) {
      this.doubt('scripts nest too deep to read', false);
      return;
    }
    this.texts.push(script.text);
    const parsed = parseShell(script.text, dialect);
    if (!parsed.complete) {
      this.doubt('part of it cannot be read, as a quote, bracket or substitution never closes', true);
    }
    // bash reads $NAME set to a literal earlier in the line; other dialects keep every variable unknown.
    const commands = dialect === 'bash' ? resolveLiteralVariables(parsed.commands, script.text) : parsed.commands;
    let piped: { readonly body: ShellWord; readonly nesting: number } | undefined;
    for (const command of commands) {
      let stdin = command.stdin;
      // A substitution's commands, read before the command that holds them, sit between a pipe's two ends.
      if (piped !== undefined && command.nesting <= piped.nesting) {
        stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
        piped = undefined;
      }
      location.enter(command.subshells);
      const launched = this.visitCommand(command.words, dialect, location, depth, stdin);
      if (stdin !== undefined) {
        const use = launched === undefined ? 'read' : stdinUse(command, launched);
        piped = use === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
      }
    }
  }

  /** Visits one simple command, given what it reads on stdin from the line; returns what it starts, or undefined for a `cd`. */
  private visitCommand(words: readonly ShellWord[], dialect: ShellDialect, location: Location, depth: number, stdin?: ShellWord): Launch | undefined {
    for (const name of shellVariables(words, dialect)) {
      this.shellMovesRepo ||= GIT_DIR_VARIABLES.test(name);
      this.shellOverridesConfig ||= GIT_CONFIG_VARIABLES.test(name);
    }
    if (location.apply(words, dialect)) {
      return undefined;
    }
    const launched = launch(words, dialect, stdin);
    switch (launched.kind) {
      case 'nothing':
        break;
      case 'opaque':
        this.doubt(launched.reason, launched.gated);
        break;
      case 'script': {
        const inner = location.child();
        launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
        if (launched.script.dynamic && launched.dialect !== dialect) {
          this.doubt(`it hands ${DIALECT_NAMES[launched.dialect]} a command line built from ${DIALECT_NAMES[dialect]} variables`, true);
        }
        this.visitScript(launched.script, launched.dialect, inner, depth + 1);
        if (launched.sameShell) {
          location.adopt(inner);
        }
        break;
      }
      case 'program': {
        const name = programName(launched.program.text);
        const subcommand = name.startsWith('git-') ? name.slice(4) : undefined;
        if (name !== 'git' && (subcommand === undefined || !BUILTINS.has(subcommand))) {
          break;
        }
        const inner = location.child();
        launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
        const args = subcommand === undefined ? launched.args : [staticWord(subcommand), ...launched.args];
        const tail = launched.stdinArgs ? [...args, { text: '<stdin>', dynamic: true }] : args;
        this.visitGit(tail, this.gitState(inner.dir, launched.env), depth, 0);
      }
    }
    return launched;
  }

  /**
   * What a git run inherits from its shell and from the variables its launcher sets: `GIT_DIR` moves it,
   * `GIT_CONFIG*` overrides config. One set in the shell earlier in the line is treated as unknown: the guard
   * resolves an earlier literal only where a word reads it (`$NAME`), never in the environment git inherits.
   */
  private gitState(dir: string | undefined, env: readonly Assignment[]): GitState {
    let gitDir = this.shellMovesRepo ? UNKNOWN_WORD : undefined;
    let overridden = this.shellOverridesConfig;
    for (const { name, value } of env) {
      if (GIT_DIR_VARIABLES.test(name)) {
        gitDir = name.toUpperCase() === 'GIT_DIR' ? value : UNKNOWN_WORD;
      }
      overridden ||= GIT_CONFIG_VARIABLES.test(name);
    }
    return { dir, gitDir, configOverride: overridden, aliases: new Map(), aliasesUnknown: overridden };
  }

  /** The folder git runs in: its `-C` folder, moved to its git dir when it has one. */
  private repoDir(state: Pick<GitState, 'dir' | 'gitDir'>): string | undefined {
    const { dir, gitDir } = state;
    if (gitDir === undefined) {
      return dir;
    }
    return gitDir.dynamic ? undefined : resolveDir(dir, gitDir.text, this.context.home);
  }

  /** Reads git's global options, then runs the subcommand: a builtin, or an alias to expand. */
  private visitGit(words: readonly ShellWord[], start: GitState, depth: number, aliasDepth: number): void {
    let { dir, gitDir, configOverride, aliasesUnknown } = start;
    const aliases = new Map(start.aliases);
    let index = 0;
    for (; index < words.length; index += 1) {
      const word = words[index] ?? staticWord('');
      if (!word.text.startsWith('-')) {
        break;
      }
      const [name, attached] = splitOption(word.text);
      if (word.dynamic && /[$`%@(]/.test(name)) {
        break;
      }
      if (GIT_INFO_OPTIONS.has(name) && attached === undefined) {
        return;
      }
      if (!GIT_VALUED_OPTIONS.has(name)) {
        continue;
      }
      const value = attached === undefined ? words[(index += 1)] : { text: attached, dynamic: word.dynamic };
      if (value === undefined) {
        return;
      }
      if (name === '-C') {
        dir = value.dynamic ? undefined : value.text === '' ? dir : resolveDir(dir, value.text, this.context.home);
      } else if (name === '--git-dir') {
        gitDir = value;
      } else if (name === '-c' || name === '--config-env') {
        const setting = /^([A-Za-z][\w.-]*)(?:=(.*))?$/s.exec(value.text);
        const key = setting?.[1]?.toLowerCase();
        if (key === undefined || (value.dynamic && /[$`%]/.test(key))) {
          configOverride = true;
          aliasesUnknown = true;
        } else if (key.startsWith('alias.')) {
          aliases.set(key.slice('alias.'.length), value.dynamic || name === '--config-env' ? undefined : (setting?.[2] ?? 'true'));
        } else {
          configOverride ||= PUSH_CONFIG.test(key);
        }
      }
    }
    const sub = words[index];
    if (sub === undefined) {
      return;
    }
    if (sub.dynamic) {
      this.doubt('the git command it runs is only known when it runs', true);
      return;
    }
    const state: GitState = { dir, gitDir, configOverride, aliases, aliasesUnknown };
    const args = words.slice(index + 1);
    if (BUILTINS.has(sub.text)) {
      this.builtin({ dir: this.repoDir(state), subcommand: sub.text, args, configOverride }, depth);
    } else {
      this.alias(sub.text, args, state, depth, aliasDepth);
    }
  }

  private builtin(invocation: GitInvocation, depth: number): void {
    this.invocations.push(invocation);
    const { args, dir } = invocation;
    switch (invocation.subcommand) {
      case 'config':
        this.registerAlias(args);
        return;
      case 'submodule':
        this.submoduleForeach(args, depth);
        return;
      case 'rebase':
        this.rebaseExec(args, dir, depth);
        return;
      case 'bisect':
        if (args[0]?.text === 'run' && args.length > 1) {
          this.visitCommand(args.slice(1), 'bash', new Location(dir, this.context.home), depth + 1);
        }
        return;
      case 'filter-branch':
        args.forEach((arg, index) => {
          const filter = args[index + 1];
          if (FILTER_OPTIONS.has(arg.text) && filter !== undefined) {
            this.visitScript(filter, 'bash', new Location(undefined, this.context.home), depth + 1);
          }
        });
    }
  }

  /** Expands an alias; a name that is no alias is not a git command the guard reads (git extensions such as `git-foo` are not). */
  private alias(name: string, args: readonly ShellWord[], state: GitState, depth: number, aliasDepth: number): void {
    const key = name.toLowerCase();
    const repoDir = this.repoDir(state);
    let value: string | undefined;
    if (state.aliases.has(key)) {
      value = state.aliases.get(key);
    } else if (this.lineAliases.has(key)) {
      value = this.lineAliases.get(key);
    } else if (state.aliasesUnknown) {
      this.doubt(`"git ${name}" may be an alias a config override sets`, true);
      return;
    } else {
      const read = this.context.git.config(repoDir ?? this.context.cwd, `alias.${key}`);
      if (read.kind === 'unreadable') {
        this.doubt(`git could not read whether "git ${name}" is an alias`, false);
        return;
      }
      if (read.kind === 'unset') {
        if (repoDir === undefined) {
          this.doubt(`"git ${name}" may be an alias of a repository only known when it runs`, true);
        }
        return;
      }
      value = read.value;
    }
    if (value === undefined) {
      this.doubt(`"git ${name}" is an alias whose value is only known when it runs`, true);
      return;
    }
    if (aliasDepth >= MAX_ALIAS_DEPTH) {
      this.doubt('git aliases nest too deep to read', false);
      return;
    }
    this.texts.push(value);
    if (value.startsWith('!')) {
      const script = [value.slice(1), ...args.map(shellQuote)].join(' ');
      this.visitScript(staticWord(script), 'bash', new Location(repoDir, this.context.home), depth + 1);
      return;
    }
    const expanded = parseShell(value, 'bash').commands.flatMap((command) => command.words);
    this.visitGit([...expanded, ...args], state, depth, aliasDepth + 1);
  }

  /** Records `git config [set] alias.x value`, so a later `git x` in the same line expands. */
  private registerAlias(args: readonly ShellWord[]): void {
    const operands: ShellWord[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index] ?? staticWord('');
      const [name, attached] = splitOption(word.text);
      if (CONFIG_READS.has(name)) {
        return;
      }
      if (word.text.startsWith('-')) {
        index += CONFIG_VALUED.has(name) && attached === undefined ? 1 : 0;
      } else {
        operands.push(word);
      }
    }
    const [first, ...rest] = operands;
    if (first !== undefined && CONFIG_SUBCOMMANDS.has(first.text)) {
      return;
    }
    const [key, value] = first?.text === 'set' ? rest : operands;
    if (key !== undefined && value !== undefined && !key.dynamic && /^alias\./i.test(key.text)) {
      this.lineAliases.set(key.text.slice('alias.'.length).toLowerCase(), value.dynamic ? undefined : value.text);
    }
  }

  /** `git submodule [options] foreach [--recursive] <command>`: one word is a shell command, more are a program and its arguments. */
  private submoduleForeach(args: readonly ShellWord[], depth: number): void {
    let index = args.findIndex((arg) => !arg.text.startsWith('-'));
    if (index === -1 || args[index]?.text !== 'foreach') {
      return;
    }
    index += 1;
    while (args[index]?.text.startsWith('-') === true) {
      index += 1;
    }
    const command = args.slice(index);
    const location = new Location(undefined, this.context.home);
    const [only] = command;
    if (command.length === 1 && only !== undefined) {
      this.visitScript(only, 'bash', location, depth + 1);
    } else if (command.length > 1) {
      this.visitCommand(command, 'bash', location, depth + 1);
    }
  }

  /** `git rebase -x <cmd>` / `--exec <cmd>` runs each command in the shell after each commit. */
  private rebaseExec(args: readonly ShellWord[], dir: string | undefined, depth: number): void {
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index] ?? staticWord('');
      const [name, attached] = splitOption(word.text);
      let command: ShellWord | undefined;
      if (name === '--exec' || name === '-x') {
        command = attached === undefined ? args[(index += 1)] : { text: attached, dynamic: word.dynamic };
      } else if (/^-x./s.test(word.text)) {
        command = { text: word.text.slice(2), dynamic: word.dynamic };
      }
      if (command !== undefined) {
        this.visitScript(command, 'bash', new Location(dir, this.context.home), depth + 1);
      }
    }
  }
}

/** Every git command `command` runs, and what the guard could not read; see {@link GitInvocationFinder}. */
export function findGitInvocations(command: string, context: FinderContext): GitInvocations {
  return new GitInvocationFinder(context).find(command);
}
