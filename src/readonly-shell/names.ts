import type { ReadonlyRules } from './rules.ts';

/**
 * The names a line may never set: bash reads them itself, exported or not (`PATH`, `IFS`, `CDPATH`, `HOME` for `cd`
 * and `~`...), or the shell a Bash call runs in exports them although the hook's own environment lacks them: Claude
 * Code's `TEMP` and `TMP`, bash's `PWD`, `SHLVL` and `_`, MSYS's `MSYSTEM` and `WINDIR`. The two lower-case ones are
 * bash's too.
 */
const SHELL_NAMES: ReadonlySet<string> = new Set([
  '_',
  'auto_resume',
  'histchars',
  'AWKLIBPATH',
  'AWKPATH',
  'CDPATH',
  'CHILD_MAX',
  'COLUMNS',
  'COMPREPLY',
  'DIRSTACK',
  'EMACS',
  'ENV',
  'EPOCHREALTIME',
  'EPOCHSECONDS',
  'EUID',
  'EXECIGNORE',
  'FCEDIT',
  'FIGNORE',
  'FUNCNAME',
  'FUNCNEST',
  'GLOBIGNORE',
  'GLOBSORT',
  'GROUPS',
  'HOME',
  'HOSTFILE',
  'HOSTNAME',
  'HOSTTYPE',
  'IFS',
  'IGNOREEOF',
  'INPUTRC',
  'INSIDE_EMACS',
  'LANG',
  'LANGUAGE',
  'LINENO',
  'LINES',
  'MACHTYPE',
  'MAIL',
  'MAILCHECK',
  'MAILPATH',
  'MAPFILE',
  'OLDPWD',
  'OPTARG',
  'OPTERR',
  'OPTIND',
  'OSTYPE',
  'PATH',
  'PIPESTATUS',
  'POSIXLY_CORRECT',
  'PPID',
  'PS0',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PWD',
  'RANDOM',
  'REPLY',
  'SECONDS',
  'SHELL',
  'SHELLOPTS',
  'SHLVL',
  'SRANDOM',
  'TERM',
  'TIMEFORMAT',
  'TMOUT',
  'TZ',
  'UID',
  // The temporary folders, which Claude Code sets for the shell, sort writes to and bash keeps here-documents in.
  'TEMP',
  'TEMPDIR',
  'TMP',
  'TMPDIR',
  // Windows names MSYS hands bash under its own spelling.
  'COMSPEC',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  // What a listed program reads besides its own family.
  'ALL_PROXY',
  'BLOCKSIZE',
  'BLOCK_SIZE',
  'BROWSER',
  'EDITOR',
  'EMAIL',
  'LOGNAME',
  'MANPAGER',
  'NO_PROXY',
  'PAGER',
  'PREFIX',
  'QUOTING_STYLE',
  'TIME_STYLE',
  'USER',
  'VISUAL',
]);

/**
 * The upper-case families a line may never set, by their start: bash's own (`BASH_ENV`, `HISTFILE`, `LC_ALL`...),
 * MSYS's (`MSYS`, `MSYS2_PATH_TYPE`, `ORIGINAL_TMP`), Claude Code's (`CLAUDE_CODE_EXECPATH`, which its snapshot's `rg`
 * runs), and those a listed program or a trusted prefix reads (`GIT_*`, `KUBECONFIG`, `LESSOPEN`, `NODE_OPTIONS`,
 * `NPM_CONFIG_*`, `GREP_COLORS`, `HTTPS_PROXY`, `LD_PRELOAD`...). A family stays off whole, so a name of it a later
 * shell exports stays refused.
 */
const SHELL_FAMILIES: readonly string[] = [
  'BASH',
  'COMP_',
  'HIST',
  'LC_',
  'PROMPT_',
  'READLINE_',
  'CYGWIN',
  'MINGW',
  'MSYS',
  'ORIGINAL_',
  'CLAUDE',
  'DYLD_',
  'GIT_',
  'GREP_',
  'HTTP',
  'KUBE',
  'LD_',
  'LESS',
  'LS_',
  'NODE_',
  'NPM_',
  'NPX_',
  '_POSIX',
  'SSH_',
  'XDG_',
];

/**
 * Whether the line may set `name`. The line exports nothing (no `export`, `declare -x` or `set -a` is on the list), so
 * a name it sets reaches a program only when the shell already exports it: never one the hook's environment or the
 * shell snapshot exports (under the snapshot's `set -a`, none at all), nor one bash or MSYS reads or sets. An
 * upper-case name also stays off every family above, and off any exported name in another spelling, since Windows
 * keeps `windir` and `Path` where bash reads `WINDIR` and `PATH`.
 */
export function mayAssign(name: string, rules: ReadonlyRules): boolean {
  if (rules.exportsAll || rules.exported.has(name) || SHELL_NAMES.has(name)) {
    return false;
  }
  if (/[a-z]/.test(name)) {
    return true;
  }
  return !SHELL_FAMILIES.some((family) => name.startsWith(family)) && ![...rules.exported].some((exported) => exported.toUpperCase() === name);
}
