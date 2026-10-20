import type { ShellWord } from '../push-guard/tokenizer.ts';

/** What one option word tells: whether it gives the script, and how many next words it takes as its value. */
interface OptionRead {
  readonly script: boolean;
  readonly values: number;
}

/** How a program that takes a script or a pattern before its files spells its options, as far as finding that operand needs. */
interface OptionSyntax {
  /** True when the word is an option, not an operand. */
  isOption(text: string): boolean;
  /** True when the word ends the options, so that every later word is an operand. */
  endsOptions(text: string): boolean;
  read(text: string): OptionRead;
}

/** A GNU style option set: short letters that cluster (`-ne`), long names that may take `=value`. */
interface GnuOptions {
  /** Short options that take a value, written on after the letter or as the next word. */
  readonly valued: string;
  /** Short options that take the rest of their word as an optional value, never the next word (`sed -i.bak`). */
  readonly attached: string;
  /** The short options that give the script or pattern, so that no operand is one. */
  readonly scriptShort: string;
  /** Long options that take the next words as their value when written without `=`, with how many. */
  readonly long: ReadonlyMap<string, number>;
  /** The long options that give the script or pattern; any abbreviation of one counts too. */
  readonly scriptLong: readonly string[];
}

const NO_VALUE: OptionRead = { script: false, values: 0 };

/**
 * Reads GNU style options. Only options known to take a value skip a word: an unknown one is read as a flag, so
 * that its value, not a file, is taken for the script.
 */
function gnuSyntax(options: GnuOptions): OptionSyntax {
  return {
    isOption: (text) => text.startsWith('-') && text !== '-',
    endsOptions: (text) => text === '--',
    read: (text) => (text.startsWith('--') ? readLong(text, options) : readShort(text, options)),
  };
}

function readLong(text: string, options: GnuOptions): OptionRead {
  const equals = text.indexOf('=');
  const name = equals < 0 ? text : text.slice(0, equals);
  const script = name.length > 2 && options.scriptLong.some((long) => long.startsWith(name));
  return { script, values: equals < 0 ? (options.long.get(name) ?? 0) : 0 };
}

function readShort(text: string, options: GnuOptions): OptionRead {
  for (let at = 1; at < text.length; at += 1) {
    const letter = text.charAt(at);
    if (options.attached.includes(letter)) {
      return NO_VALUE;
    }
    if (options.valued.includes(letter)) {
      return { script: options.scriptShort.includes(letter), values: at === text.length - 1 ? 1 : 0 };
    }
    if (options.scriptShort.includes(letter)) {
      return { script: true, values: 0 };
    }
  }
  return NO_VALUE;
}

/**
 * Reads PowerShell parameters, `-Name value` or `-Name:value`, in any case. Only a valued parameter spelled out in
 * full skips a word, as an abbreviation may name a switch; any abbreviation of the script's parameter gives it.
 */
function powerShellSyntax(valued: readonly string[], script: string): OptionSyntax {
  return {
    isOption: (text) => text.startsWith('-') && text !== '-',
    endsOptions: () => false,
    read: (text) => {
      const colon = text.indexOf(':');
      const name = (colon < 0 ? text : text.slice(0, colon)).slice(1).toLowerCase();
      return { script: name !== '' && script.startsWith(name), values: colon < 0 && valued.includes(name) ? 1 : 0 };
    },
  };
}

/** Reads cmd's `/x` options, whose values follow a colon in the same word; `script` lists those that give it. */
function cmdSyntax(script: readonly string[]): OptionSyntax {
  return {
    isOption: (text) => text.startsWith('/'),
    endsOptions: () => false,
    read: (text) => ({ script: script.some((option) => text.toLowerCase().startsWith(option)), values: 0 }),
  };
}

const GREP = gnuSyntax({
  valued: 'ABCDdefm',
  attached: '',
  scriptShort: 'ef',
  long: new Map(
    ['--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--include', '--exclude', '--exclude-dir', '--label'].map(
      (name): [string, number] => [name, 1],
    ),
  ),
  scriptLong: ['--regexp', '--file'],
});

