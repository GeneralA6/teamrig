import type { LineRuns } from '../package-guard/programs.ts';
import { programName } from '../push-guard/launchers.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';

/**
 * Whether a command line changes an environment variable, in any shell the guards read: an assignment (`NAME=v cmd`,
 * `env NAME=v`, `NAME=` alone, `export NAME=`, cmd's `set NAME=`, PowerShell's `$env:NAME = v`), a removal (`env -u
 * NAME`, `unset NAME`, `export -n NAME`, `Remove-Item Env:NAME`), an empty environment (`env -i`), or .NET's
 * `SetEnvironmentVariable` naming it. Names match in any case, as Windows reads them. Only the words a guard reads
 * count, so a script the line runs is not covered: it is a check against mistakes. A line that only mentions the name
 * (`grep NAME`, `echo $NAME`) changes nothing.
 */
export function changesVariable(runs: LineRuns, name: string): boolean {
  const variable = name.toLowerCase();
  const edited = runs.envEdits.some(
    ({ set, unset, emptied }) => emptied || set.some((assignment) => assignment.name.toLowerCase() === variable) || unset.some((word) => word.dynamic || word.text.toLowerCase() === variable),
  );
  const commands = [...runs.programs.map((run) => [run.program, ...run.args]), ...runs.bare.map((bare) => bare.words)];
  return edited || commands.some((words) => commandChanges(words, variable));
}

/** Builtins whose arguments name variables they drop or overwrite whatever else they hold: `unset NAME`, `local NAME`, `read NAME`. */
const DROPPING_BUILTINS: ReadonlySet<string> = new Set(['unset', 'local', 'read', 'mapfile', 'readarray']);

/** Builtins that set a variable an argument assigns (`export NAME=v`), with the options after which they unexport one they name. */
const SETTING_BUILTINS: ReadonlyMap<string, readonly string[]> = new Map([
  ['export', ['-n']],
  ['declare', ['+x']],
  ['typeset', ['+x']],
  ['readonly', []],
  ['set', []],
]);

/** PowerShell's item cmdlets and their aliases that set, move or remove an item, here one of the env drive. */
const ITEM_WRITERS: ReadonlySet<string> = new Set([
  'remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir',
  'clear-item', 'cli',
  'set-item', 'si',
  'new-item', 'ni',
  'move-item', 'mi', 'mv', 'move',
  'rename-item', 'rni', 'ren',
  'copy-item', 'cpi', 'cp', 'copy',
]);

/** An env drive item, `Env:NAME`, `env:\NAME` or `Env:/NAME`, giving what follows the drive. */
const ENV_ITEM = /^env:[\\/]?(.*)$/i;

/** The variable a word names before any `=` or `+=`, in lower case: `name` for `NAME+=x`. */
function nameBeforeValue(word: ShellWord): string {
  return word.text.replace(/\+?=[\s\S]*$/, '').toLowerCase();
}

/** Whether one command's words change `variable`, given in lower case. */
function commandChanges(words: readonly ShellWord[], variable: string): boolean {
  const [head, ...args] = words;
  if (head === undefined) {
    return false;
  }
  const program = programName(head.text).toLowerCase();
  if (DROPPING_BUILTINS.has(program)) {
    return args.some((word) => nameBeforeValue(word) === variable);
  }
  if (program === 'printf') {
    return args.some((word, index) => word.text === '-v' && args[index + 1]?.text.toLowerCase() === variable);
  }
  const unexports = SETTING_BUILTINS.get(program);
  if (unexports !== undefined) {
    const drops = args.some((word) => unexports.includes(word.text));
    return args.some((word) => nameBeforeValue(word) === variable && (word.text.includes('=') || drops));
  }
  if (ITEM_WRITERS.has(program)) {
    return args.some((word) => {
      const rest = ENV_ITEM.exec(word.text)?.[1];
      return rest !== undefined && (word.dynamic || rest.toLowerCase() === variable || /[*?[]/.test(rest));
    });
  }
  return words.some((word) => /SetEnvironmentVariable/i.test(word.text)) && words.some((word) => word.text.toLowerCase().includes(variable));
}
