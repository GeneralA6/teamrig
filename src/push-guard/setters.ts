import type { ShellWord } from './tokenizer.ts';

/**
 * The one rule the push guard's readers of shell names share for "a command that can set a name unseen":
 * `variables.ts` (which resolves a line's own `NAME=value` bindings) and `arithmetic.ts` (which lets
 * `$((...))` read counters). Each keeps its own keyword handling; the builtins and the `printf`/`export` rule
 * live here, so a builtin added later reaches both.
 */

/** A shell name. */
export const NAME = /^[A-Za-z_]\w*$/;
/** A word that looks like an assignment, quoted or not: `NAME=`, `NAME+=` or `NAME[`. */
export const ASSIGNMENT_LIKE = /^([A-Za-z_]\w*)(\[|\+?=)/;
/** `NAME=` at the start of a word. */
export const SETS_NAME = /^([A-Za-z_]\w*)=/;

/**
 * bash builtins that can set a name in a way the line does not show as `NAME=value` (`read`, `declare`,
 * `let`, `wait -p`), or run code that can (`eval`, `source`, `trap`, `jobs -x`, an alias or a shell option).
 */
const SETTING_BUILTINS: ReadonlySet<string> = new Set([
  ...['read', 'readarray', 'mapfile', 'getopts', 'let', 'declare', 'typeset', 'local', 'readonly', 'unset', 'wait'],
  ...['eval', 'source', '.', 'trap', 'command', 'builtin', 'jobs', 'enable', 'alias', 'unalias', 'shopt', 'compgen', 'complete', 'fc'],
]);

/**
 * True for a command whose program can set a name unseen: a program only known when it runs, a builtin in
 * {@link SETTING_BUILTINS}, `printf` with `-v` or a format only known when it runs, or `export` with an option
 * or an argument that may set a name other than the one it shows. `words` are the command's words from its
 * first non-keyword word on (leading assignments included); keywords are each caller's to judge.
 */
export function setsNamesUnseen(words: readonly ShellWord[]): boolean {
  const start = words.findIndex((word) => !ASSIGNMENT_LIKE.test(word.text));
  const program = words[start];
  if (program === undefined) {
    return false;
  }
  if (program.dynamic || SETTING_BUILTINS.has(program.text)) {
    return true;
  }
  const args = words.slice(start + 1);
  switch (program.text) {
    case 'printf':
      // `printf -v NAME` assigns; so may a format only known when it runs.
      return args[0] !== undefined && (args[0].dynamic || args[0].text.startsWith('-'));
    case 'export':
      return args.some((word) => word.text.startsWith('-') || !exportsOwnName(word));
    default:
      return false;
  }
}

/**
 * True for an `export` argument that can set only the name it shows: a static word, or `NAME=` with any
 * variables in quotes, which bash never splits into further arguments.
 */
function exportsOwnName(word: ShellWord): boolean {
  return !word.dynamic || (SETS_NAME.test(word.text) && word.parts !== undefined && word.parts.every((part) => part.kind === 'text' || part.quoted));
}

/** The name of a `NAME=value` shell assignment word: its name and `=` unquoted at the word's start, else undefined. */
export function unquotedBindingName(word: ShellWord): string | undefined {
  const head = word.parts?.[0];
  return head?.kind === 'text' && !head.quoted ? SETS_NAME.exec(head.text)?.[1] : undefined;
}