const RIPGREP = gnuSyntax({
  valued: 'ABCEMTefgjmrt',
  attached: '',
  scriptShort: 'ef',
  long: new Map(
    [
      '--regexp',
      '--file',
      '--after-context',
      '--before-context',
      '--context',
      '--encoding',
      '--max-columns',
      '--type-not',
      '--glob',
      '--iglob',
      '--threads',
      '--max-count',
      '--max-depth',
      '--replace',
      '--type',
    ].map((name): [string, number] => [name, 1]),
  ),
  scriptLong: ['--regexp', '--file'],
});

const SED = gnuSyntax({
  valued: 'efl',
  attached: 'i',
  scriptShort: 'ef',
  long: new Map(['--expression', '--file', '--line-length'].map((name): [string, number] => [name, 1])),
  scriptLong: ['--expression', '--file'],
});

const AWK = gnuSyntax({
  valued: 'efvFiElW',
  attached: 'dDLop',
  scriptShort: 'efE',
  long: new Map(['--source', '--file', '--exec', '--assign', '--field-separator', '--include', '--load'].map((name): [string, number] => [name, 1])),
  scriptLong: ['--source', '--file', '--exec'],
});

const JQ = gnuSyntax({
  valued: 'L',
  attached: '',
  scriptShort: 'f',
  long: new Map([
    ['--arg', 2],
    ['--argjson', 2],
    ['--slurpfile', 2],
    ['--rawfile', 2],
    ['--indent', 1],
  ]),
  scriptLong: ['--from-file'],
});

const SELECT_STRING = powerShellSyntax(['pattern', 'path', 'literalpath', 'context', 'encoding', 'include', 'exclude', 'inputobject', 'culture'], 'pattern');

const FINDSTR = cmdSyntax(['/c:', '/g:']);

/** Printers whose first operand is a script or a pattern, not a file, unless an option gives it. */
const SCRIPT_FIRST: ReadonlyMap<string, OptionSyntax> = new Map([
  ...['grep', 'egrep', 'fgrep', 'zgrep'].map((name): [string, OptionSyntax] => [name, GREP]),
  ['rg', RIPGREP],
  ...['sed', 'gsed'].map((name): [string, OptionSyntax] => [name, SED]),
  ...['awk', 'gawk', 'mawk', 'nawk'].map((name): [string, OptionSyntax] => [name, AWK]),
  ...['jq', 'gojq'].map((name): [string, OptionSyntax] => [name, JQ]),
  ...['select-string', 'sls'].map((name): [string, OptionSyntax] => [name, SELECT_STRING]),
  ['findstr', FINDSTR],
]);

/** Printers that read only their stdin: every word is a setting (`tr`'s two sets), never a file. */
const STDIN_ONLY: ReadonlySet<string> = new Set(['tr']);

/**
 * The words of a printer's call that may name a file it prints: all but the script or pattern it takes first
 * (`sed 's/x/y/' f`, `grep -n x f`), or none for a program that reads only stdin. When an option gives the script
 * (`grep -e x`, `sed -f s.sed`), every operand may name a file.
 */
export function fileOperands(name: string, args: readonly ShellWord[]): readonly ShellWord[] {
  if (STDIN_ONLY.has(name)) {
    return [];
  }
  const syntax = SCRIPT_FIRST.get(name);
  const script = syntax === undefined ? undefined : scriptOperand(args, syntax);
  return script === undefined ? args : args.filter((_, index) => index !== script);
}

/** Where the operand that holds the script is, or undefined when an option gives the script or there is none. */
function scriptOperand(args: readonly ShellWord[], syntax: OptionSyntax): number | undefined {
  let first: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? '';
    if (syntax.endsOptions(text)) {
      return first ?? (index + 1 < args.length ? index + 1 : undefined);
    }
    if (!syntax.isOption(text)) {
      first ??= index;
      continue;
    }
    const option = syntax.read(text);
    if (option.script) {
      return undefined;
    }
    index += option.values;
  }
  return first;
}
