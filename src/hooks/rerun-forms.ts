import { KIT_NAME } from '../core/home.ts';
import { isStaticWord, parseShell, type Redirection, type ShellCommand } from '../push-guard/tokenizer.ts';
import { posixWord } from '../test-run/shell.ts';

/**
 * Rerun forms: the exact line teamrig's rules give a Bash call Claude Code would ask about, computed from the line
 * itself, so a session refused at the prompt reruns it at once instead of waiting for the owner.
 *
 * - `cd D && git X` becomes `git -C D X`, and any other command after `cd D &&` becomes `env -C D cmd`, so the line
 *   runs in the same folder without a `cd` compound, which Claude Code always asks about.
 * - `git worktree remove P` becomes `teamrig worktree remove P`, which unlinks shared folders such as node_modules
 *   before git empties them.
 *
 * A form must do exactly what the line did whenever its `cd` succeeds, so any doubt gives none: a word only known
 * when it runs, an unquoted glob or `~`, a subshell or substitution, a heredoc, a redirection to a relative file once
 * the folder moves, a shell builtin after the `cd`, a background `&`.
 */

/** Separators between commands that keep the same folder and order, newlines left out; '' is a bare newline. */
const SEPARATORS: ReadonlySet<string> = new Set(['&&', '||', '|', ';', '']);

/** Commands only the shell itself runs, which `env -C` cannot start, and keywords that open a compound command. */
const SHELL_ONLY: ReadonlySet<string> = new Set([
  'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'source', '.', 'eval', 'exec', 'exit', 'return', 'alias', 'unalias',
  'declare', 'typeset', 'local', 'readonly', 'shift', 'trap', 'ulimit', 'umask', 'wait', 'builtin', 'command', 'hash',
  'read', 'let', 'shopt', 'jobs', 'fg', 'bg', 'disown', 'history',
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function',
  'time', '!', '{', '}', '[[', ']]',
]);

/** A leading `NAME=value` word, which sets a variable for the command instead of naming its program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The exact line to rerun a Bash `command` as, or undefined when no rule gives one or any doubt remains. */
export function rerunForm(tool: string | undefined, command: string): string | undefined {
  if (tool !== 'Bash') {
    return undefined;
  }
  const parse = parseShell(command, 'bash');
  const commands = parse.commands;
  if (!parse.complete || parse.bindingsUnclear || parse.unreadBodies.length > 0 || !commands.every(isPlain) || !separatorsKeep(commands)) {
    return undefined;
  }
  const [first, ...rest] = commands;
  if (first === undefined) {
    return undefined;
  }
  const folder = leadingFolder(first, rest.length);
  const moved = folder === undefined ? commands : rest;
  const lines = moved.map((each) => rewrite(each, folder));
  if (!lines.every((line): line is string => line !== undefined) || (folder === undefined && !moved.some(removesWorktree))) {
    return undefined;
  }
  return moved.map((each, at) => `${lines[at] ?? ''}${separatorAfter(each, at === moved.length - 1)}`).join('');
}

/** A top-level command of static words, no stdin from the line, and no subshell or substitution around it. */
function isPlain(command: ShellCommand): boolean {
  return (
    command.nesting === 0 &&
    command.subshells.length === 0 &&
    command.stdin === undefined &&
    command.words.length > 0 &&
    command.words.every(isStaticWord) &&
    command.redirections.every((redirection) => !redirection.operator.startsWith('<<') && (redirection.target === undefined || isStaticWord(redirection.target)))
  );
}

/** Every separator keeps the commands in one folder and in order; the last command may end in `;` only. */
function separatorsKeep(commands: readonly ShellCommand[]): boolean {
  return commands.every((command, at) => {
    const separator = separatorOf(command);
    return SEPARATORS.has(separator) && (at < commands.length - 1 || separator === '' || separator === ';');
  });
}

function separatorOf(command: ShellCommand): string {
  return command.terminator.replaceAll('\n', '');
}

/** The separator written after a command in the form: none after the last one, `;` for a bare newline. */
function separatorAfter(command: ShellCommand, last: boolean): string {
  if (last) {
    return '';
  }
  const separator = separatorOf(command);
  return separator === '' || separator === ';' ? '; ' : ` ${separator} `;
}

/**
 * D of a leading `cd D &&` with commands after it, or undefined. A `cd` with options, `-` or no folder keeps the line
 * as it is: `isStatic` already gave no form to a `~`.
 */
function leadingFolder(first: ShellCommand, after: number): string | undefined {
  const [program, folder, ...more] = first.words;
  const moves = program?.text === 'cd' && folder !== undefined && more.length === 0 && !folder.text.startsWith('-');
  return moves && after > 0 && separatorOf(first) === '&&' && first.redirections.length === 0 ? folder.text : undefined;
}

/**
 * A command as the form writes it: in `folder` when the line moved there (git through `-C`, anything else through
 * `env -C`), with `git worktree remove P` as `teamrig worktree remove P`. Undefined when it cannot keep its meaning:
 * a `cd` the line does not lead with, a builtin after the move, a redirection to a relative file once the folder moves.
 */
function rewrite(command: ShellCommand, folder: string | undefined): string | undefined {
  const { assignments, words } = split(command);
  const [program] = words;
  if (program === undefined || program === 'cd' || (folder !== undefined && (SHELL_ONLY.has(program) || !command.redirections.every(keepsFolder)))) {
    return undefined;
  }
  const run = worktreeRemove(words) ?? words;
  const placed = folder === undefined ? [...assignments, ...run] : inFolder(folder, assignments, run);
  return [...placed.map(posixWord), ...command.redirections.map(redirectionText)].join(' ');
}

/** A command's leading `NAME=value` words, and its program with the arguments after them. */
function split(command: ShellCommand): { readonly assignments: readonly string[]; readonly words: readonly string[] } {
  const texts = command.words.map((word) => word.text);
  const start = texts.findIndex((text) => !ASSIGNMENT.test(text));
  return start === -1 ? { assignments: texts, words: [] } : { assignments: texts.slice(0, start), words: texts.slice(start) };
}

function removesWorktree(command: ShellCommand): boolean {
  return worktreeRemove(split(command).words) !== undefined;
}

/** A redirection that reaches the same file from any folder: a descriptor copy such as `2>&1`, or an absolute path. */
function keepsFolder(redirection: Redirection): boolean {
  return redirection.target === undefined || redirection.target.text.startsWith('/');
}

function redirectionText(redirection: Redirection): string {
  return redirection.target === undefined ? redirection.operator : `${redirection.operator}${posixWord(redirection.target.text)}`;
}

/** The words that run `program words` in `folder`: `git -C folder ...`, else `env -C folder [NAME=value...] ...`. */
function inFolder(folder: string, assignments: readonly string[], words: readonly string[]): string[] {
  const [program, ...args] = words;
  if (program === 'git' && assignments.length === 0) {
    return ['git', '-C', folder, ...args];
  }
  return ['env', '-C', folder, ...assignments, ...words];
}

/** `teamrig worktree remove P` for `git worktree remove P` with no options, else undefined. */
function worktreeRemove(words: readonly string[]): string[] | undefined {
  const [program, sub, verb, path, ...more] = words;
  const plain = program === 'git' && sub === 'worktree' && verb === 'remove' && path !== undefined && !path.startsWith('-') && more.length === 0;
  return plain ? [KIT_NAME, 'worktree', 'remove', path] : undefined;
}
