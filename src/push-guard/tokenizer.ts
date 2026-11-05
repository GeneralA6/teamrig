import { ansiCValue } from './ansi-c.ts';
import { bareLine, expandedUnits, nativeWords, splitLine, verbatimLine, type CRuntime, type LineUnit } from './native-line.ts';

/** Which shell wrote a command line; it decides the quotes, the escape character and what expands. */
export type ShellDialect = 'bash' | 'powershell' | 'cmd';

/**
 * A piece of a bash word: text, quoted (or escaped) or not, or a plain variable reference `$NAME` or `${NAME}`,
 * quoted when written inside double quotes or an expanding heredoc body, where its value is not split into words.
 */
export type WordPart =
  | { readonly kind: 'text'; readonly text: string; readonly quoted: boolean }
  | { readonly kind: 'variable'; readonly name: string; readonly quoted: boolean };

/** One word of a simple command, after quote removal. */
export interface ShellWord {
  /** The word's text; a variable or a substitution stays as written, such as `$B` or `$(git branch)`. */
  readonly text: string;
  /** True when part of the word is only known when the shell runs it: a variable, a substitution, a brace list. */
  readonly dynamic: boolean;
  /**
   * bash only: the word as text and plain variable references, in order. Absent when anything else in it
   * is only known when it runs: a substitution, `${...}` with an operator, `$1` or `$@`, a brace list.
   */
  readonly parts?: readonly WordPart[];
  /**
   * bash only: the text the word keeps as written, through quotes or escapes, when that holds a command
   * substitution (`$(` or a backtick), as `'a[$(git push)]'` does. The substitution is data here, but bash runs
   * it if an expansion reads the text again: prompt expansion (`${NAME@P}`), an indirect `${!NAME}`, arithmetic
   * (`$(( ))`, `let`, `[[ -eq ]]`) and a subscripted name (`read`, `printf -v`, `unset`, `declare`), in this
   * line or a later one. See {@link parseHeldText}.
   */
  readonly held?: string;
}

/**
 * One simple command: a program and its arguments, a keyword line such as `for x in a b`, or redirections
 * alone, such as `> out.log`, which still creates the file.
 */
export interface ShellCommand {
  /** Empty for a command of redirections alone. */
  readonly words: readonly ShellWord[];
  /**
   * The bash subshells it runs in, outermost first: `( )`, `$( )`, backticks and `<( )` each open one, so a
   * `cd` inside never moves the commands after it. PowerShell and cmd open none, as `(` and `$( )` run in the
   * same process. A line whose readings differ puts each in a subshell of its own, an id below zero, ahead of
   * these; see {@link parseShell}.
   */
  readonly subshells: readonly number[];
  /**
   * The separators between it and the next command, newlines included and blanks left out, such as `;`,
   * `&&`, `|`, `&`, `\n` or `);`. Empty for the last command of a line or of a substitution.
   */
  readonly terminator: string;
  /** Its redirections in order, such as `> out.log`, `2>&1` or `<<EOF`, which the words leave out. */
  readonly redirections: readonly Redirection[];
  /**
   * bash: the text it reads on stdin from the line itself, when its last input redirection is a heredoc (the
   * body) or a here-string (`<<< word`). An unquoted heredoc's body expands, so it is dynamic when it expands anything.
   */
  readonly stdin?: ShellWord;
  /**
   * How many substitutions (`$( )`, backticks, `<( )`, PowerShell `@( )`) it sits inside, a PowerShell argument's
   * `( )`, `{ }` and `@{ }` among them: 0 for the line's own commands.
   */
  readonly nesting: number;
}

/** A redirection: `>`, `>>`, `2>`, `<`, `<<`, `<<-`, `<<<`, `>&2`, `2>&1` or PowerShell's `*>`. */
export interface Redirection {
  /** The operator as written, with its file-descriptor number, such as `2>` or `2>&1`. */
  readonly operator: string;
  /** The word it names: a file, a heredoc's delimiter or a here-string; absent for a descriptor copy such as `2>&1`. */
  readonly target?: ShellWord;
}

/** A command while the scanner still adds the separators that follow it and the heredoc body it reads. */
interface ScannedCommand {
  readonly words: readonly ShellWord[];
  readonly subshells: readonly number[];
  terminator: string;
  /** Grows when a `( )` group closes on this command and redirections follow its `)`. */
  readonly redirections: Redirection[];
  stdin?: ShellWord;
  readonly nesting: number;
}

/** A bash heredoc whose body starts after the next newline. */
interface OpenHeredoc {
  readonly delimiter: string;
  /** True for `<<-`, whose delimiter line may start with tabs. */
  readonly tabbed: boolean;
  /** False when any part of the delimiter is quoted (`<<'EOF'`), so the body is literal. */
  readonly expands: boolean;
  /** The command that reads the body on stdin: one whose last input redirection it is. */
  readonly reader: ScannedCommand | undefined;
}

/** The simple commands of a command line, as its shell would split them. */
export interface ShellParse {
  /** Every simple command in order; a substitution's commands come before the command that holds them. */
  readonly commands: readonly ShellCommand[];
  /** False when a quote, a bracket or a substitution never closes, text is skipped or the readings differ: the line is not read with confidence. */
  readonly complete: boolean;
  /**
   * True when the reader left text unread that may hold commands: nesting ran too deep, or a single-quoted
   * piece of a quoted `${...}` holds more than plain text, which bash may expand. Text that only never
   * closes is still read to its end.
   */
  readonly skipped: boolean;
  /** bash heredoc bodies no command reads on stdin, such as the first of `cat <<A <<B` or one on a line with no command. */
  readonly unreadBodies: readonly ShellWord[];
  /**
   * bash only: true when the commands may not show the variables the line sets as it runs. Arithmetic
   * (`((...))`, `$((...))`, `$[...]`) and a `${...}` that assigns (`:=`), holds arithmetic (a substring or a
   * subscript other than a plain index such as `[0]`) or expands a value again (`${!R}`, `@P`) can assign
   * while they expand, a `{NAME}>` redirection
   * stores the descriptor it opens in NAME, and a heredoc left as commands (its delimiter never comes, or is
   * only known when it runs) may hold lines that never run. Quoted text never counts.
   */
  readonly bindingsUnclear: boolean;
  /**
   * Present when the shell may read the line more than one way and the ways differ: a CR in bash, a NUL or a
   * `` `u{hex} `` in PowerShell, a caret before a newline in cmd. Each on its own, in the order {@link commands} holds
   * them. What follows one line's state from command to command reads these, as a value set in one reading says nothing
   * about the next.
   */
  readonly readings?: readonly ShellParse[];
}

/** How deep substitutions may nest before the parse stops and calls itself incomplete. */
const MAX_NESTING = 16;

/**
 * What separates the words of an unquoted line, measured on the real shells (T2002). JS `\s` fits none of them:
 * PowerShell also takes U+0085 and keeps U+FEFF in a word, and bash and a program started by cmd take only these two.
 */
const BLANKS: Readonly<Record<ShellDialect, RegExp>> = {
  bash: /[ \t]/,
  powershell: /[\t\v\f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/,
  cmd: /[ \t]/,
};

/**
 * PowerShell's quote marks, measured on its parser (T2002): any mark of a class closes a quote any other opened. bash
 * and cmd know only the plain ones.
 */
const POWERSHELL_QUOTES = { single: /['\u2018\u2019\u201a\u201b]/, double: /["\u201c\u201d\u201e]/ } as const;

/**
 * What a PowerShell backtick makes of a letter, in a word or in quotes alike, measured on 5.1 (T2002). Every other letter
 * keeps itself. That holds `e` too, ESC on pwsh 7: only the letter can spell an option, and ESC makes a word git refuses.
 */
const POWERSHELL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['0', '\0'],
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
]);

/** pwsh's escape for a character by its number, from its backtick; see {@link Reading.codePoints}. */
const CODE_POINT = /`u\{[0-9a-fA-F]{1,6}\}/y;
const MAX_CODE_POINT = 0x10ffff;

/** A word that is all a redirection's file-descriptor number: `2` of `2>`, or PowerShell's `*` of `*>`. */
const DESCRIPTOR = /^(?:\d+|\*)$/;

/**
 * PowerShell's variable, member name and `-name:` token, measured on its parser (T2002). A `/u` class takes a surrogate
 * pair as one unit, which the tables never counted as a letter, so each refuses one first: else a word is cut there and
 * a `--verify` after it reads as a cancel. `:(?!:)` leaves `::` to the member chain, as `$v::Length` is a member.
 */
const VARIABLE = /\$(?![\u{10000}-\u{10ffff}])[\p{L}\p{Nd}_?$^\u1885\u1886](?:(?![\u{10000}-\u{10ffff}])[\p{L}\p{Nd}_?$^\u1885\u1886]|:(?!:))*/uy;
const MEMBER_NAME = /(?:(?![\u{10000}-\u{10ffff}])[\p{L}\p{Nd}_\u1885\u1886])+/uy;
/** What ends a `-name` token's name, besides a colon and a quote, which each do more; see {@link BARE_PARAMETER}. */
const PARAMETER_ENDS = String.raw`.[;|\0\t\v\f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\n\r&(),{}`;
const PARAMETER_NAME = String.raw`[-\u2013\u2014\u2015](?![\u{10000}-\u{10ffff}])[\p{L}_?\u1885\u1886][^:'\u2018\u2019\u201a\u201b"\u201c\u201d\u201e${PARAMETER_ENDS}]*`;
const PARAMETER = new RegExp(`${PARAMETER_NAME}:(?!:)`, 'uy');
/**
 * A `-name` token right behind a whole `--%`, measured on 5.1 (T2003): it needs no colon there and takes only one, so
 * `-y::z` leaves `:z`. A quote right behind the name makes no token, so `-y'a b'` stays a value.
 */
const BARE_PARAMETER = new RegExp(`${PARAMETER_NAME}(?::|(?=[${PARAMETER_ENDS}]|$))`, 'uy');

/** What a NUL does to the words of a PowerShell command; see {@link POWERSHELL_READINGS}. */
type NulEffect = 'line' | 'word' | 'kept';

/** One way a shell may read a line, where the guard cannot know which it is; see {@link readingsOf}. */
interface Reading {
  /** The text the scanner reads. */
  readonly source: string;
  /** True where a backtick's `u{hex}` is the character it names, as on pwsh 7; 5.1 keeps the letter. */
  readonly codePoints: boolean;
  readonly nul: NulEffect;
  /**
   * True where a `-name:` token's first unit must be ASCII, as on 5.1: its Unicode lacks letters Node's `\p{L}` has, and
   * such a unit opens no parameter there, so the quotes after it join one word. No list of those letters: `\p{L}` grows
   * with Node's ICU, so a list would drift and the miss come back.
   */
  readonly asciiParameters: boolean;
  /** The C runtime that splits the line 5.1 writes for a native program, where this reading rebuilds it; see {@link nativeCommand}. */
  readonly nativeLine: CRuntime | undefined;
  /** cmd's caret before a newline: by `/c` the line ends there, on stdin the next line joins it. */
  readonly caretLine: 'joins' | 'ends';
}

/**
 * Every way PowerShell may take a line holding a NUL, a `` `u `` or a dash before a unit past ASCII. A native program's
 * command line on Windows is one C string, so a NUL ends the word and the words after it (`line`, measured on 5.1,
 * reasoned for pwsh). On other hosts each argument is a C string of its own (`word`, reasoned, no pwsh here). A cmdlet
 * keeps the NUL in its string (`kept`), and `Invoke-Expression` then reads the text after it, so a cut there would hide
 * a command. The dash goes by the version, as `` `u `` does; see {@link Reading.asciiParameters}. A native program on
 * 5.1 gets its words from the line the shell writes, split by whichever C runtime it links, so that reading comes twice.
 */
const POWERSHELL_READINGS: readonly Pick<Reading, 'codePoints' | 'nul' | 'asciiParameters' | 'nativeLine'>[] = [
  { codePoints: false, nul: 'line', asciiParameters: true, nativeLine: 'ucrt' },
  { codePoints: false, nul: 'line', asciiParameters: true, nativeLine: 'msvcrt' },
  { codePoints: false, nul: 'kept', asciiParameters: true, nativeLine: undefined },
  { codePoints: true, nul: 'line', asciiParameters: false, nativeLine: undefined },
  { codePoints: true, nul: 'word', asciiParameters: false, nativeLine: undefined },
  { codePoints: true, nul: 'kept', asciiParameters: false, nativeLine: undefined },
];

/**
 * What a value can hold for 5.1's line to differ from its words: a double quote or a trailing backslash, which the
 * runtime reads, or nothing at all, as an empty value drops. Each takes a quote mark or a backslash to write: `` a` b\ ``
 * holds no quote, yet its line ends in `\"`. A comma differs too: an array with no gap is one argument on that line. So
 * does a `--%`: as a `-name:` token's value it needs no quote to be the binder's marker; see {@link nativeCommand}.
 */
const NATIVE_LINE_MARKS: readonly RegExp[] = [POWERSHELL_QUOTES.single, POWERSHELL_QUOTES.double, /[\\,]|--%/];

/** The reading of a line with nothing to choose between. */
function plainReading(source: string): Reading {
  return { source, codePoints: false, nul: 'kept', asciiParameters: false, nativeLine: undefined, caretLine: 'joins' };
}

/** The plain reading, and 5.1's native ones where the line holds what they differ on. */
function nativeReadings(plain: Reading): readonly Reading[] {
  const differ = NATIVE_LINE_MARKS.some((marks) => marks.test(plain.source));
  return differ ? [plain, ...POWERSHELL_READINGS.filter((reading) => reading.nativeLine !== undefined).map((reading) => ({ ...plain, ...reading }))] : [plain];
}

/**
 * The readings of a line. cmd drops every CR before it reads anything. bash on Windows does the same, by `-c`, file
 * and stdin alike, while bash elsewhere keeps a CR in its word, so a bash line holding one is read both ways. PowerShell
 * takes {@link POWERSHELL_READINGS} when the line holds what they differ on, and else {@link nativeReadings}. cmd's caret
 * before a newline is read both ways, as the entry decides it. Which host, version or entry the line runs on is not
 * asked: a guard's answer must not depend on it.
 */
function readingsOf(source: string, dialect: ShellDialect): readonly Reading[] {
  const plain = plainReading(source);
  const dropped = plainReading(source.replaceAll('\r', ''));
  switch (dialect) {
    case 'bash':
      return source.includes('\r') ? [dropped, plain] : [plain];
    case 'powershell':
      return /\0|`[0u]|[-\u2013\u2014\u2015][^\0-\x7f]/.test(source) ? POWERSHELL_READINGS.map((reading) => ({ ...plain, ...reading })) : nativeReadings(plain);
    case 'cmd':
      return dropped.source.includes('^\n') ? [dropped, { ...dropped, caretLine: 'ends' }] : [dropped];
  }
}

/**
 * One parse from the parses of a line's readings. Readings that agree count once; ones that differ all count, so every
 * guard sees each command any of them runs, and the line is not read with confidence. Each then sits in a subshell of
 * its own, numbered below the scanner's ids, so a relative `cd` in one does not move the next.
 */
function mergedParse(parses: readonly ShellParse[]): ShellParse {
  const distinct = [...new Map(parses.map((parse) => [JSON.stringify([parse.commands, parse.unreadBodies]), parse])).values()];
  const single = distinct.length === 1;
  const readings = single ? distinct : distinct.map((parse, at) => ({ ...parse, commands: parse.commands.map((command) => ({ ...command, subshells: [-1 - at, ...command.subshells] })) }));
  return {
    commands: readings.flatMap((parse) => parse.commands),
    complete: single && parses.every((parse) => parse.complete),
    skipped: parses.some((parse) => parse.skipped),
    unreadBodies: readings.flatMap((parse) => parse.unreadBodies),
    bindingsUnclear: parses.some((parse) => parse.bindingsUnclear),
    ...(single ? {} : { readings }),
  };
}

/**
 * Splits a command line into simple commands the way `dialect` would; see {@link Scanner}. Where the same text means
 * different words in different hosts or versions of the shell, the parse holds the commands of every reading.
 */
export function parseShell(command: string, dialect: ShellDialect): ShellParse {
  return mergedParse(readingsOf(command, dialect).map((reading) => new Scanner(reading, dialect, { nesting: 0, subshells: [], ids: { next: 0 } }).parse()));
}

/**
 * The commands bash runs when an expansion reads a word's {@link ShellWord.held} text again: the substitutions
 * in it, read as in an unquoted heredoc's body, where quotes are plain text and a backslash keeps a `$`.
 * bash expands that text left to right, so where it never closes bash stops at the error after running the
 * substitutions before it, which the commands hold; only {@link ShellParse.skipped} text may hide one.
 */
export function parseHeldText(held: string): ShellParse {
  return new Scanner(plainReading(held), 'bash', { nesting: 0, subshells: [], ids: { next: 0 } }).parseExpandable();
}

/** What may stand before the `=` of a PowerShell assignment that has no target in the same word. */
const ASSIGNMENT_PREFIX = /^(?:[-+*/%]|\?\?)?$/;

/**
 * Where a word's first `=` outside any bracket or quote sits, so the `=` in `$w[$i=0]=a`, `${a=b}=a` or `$h."a=b"=a` is
 * the last one. A member chain keeps its source, quotes included.
 */
function assignmentAt(text: string): number | undefined {
  let depth = 0;
  let quote: RegExp | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      quote = quote.test(char) ? undefined : quote;
      continue;
    }
    if (char === '=' && depth === 0) {
      return index;
    }
    quote = [POWERSHELL_QUOTES.single, POWERSHELL_QUOTES.double].find((marks) => marks.test(char));
    depth += /[[({]/.test(char) ? 1 : /[\])}]/.test(char) ? -1 : 0;
  }
  return undefined;
}

/**
 * Whether a PowerShell word at a statement's start can only be an expression: a `[Type]`, or anything else only known
 * when it runs. Nothing but `&` makes a program of one.
 */
export function isExpressionHead(word: ShellWord): boolean {
  return word.dynamic || word.text.startsWith('[');
}

/**
 * PowerShell: the words an assignment's right side runs, when `words` open with one, else undefined. A target is any
 * expression with a member or an index, on a variable, a quote, a group, a block or a `[Type]`, and a list of them
 * (`$p, $q = ...`) is one too, all measured to run the right side; casts before the first are skipped. Only a target at
 * the start opens one: a bare `=` among a program's arguments is text.
 */
export function assignedWords(words: readonly ShellWord[]): readonly ShellWord[] | undefined {
  for (const [index, word] of words.entries()) {
    const text = index === 0 ? word.text.replace(/^(?:\[[^\]]+\])+/, '') : word.text;
    const at = assignmentAt(text);
    const left = text.slice(0, at);
    const target = isExpressionHead(word);
    if (at === undefined) {
      if (target) {
        continue;
      }
      return undefined;
    }
    if (!target && (index === 0 || !ASSIGNMENT_PREFIX.test(left))) {
      return undefined;
    }
    const right = text.slice(at + 1);
    const rest = words.slice(index + 1);
    return right === '' ? rest : [{ text: right, dynamic: /[$@]/.test(right) }, ...rest];
  }
  return undefined;
}

/** What opens a PowerShell statement whose `( )` and `{ }` are its own parts, never arguments, in lower case. */
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'if', 'elseif', 'else', 'while', 'until', 'do', 'for', 'foreach', 'switch', 'try', 'catch', 'finally', 'function', 'filter', 'workflow', 'configuration',
  'trap', 'class', 'enum', 'data', 'param', 'begin', 'process', 'end', 'clean', 'dynamicparam', 'parallel', 'sequence', 'inlinescript',
]);

/** PowerShell: the statement `words` hold, past a `:label` and every assignment's target. */
function statementOf(words: readonly ShellWord[]): readonly ShellWord[] {
  let statement = words[0]?.text.startsWith(':') === true ? words.slice(1) : words;
  for (let right = assignedWords(statement); right !== undefined; right = assignedWords(statement)) {
    statement = right;
  }
  return statement;
}

/**
 * PowerShell: whether a `(` or `{` after `words` is an argument of their command. It is not at a statement's start,
 * where `(` is a group, nor after a keyword, whose block ends the statement: `do {} while (0) git push` runs what
 * follows. A block called at once (`& { ... }`) reads as a group too: its commands are all it runs, where a word would
 * leave the program unknown.
 */
function takesArguments(words: readonly ShellWord[], open: string): boolean {
  const statement = statementOf(words);
  const head = statement[0];
  if (head === undefined || (open === '{' && statement.length === 1 && (head.text === '&' || head.text === '.'))) {
    return false;
  }
  return head.dynamic || !STATEMENT_KEYWORDS.has(head.text.toLowerCase());
}

/** The text after a `--%`, and how many words stood before it. */
interface VerbatimText {
  readonly at: number;
  readonly units: readonly LineUnit[];
}

/**
 * PowerShell: where a program's arguments open in `words`, past the head, and past the program after a `&` or a `.`.
 * Undefined for a keyword's statement or an expression, which hands no program a line.
 */
function argumentsAt(words: readonly ShellWord[]): number | undefined {
  const statement = statementOf(words);
  const head = statement[0];
  if (head === undefined) {
    return undefined;
  }
  // A right side can be built from `$x=git`, one word for two, but the words after it are the same ones.
  const at = words.length - statement.length;
  if (head.text === '&' || head.text === '.') {
    return at + 2;
  }
  return isExpressionHead(head) || STATEMENT_KEYWORDS.has(head.text.toLowerCase()) ? undefined : at + 1;
}

/**
 * The words of one comma-built array, `from` to `to` inclusive, as indexes into a command's words. Tight when no comma
 * in it has a gap on either side: only then does 5.1's line join it by commas. Either way it is one argument, so it adds
 * one blank: `a ,b,c` writes three words, and `'' ,b` writes no blank for its empty element.
 */
interface ArgumentArray {
  readonly from: number;
  readonly to: number;
  readonly tight: boolean;
}

/** `arrays` after a comma behind word `last`: the word after it joins the array `last` closes, or opens a new one. */
function withComma(arrays: readonly ArgumentArray[], last: number, tight: boolean): readonly ArgumentArray[] {
  const open = arrays.at(-1);
  return open?.to === last ? [...arrays.slice(0, -1), { from: open.from, to: last + 1, tight: open.tight && tight }] : [...arrays, { from: last, to: last + 1, tight }];
}

/**
 * An array with a gap as the arguments its line reads as: measured, its elements stand apart and an empty one adds no
 * blank, so only an array of nothing but empty values keeps the one blank every argument writes.
 */
function gappedArguments(elements: readonly ShellWord[]): readonly (readonly ShellWord[])[] {
  const filled = elements.filter((element) => element.text !== '');
  return filled.length === 0 ? [[]] : filled.map((element) => [element]);
}

/**
 * `words` from `start` up to `end` as arguments, each the elements of one. An array that opens before `start` holds the
 * head, so it joins nothing. A word the NUL dropped leaves `to` past the last word, and the slice stops there.
 */
function argumentsOf(words: readonly ShellWord[], start: number, end: number, arrays: readonly ArgumentArray[]): readonly (readonly ShellWord[])[] {
  const args: (readonly ShellWord[])[] = [];
  let at = start;
  while (at < end) {
    const array = arrays.find((candidate) => candidate.from === at);
    const next = array === undefined ? at + 1 : array.to + 1;
    const elements = words.slice(at, next);
    args.push(...(array === undefined || array.tight ? [elements] : gappedArguments(elements)));
    at = next;
  }
  return args;
}

/** The text of PowerShell's verbatim marker, for the parser and the binder alike. */
const MARKER = '--%';

/** The `markers` the binder takes: past the head at `start` and outside every array; see {@link nativeCommand}. */
function boundMarkers(markers: readonly number[], start: number, arrays: readonly ArgumentArray[]): readonly number[] {
  return markers.filter((at) => at >= start && !arrays.some((array) => array.from <= at && at <= array.to));
}

/**
 * A command's words as 5.1 hands them to a native program; see {@link nativeWords}. The parser's `--%` is not on the real
 * line, but it stays a word here, as the plain reading keeps it: the binder leaves it as written, so readings that agree
 * still fold. Every head counts, a cmdlet's too: a word cannot tell the two apart, and a fork only adds a reading.
 *
 * `markers` are the words whose value is `--%` with no parser marker in them. The binder drops that value, keeps the
 * argument's blank and any `-name:` before it, and writes each later value as {@link bareLine} does. Measured, a head is
 * no such value, nor is an array, whichever element holds it, and a comma after a word is only seen once that word has
 * ended. A whole value of `--%` with a `-name` token right behind it is gone by here: {@link Scanner.readList} reads the
 * pair as the parser's marker, so `text` opens where that value stood and only an earlier value's blank stays.
 */
function nativeCommand(words: readonly ShellWord[], text: VerbatimText | undefined, arrays: readonly ArgumentArray[], markers: readonly number[], runtime: CRuntime): readonly ShellWord[] {
  const start = argumentsAt(words);
  if (start === undefined) {
    return words;
  }
  const end = text?.at ?? words.length;
  const dropped = new Set(boundMarkers(markers, start, arrays));
  const line = words.map((word, at) => (dropped.has(at) ? { text: word.text.slice(0, -MARKER.length), dynamic: false } : word));
  const bareAt = Math.min(end, ...dropped);
  const written = [...bareLine(argumentsOf(line, bareAt, end, arrays)), ...(text === undefined ? [] : verbatimLine(text.units))];
  return [...words.slice(0, start), ...nativeWords(argumentsOf(line, start, bareAt, arrays), written, runtime)];
}

/** Characters bash expands in unquoted text: a glob, or `~` for a home folder. */
const EXPANDS = /[*?[~]/;

/** A bash word whose text is its value: nothing in it is only known when it runs, and no unquoted text expands. */
export function isStaticWord(word: ShellWord): boolean {
  return !word.dynamic && word.parts !== undefined && word.parts.every((part) => part.kind === 'text' && (part.quoted || !EXPANDS.test(part.text)));
}

/** How a piece of a word was written: unquoted text, quoted or escaped text, or something only known when it runs. */
type Piece = 'unquoted' | 'quoted' | 'dynamic';

/** A bash variable reference with nothing else in it: `$NAME` or `${NAME}`. */
const PLAIN_VARIABLE = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/;

/**
 * The head of a bash `${...}`: a `#` (length) or `!` (indirection) prefix, the parameter, a name with an
 * optional `[@]`, `[*]` or plain index such as `[0]` (arithmetic with nothing to run or assign), and the
 * operator after it, or `[` when another subscript follows.
 */
const BRACED_HEAD = /^\$\{([#!]?)([A-Za-z_]\w*(?:\[(?:[@*]|\d+)\])?|\d+|[@*#?$!-])?(:[-=+?]?|[-=+?]|##?|%%?|\/[/#%]?|\^\^?|,,?|@[A-Za-z]?|\[|\})?/;

/** Text that holds a bash command substitution: `$(` or a backtick. */
const SUBSTITUTION = /\$\(|`/;

/** The `${NAME@X}` transforms that never expand the value again: quoting, escapes, attributes and case. */
const PLAIN_TRANSFORM = /^@[QEAaUuLKk]$/;

/**
 * Whether a bash `${...}` can assign a variable as it expands: `=` and `:=` assign, a substring offset and an
 * array subscript other than a plain index are arithmetic, and indirection and `@P` expand a value the line
 * does not show. The
 * expansions in its word count on their own, as they are read.
 */
function bracedMayAssign(written: string): boolean {
  const head = BRACED_HEAD.exec(written);
  const prefix = head?.[1];
  const parameter = head?.[2];
  const operator = head?.[3];
  if (parameter === undefined || operator === undefined || prefix === '!') {
    return true;
  }
  if (prefix === '#') {
    return operator !== '}';
  }
  return ['=', ':=', ':', '['].includes(operator) || (operator.startsWith('@') && !PLAIN_TRANSFORM.test(operator));
}

/** The word being read: its text so far, whether anything dynamic went in, its bash parts and brace-list hints. */
class WordBuilder {
  private text = '';
  /** The text kept as written, every piece but the dynamic ones; see {@link ShellWord.held}. */
  private literal = '';
  private dynamic = false;
  private started = false;
  private brace = false;
  private braceList = false;
  /** The parts so far; undefined once a piece is dynamic but not a plain variable. */
  private parts: WordPart[] | undefined = [];
  private cut = false;
  private readonly tracksParts: boolean;
  private readonly cutsAtNul: boolean;

  /** `cutsAtNul`: the word's value ends at a NUL, and what comes after it in the word is read but adds nothing. */
  constructor(tracksParts: boolean, cutsAtNul = false) {
    this.tracksParts = tracksParts;
    this.cutsAtNul = cutsAtNul;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** True once a NUL ended the word's value. */
  get isCut(): boolean {
    return this.cut;
  }

  get value(): string {
    return this.text;
  }

  get isDynamic(): boolean {
    return this.dynamic;
  }

  /** Adds text; a piece read through a quote or an escape is `quoted`, as is any text outside bash. */
  add(chars: string, piece: Piece = 'quoted'): void {
    if (this.cut) {
      return;
    }
    const nul = this.cutsAtNul ? chars.indexOf('\0') : -1;
    const kept = nul === -1 ? chars : chars.slice(0, nul);
    this.cut = nul !== -1;
    this.text += kept;
    this.literal += piece === 'dynamic' ? '' : kept;
    this.started = true;
    this.dynamic ||= piece === 'dynamic';
    if (this.parts !== undefined) {
      this.parts = piece === 'dynamic' ? undefined : withText(this.parts, kept, piece === 'quoted');
    }
  }

  /** Adds a `$` expansion as written; a plain variable stays a part, `quoted` inside double quotes or an expanding body. */
  addDollar(written: string, quoted: boolean): void {
    if (this.cut) {
      return;
    }
    this.text += written;
    this.started = true;
    this.dynamic = true;
    if (this.parts !== undefined) {
      this.parts = withVariable(this.parts, written, quoted);
    }
  }

  /** Notes an unquoted bash character: `{a,b}` and `{1..3}` expand to several words, so such a word is dynamic. */
  noteBrace(char: string): void {
    if (char === '{') {
      this.brace = true;
    } else if (this.brace && (char === ',' || (char === '.' && this.text.endsWith('.')))) {
      this.braceList = true;
    }
  }

  take(): ShellWord | undefined {
    const word = this.started ? this.word() : undefined;
    this.text = '';
    this.literal = '';
    this.dynamic = false;
    this.started = false;
    this.brace = false;
    this.braceList = false;
    this.parts = [];
    this.cut = false;
    return word;
  }

  /** The word read so far, even an empty one, such as a heredoc's empty body. */
  word(): ShellWord {
    const held = this.tracksParts && SUBSTITUTION.test(this.literal) ? { held: this.literal } : {};
    const word = { text: this.text, dynamic: this.dynamic || this.braceList, ...held };
    return this.tracksParts && this.parts !== undefined && !this.braceList ? { ...word, parts: this.parts } : word;
  }
}

/** `parts` with `text` added, joined to the last part when that is text quoted the same way. */
function withText(parts: WordPart[], text: string, quoted: boolean): WordPart[] {
  if (text === '') {
    return parts;
  }
  const last = parts.at(-1);
  if (last?.kind === 'text' && last.quoted === quoted) {
    return [...parts.slice(0, -1), { kind: 'text', text: last.text + text, quoted }];
  }
  return [...parts, { kind: 'text', text, quoted }];
}

/** `parts` with a `$` expansion added: a plain variable reference, or undefined for anything else. */
function withVariable(parts: WordPart[], written: string, quoted: boolean): WordPart[] | undefined {
  const match = PLAIN_VARIABLE.exec(written);
  const name = match?.[1] ?? match?.[2];
  return name === undefined ? undefined : [...parts, { kind: 'variable', name, quoted }];
}

/** Where a scanner sits: how deep in substitutions, which bash subshells it is inside, and the shared subshell counter. */
interface ScanScope {
  readonly nesting: number;
  readonly subshells: number[];
  readonly ids: { next: number };
}

/**
 * Reads a command line the way bash, PowerShell or cmd splits it: quotes group words, an unquoted separator
 * ends a command (`; & | ( )` and a newline, `{ }` in PowerShell, only `& | ( )` in cmd), `#` at a word start
 * begins a comment (bash and PowerShell), and a redirection is kept apart from the words with its target. A
 * variable, `$(...)`, backticks (bash), `@(...)` (PowerShell) or `%VAR%` (cmd) leave the word dynamic, and the
 * commands inside a substitution are read too. PowerShell's `&` call operator is kept as a word at a command's
 * start. A bash heredoc's body, after the newline that ends its line, is its command's stdin, not commands
 * (the substitutions an unquoted one expands are read); a PowerShell here-string is one word. A PowerShell word
 * that starts with a quote, a here-string, `$(` or `@(` ends where that closes, so what touches it is a new word.
 * In PowerShell a `( )`, `{ }` or `@{ }` among a command's arguments is one more word, not a group, with its commands
 * read; each value takes a chain of members and indexes, and a `-name:` token takes the value that touches it. Where a
 * NUL cuts a word, what follows it is still read, as a substitution there runs and a separator still applies.
 */
class Scanner {
  private index = 0;
  private complete = true;
  private skipped = false;
  private nesting: number;
  private readonly commands: ScannedCommand[] = [];
  /** bash heredocs opened since the last newline, in order. */
  private readonly heredocs: OpenHeredoc[] = [];
  private readonly unreadBodies: ShellWord[] = [];
  private bindingsUnclear = false;
  /** How many bash `${...}`, `$((...))` and `$[...]` or PowerShell `[...]` the reader is inside, bounded like substitutions. */
  private expansions = 0;
  private readonly subshells: number[];
  private readonly ids: { next: number };
  private readonly reading: Reading;
  private readonly source: string;
  private readonly dialect: ShellDialect;

  constructor(reading: Reading, dialect: ShellDialect, scope: ScanScope) {
    this.reading = reading;
    this.source = reading.source;
    this.dialect = dialect;
    this.nesting = scope.nesting;
    this.subshells = scope.subshells;
    this.ids = scope.ids;
  }

  parse(): ShellParse {
    return this.scan();
  }

  /** Reads the whole source as expandable text; the commands are those of the substitutions in it. */
  parseExpandable(): ShellParse {
    this.readExpandable(new WordBuilder(true), this.source.length);
    return this.result();
  }

  /** Reads the whole source; its commands stay open to the separators an enclosing scanner adds after them. */
  private scan(): ShellParse & { readonly commands: ScannedCommand[] } {
    this.readList();
    return this.result();
  }

  /** What the reader found so far. */
  private result(): ShellParse & { readonly commands: ScannedCommand[] } {
    return { commands: this.commands, complete: this.complete, skipped: this.skipped, unreadBodies: this.unreadBodies, bindingsUnclear: this.bindingsUnclear };
  }

  /** Notes text the reader leaves unread that may hold commands; see {@link ShellParse.skipped}. */
  private skip(): void {
    this.complete = false;
    this.skipped = true;
  }

  /** Adds separator characters to the command read last, if any. */
  private addTerminator(chars: string): void {
    const last = this.commands.at(-1);
    if (last !== undefined) {
      last.terminator += chars;
    }
  }

  private at(offset = 0): string {
    return this.source.charAt(this.index + offset);
  }

  private get done(): boolean {
    return this.index >= this.source.length;
  }

  private openSubshell(): void {
    this.subshells.push(this.ids.next);
    this.ids.next += 1;
  }

  /**
   * Reads commands to the end or, inside a substitution or a PowerShell block, through the `close` that ends it. `hash`
   * says the list is a `@{ }`, whose entries open with a key.
   */
  private readList(close?: ')' | '}', hash = false): void {
    const powershell = this.dialect === 'powershell';
    let words: ShellWord[] = [];
    const word = new WordBuilder(this.dialect === 'bash', this.reading.nul !== 'kept');
    /** The operator of a redirection whose target is the next word. */
    let awaiting: string | undefined;
    let verbatim = false;
    /** PowerShell: true from a comma to the word it adds: measured, a `--%` that is an array's element marks nothing. */
    let element = false;
    /** True once a NUL ended this command's line: the words after it never reach the program. */
    let lineCut = false;
    let verbatimText: VerbatimText | undefined;
    /** PowerShell: where the last word ended, as a comma right there leaves no gap. */
    let wordEnd = -1;
    /** PowerShell: the arrays of this command's words. */
    let arrays: readonly ArgumentArray[] = [];
    /** PowerShell: this command's words that are the binder's `--%`; see {@link nativeCommand}. */
    let markers: number[] = [];
    /** 5.1's line: true right behind a whole value of `--%`, where a `-name` token turns on the parser's marker after all. */
    let tokenNext = false;
    let redirections: Redirection[] = [];
    let depth = 0;
    /** PowerShell: how many `{ }` of keywords are open here, so `{if (1) {a}}` closes at its last `}`. */
    let blocks = 0;
    /** PowerShell: where the value of a `-name:` token opens, which joins the token's word. */
    let valueAt = -1;
    /** PowerShell: how much of the word being read is a `-name:` token, so what follows in it is the token's value. */
    let tokenLength = 0;
    /** PowerShell: true from a `-name:` token that ended with no value to the word it takes as one, past the gap. */
    let valueNext = false;
    /** True at a `@{ }` entry's start, where its key and `=` come before its statement. */
    let keyNext = hash;
    const atEntry = (): boolean => hash && depth === 0 && blocks === 0;
    /** The depth a bash `((` arithmetic command opened at: inside it `<<` shifts and starts no heredoc. */
    let arithmetic: number | undefined;
    /**
     * The command a `( )` group closed on, until the command after its `)` ends: redirections there belong
     * to the group, so they join that command, as those after a `{ }` group's `}` join the `}` command.
     */
    let closedGroup: ScannedCommand | undefined;

    /** 5.1's line: this command's `markers` the binder takes; none in any other reading. */
    const takenMarkers = (): readonly number[] => {
      const start = this.reading.nativeLine === undefined ? undefined : argumentsAt(words);
      return start === undefined ? [] : boundMarkers(markers, start, arrays);
    };
    /**
     * A word the NUL left empty is no argument, as the line ends before it: `x <NUL> a` hands the program nothing. Measured:
     * behind the binder's `--%` a NUL cuts only its own value, so `'--%' "a`0b" c` still hands over `c`.
     */
    const addWord = (taken: ShellWord, cut: boolean): void => {
      const endsLine = cut && this.reading.nul === 'line' && takenMarkers().length === 0;
      if (!lineCut && !(endsLine && taken.text === '')) {
        words.push(taken);
      }
      lineCut ||= endsLine;
    };
    /** `quoted` says the word is one quoted value, whose text is only text to the parser. */
    const endWord = (quoted = false): void => {
      const cut = word.isCut;
      const taken = word.take();
      const token = tokenLength;
      tokenLength = 0;
      if (taken === undefined) {
        return;
      }
      tokenNext = false;
      if (awaiting === undefined) {
        const at = words.length;
        addWord(taken, cut);
        wordEnd = this.index;
        const marks = powershell && taken.text.slice(token) === MARKER && !taken.dynamic && !cut && !element;
        // Measured: a value or quoted text is no marker for the parser, so `x -y: --% a;b` runs `b`. The binder goes by the
        // value, and it never sees a word the cut dropped.
        const parserSkips = quoted || valueNext || token > 0;
        if (marks && parserSkips && words.length > at) {
          markers.push(at);
          // Measured: a marker that is a `-name:` token's value never does it, so `-x: '--%' -y:a` stays the binder's. That
          // leaves the quoted word of `parserSkips`.
          tokenNext = !valueNext && token === 0 && takenMarkers().includes(at);
        }
        // Set on a word the cut dropped too: the shell still reads the rest as written.
        verbatim = marks && !parserSkips;
        // Measured: a `-name:` taken as a value takes none itself, so `x -y: -z: --% a;b` runs no `b`.
        valueNext = !valueNext && this.index === valueAt;
        element = false;
        return;
      }
      redirections.push({ operator: awaiting, target: taken });
      awaiting = undefined;
    };
    const endCommand = (): void => {
      endWord();
      if (awaiting !== undefined) {
        redirections.push({ operator: awaiting });
        awaiting = undefined;
      }
      verbatim = false;
      element = false;
      valueNext = false;
      tokenNext = false;
      lineCut = false;
      const { nativeLine } = this.reading;
      const command: ScannedCommand | undefined =
        words.length > 0 || (redirections.length > 0 && closedGroup === undefined)
          ? {
              words: nativeLine === undefined ? words : nativeCommand(words, verbatimText, arrays, markers, nativeLine),
              subshells: [...this.subshells],
              terminator: '',
              redirections,
              nesting: this.nesting,
            }
          : undefined;
      verbatimText = undefined;
      arrays = [];
      markers = [];
      if (command !== undefined) {
        this.commands.push(command);
      } else {
        closedGroup?.redirections.push(...redirections);
      }
      closedGroup = undefined;
      // A heredoc on a line of redirections alone has no reader: its body is one of the unread ones.
      this.openHeredocs(words.length > 0 ? command : undefined, redirections, arithmetic === undefined);
      words = [];
      redirections = [];
    };

    while (!this.done) {
      if (verbatim) {
        const at = words.length;
        const cut = lineCut;
        const units = this.readVerbatim(addWord);
        verbatimText = { at, units: cut ? [] : units };
        verbatim = false;
        continue;
      }
      if (keyNext) {
        keyNext = false;
        this.readHashKey();
        continue;
      }
      const char = this.at();
      if (char === close && (close === '}' ? blocks : depth) === 0) {
        this.index += 1;
        endCommand();
        return;
      }
      const bareToken = tokenNext && !word.isStarted ? this.parameterEnd(BARE_PARAMETER) : undefined;
      if (bareToken !== undefined) {
        // Measured: the marker and the token both leave the line, and the rest is text, `;` included. Blanks, comments and
        // gaps may sit between them, and none of those ends a word, so `tokenNext` outlives them. The text runs to the end
        // of the command, whose `endCommand` clears it.
        words.pop();
        markers.pop();
        this.index = bareToken;
        verbatim = true;
        continue;
      }
      const parameter = powershell && !word.isStarted ? this.parameterEnd(PARAMETER) : undefined;
      if (parameter !== undefined) {
        word.add(this.source.slice(this.index, parameter), 'unquoted');
        this.index = parameter;
        if (element) {
          // Measured: past a comma the token ends at its colon, and what follows is the next argument, out of the array.
          endWord();
        } else {
          valueAt = parameter;
          tokenLength = word.value.length;
        }
        continue;
      }
      if (word.isStarted && this.index === valueAt && this.opensValueGap(char)) {
        // Measured: the token's word ends here, and the next word is its value, as past a blank.
        endWord();
        continue;
      }
      const opening = powershell && (!word.isStarted || this.index === valueAt);
      const whole = opening && this.opensWholeWord(char);
      const variable = opening && char === '$';
      const inArguments = words.length > 0 || awaiting !== undefined;
      if (this.readQuoteOrExpansion(word, opening)) {
        if (whole) {
          this.readMembers(word);
          // `--'%'` opens no whole word, so it stays the parser's marker.
          endWord(true);
        } else if (variable && word.isDynamic && (this.readMembers(word) || this.at() === '.') && inArguments) {
          // At a head the word goes on: `$h.a=git push` is an assignment, read from one word. A dot with no name after
          // it starts a word of its own, as a quote's does: `$v. b` reaches a program as three words.
          endWord();
        }
        continue;
      }
      if (this.endsLine(char)) {
        endCommand();
        // Written as a newline whichever character it was: the guards find a pipe across lines by `\n` alone.
        this.addTerminator('\n');
        this.index += 1;
        this.readHeredocBodies();
        keyNext = atEntry();
        continue;
      }
      if (powershell && this.atBlock() && (opening || char !== '@')) {
        if (this.index !== valueAt) {
          endWord();
        }
        if (verbatim) {
          continue;
        }
        if (char === '@' || this.index === valueAt || awaiting !== undefined || takesArguments(words, char)) {
          const start = this.index;
          this.readBlock();
          word.add(this.source.slice(start, this.index), 'dynamic');
          this.readMembers(word);
          endWord();
          continue;
        }
      }
      if (char === '(') {
        endCommand();
        this.addTerminator(char);
        if (this.dialect === 'bash' && this.at(1) === '(') {
          this.bindingsUnclear = true;
          arithmetic ??= depth;
        }
        depth += 1;
        if (this.dialect === 'bash') {
          this.openSubshell();
        }
      } else if (char === ')') {
        endCommand();
        this.addTerminator(char);
        if (depth > 0) {
          depth -= 1;
          if (this.dialect === 'bash') {
            this.subshells.pop();
          }
          closedGroup = this.commands.at(-1);
        }
        if (depth === arithmetic) {
          arithmetic = undefined;
        }
      } else if (!word.isStarted && this.isCallOperator(char, words)) {
        words.push({ text: '&', dynamic: false });
      } else if (this.isSeparator(char)) {
        endCommand();
        this.addTerminator(char);
        blocks += char === '{' ? 1 : char === '}' ? -1 : 0;
        keyNext = char === ';' && atEntry();
      } else if (char === '#' && !word.isStarted && this.dialect !== 'cmd') {
        this.skipComment();
        continue;
      } else if (this.opensRedirection(char, word)) {
        if (this.readProcessSubstitution(word)) {
          continue;
        }
        // Measured: `'--%' 2>&1 -y:a b` keeps its token, and the descriptor's word below ends with no `endWord`.
        tokenNext = false;
        // A file-descriptor number (`2>`), PowerShell's `*>` or bash's `{NAME}>` belongs to the redirection.
        const named = this.dialect === 'bash' && /^\{[A-Za-z_]\w*\}$/.test(word.value);
        let descriptor = '';
        if (char !== '&' && word.isStarted && (named || DESCRIPTOR.test(word.value))) {
          descriptor = word.value;
          word.take();
          this.bindingsUnclear ||= named;
        } else {
          endWord();
        }
        if (awaiting !== undefined) {
          redirections.push({ operator: awaiting });
        }
        const start = this.index;
        const targeted = this.readRedirection();
        const operator = descriptor + this.source.slice(start, this.index + 1);
        awaiting = targeted ? operator : undefined;
        if (!targeted) {
          redirections.push({ operator });
        }
      } else if (BLANKS[this.dialect].test(char)) {
        endWord();
      } else if (char === ',' && this.dialect === 'powershell') {
        // An unquoted comma builds an array. Here each element is a word, as pwsh 7.3 and later hands it on (reasoned, no
        // pwsh on this host); measured, 5.1 joins an array with no gap into one argument, which `arrays` keeps for its line.
        endWord();
        if (verbatim) {
          // Measured: a `--%`'s text starts right behind it, so the comma is the program's: `--%,b` hands it `,b`.
          continue;
        }
        const touchesWord = wordEnd === this.index;
        // Measured: the next element may sit past line ends and comments. A comma that builds no array there is a parse
        // error, so nothing runs and no second statement hides behind it.
        element = true;
        tokenNext = false;
        this.index += 1;
        const next = this.index;
        this.skipGaps();
        arrays = withComma(arrays, words.length - 1, touchesWord && this.index === next);
        continue;
      } else if (char === '@' && this.dialect === 'cmd' && words.length === 0 && !word.isStarted) {
        // cmd's `@` before a command only hides its echo.
      } else if (char === ']' && powershell && !word.isStarted) {
        // Measured: a `]` first is a word of its own, so `]--no-verify` hands the program two words.
        word.add(char, 'unquoted');
        this.index += 1;
        endWord();
        continue;
      } else if (char === '\0' && powershell) {
        // Measured: a NUL outside quotes ends the word and leads the next one.
        endWord();
        word.add(char, 'unquoted');
      } else {
        if (this.dialect === 'bash') {
          word.noteBrace(char);
        }
        word.add(char, 'unquoted');
      }
      this.index += 1;
      if (powershell && (char === ')' || char === '}')) {
        // `(1).a = git push` and `{x}.a = git push` run their right side: the chain is the target's, no program.
        this.readMembers(word);
      }
    }
    endCommand();
    if (close !== undefined || depth > 0) {
      this.complete = false;
    }
    if (this.dialect === 'bash') {
      this.subshells.length = Math.max(0, this.subshells.length - depth);
    }
  }

  /**
   * Notes the bash heredocs among a command's redirections, whose bodies follow the next newline, and gives
   * the command a here-string as stdin: its last input redirection decides what it reads. A delimiter only
   * known when it runs opens no heredoc, so the lines after it stay commands.
   */
  private openHeredocs(command: ScannedCommand | undefined, redirections: readonly Redirection[], heredocsOpen: boolean): void {
    if (this.dialect !== 'bash') {
      return;
    }
    const input = redirections.findLast((redirection) => /^0?</.test(redirection.operator));
    if (command !== undefined && input?.operator.endsWith('<<<') === true && input.target !== undefined) {
      command.stdin = input.target;
    }
    for (const redirection of redirections) {
      const target = redirection.target;
      if (!heredocsOpen || !/^\d*<<-?$/.test(redirection.operator)) {
        continue;
      }
      if (target !== undefined && !target.dynamic && target.text !== '') {
        const quoted = target.parts?.some((part) => part.kind === 'text' && part.quoted) === true;
        this.heredocs.push({ delimiter: target.text, tabbed: redirection.operator.endsWith('-'), expands: !quoted, reader: redirection === input ? command : undefined });
      } else {
        this.bindingsUnclear = true;
      }
    }
  }

  /**
   * After a newline: reads the body of each bash heredoc opened before it, through the first line that is its
   * delimiter, as bash finds it. A body is its reader's stdin; an unquoted one expands, so the
   * substitutions in it are read as commands, placed before the reader. A delimiter that never comes leaves
   * the lines as commands, so a stray `<<` cannot hide them.
   */
  private readHeredocBodies(): void {
    for (const heredoc of this.heredocs.splice(0)) {
      const close = this.delimiterLine(heredoc);
      if (close === undefined) {
        this.bindingsUnclear = true;
        return;
      }
      const end = Math.max(this.index, close.start - 1);
      const body = new WordBuilder(true);
      const before = this.commands.length;
      if (heredoc.expands) {
        this.readExpandable(body, end);
      } else {
        body.add(this.source.slice(this.index, end));
      }
      const inner = this.commands.splice(before);
      const at = heredoc.reader === undefined ? this.commands.length : this.commands.indexOf(heredoc.reader);
      this.commands.splice(at, 0, ...inner);
      if (heredoc.reader === undefined) {
        this.unreadBodies.push(body.word());
      } else {
        heredoc.reader.stdin = body.word();
      }
      this.index = Math.max(this.index, close.next);
    }
  }

  /**
   * The first line from the cursor that is exactly the heredoc's delimiter, after leading tabs for `<<-`, as
   * bash requires: where it starts, and where the next line starts. A line with other blanks or a `\r` does
   * not close it.
   */
  private delimiterLine(heredoc: OpenHeredoc): { readonly start: number; readonly next: number } | undefined {
    let start = this.index;
    for (const line of this.source.slice(this.index).split('\n')) {
      if ((heredoc.tabbed ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
        return { start, next: Math.min(start + line.length + 1, this.source.length) };
      }
      start += line.length + 1;
    }
    return undefined;
  }

  /**
   * Expandable text through `end`: an unquoted heredoc's body or a PowerShell `@"` here-string. Quotes are
   * plain text; variables and substitutions expand, and the commands inside a substitution are read.
   */
  private readExpandable(word: WordBuilder, end: number): void {
    word.add('');
    while (this.index < end) {
      const char = this.at();
      if (this.dialect === 'bash' && char === '\\' && /[\\$`\n]/.test(this.at(1))) {
        word.add(this.at(1) === '\n' ? '' : this.at(1));
        this.index += 2;
      } else if (this.dialect === 'powershell' && char === '`') {
        this.readPowerShellEscape(word);
      } else if (char === '$') {
        this.readDollar(word, true);
      } else if (this.dialect === 'bash' && char === '`') {
        this.readBackticks(word);
      } else {
        word.add(char);
        this.index += 1;
      }
    }
    this.complete &&= this.index === end;
  }

  /**
   * PowerShell, where a word's value opens: true at what ends the word when it closes, a quote, a here-string, `$(` or
   * `@(`, so `"a"--flag` is two words. A variable, a number or a splat first stays one word, as text in the middle of a
   * word does. `( )`, `{ }` and `@{ }` end theirs too, read by {@link readBlock}.
   */
  private opensWholeWord(char: string): boolean {
    if (this.dialect !== 'powershell') {
      return false;
    }
    const substitution = (char === '$' || char === '@') && this.at(1) === '(';
    return substitution || this.isSingleQuote(char) || this.isDoubleQuote(char) || (char === '@' && this.hereStringBody() !== undefined);
  }

  /** At `@`: where the body of a PowerShell here-string starts, when `@` and a quote mark end their line and so open one. */
  private hereStringBody(): number | undefined {
    const quote = this.at(1);
    if (!this.isSingleQuote(quote) && !this.isDoubleQuote(quote)) {
      return undefined;
    }
    const opener = new RegExp(`${BLANKS.powershell.source}*(?:\\r\\n?|\\n)`, 'y');
    opener.lastIndex = this.index + 2;
    return opener.test(this.source) ? opener.lastIndex : undefined;
  }

  /**
   * PowerShell `@'...'@` (literal) and `@"..."@` (expandable), whose body opens at `start`: the lines up to the first
   * line that starts with a mark of the opener's class and `@`, with no blank before it. One that never closes takes
   * the rest.
   */
  private readHereString(word: WordBuilder, start: number): void {
    const expands = this.isDoubleQuote(this.at(1));
    const closing = new RegExp(`(?:\\r\\n?|\\n)${(expands ? POWERSHELL_QUOTES.double : POWERSHELL_QUOTES.single).source}@`, 'g');
    // From the opener's own line end, so an empty body closes on it.
    closing.lastIndex = start - 1;
    const close = closing.exec(this.source);
    const end = close === null ? this.source.length : Math.max(start, close.index);
    this.index = start;
    if (expands) {
      this.readExpandable(word, end);
    } else {
      word.add(this.source.slice(start, end));
    }
    this.complete &&= close !== null;
    this.index = close === null ? this.source.length : Math.max(this.index, close.index + close[0].length);
  }

  /** PowerShell's `&` at a command's start, or an assignment's right side, calls the program named next; elsewhere `&` separates commands. */
  private isCallOperator(char: string, words: readonly ShellWord[]): boolean {
    return this.dialect === 'powershell' && char === '&' && this.at(1) !== '&' && this.at(-1) !== '&' && (words.length === 0 || assignedWords(words)?.length === 0);
  }

  /**
   * True at what starts a redirection. In PowerShell `<` and `>` are word text inside a word, measured on its parser
   * (T2002): `a>b c` hands the program `a>b` and `c`. Only `>` gives way to a word of a descriptor alone: `2>x` redirects,
   * where `1<x` and `*<#x y` hand the program those words whole, and a `#` behind that `<` opens no comment (T2003).
   */
  private opensRedirection(char: string, word: WordBuilder): boolean {
    if (char === '<' || char === '>') {
      return this.dialect !== 'powershell' || !word.isStarted || (char === '>' && DESCRIPTOR.test(word.value));
    }
    return this.isOutputAndErrorRedirection(char);
  }

  /** bash `&>` and `&>>` send stdout and stderr to a file: a redirection, where `&&>` and `|&>` end a command first. */
  private isOutputAndErrorRedirection(char: string): boolean {
    return this.dialect === 'bash' && char === '&' && this.at(1) === '>' && this.at(-1) !== '&' && this.at(-1) !== '|';
  }

  /** A newline ends a statement in every shell, and in PowerShell so does a lone CR. */
  private endsLine(char: string): boolean {
    return char === '\n' || (char === '\r' && this.dialect === 'powershell');
  }

  private isSingleQuote(char: string): boolean {
    return this.dialect === 'powershell' ? POWERSHELL_QUOTES.single.test(char) : char === "'";
  }

  private isDoubleQuote(char: string): boolean {
    return this.dialect === 'powershell' ? POWERSHELL_QUOTES.double.test(char) : char === '"';
  }

  private isSeparator(char: string): boolean {
    switch (this.dialect) {
      case 'bash':
        return char === ';' || char === '|' || (char === '&' && !this.isOutputAndErrorRedirection(char));
      case 'powershell':
        return char === ';' || char === '&' || char === '|' || char === '{' || char === '}';
      case 'cmd':
        return char === '&' || char === '|';
    }
  }

  /** Reads a quote, an escape or an expansion at the cursor into `word`; false when the cursor holds none. */
  private readQuoteOrExpansion(word: WordBuilder, opening: boolean): boolean {
    switch (this.dialect) {
      case 'bash':
        return this.readBashQuote(word);
      case 'powershell':
        return this.readPowerShellQuote(word, opening);
      case 'cmd':
        return this.readCmdQuote(word);
    }
  }

  private readBashQuote(word: WordBuilder): boolean {
    const char = this.at();
    if (char === '$' && this.at(1) === "'") {
      this.index += 1;
      this.readAnsiCQuoted(word);
    } else if (char === '$' && this.at(1) === '"') {
      this.index += 1;
      this.readDoubleQuoted(word);
    } else if (char === "'") {
      this.readSingleQuoted(word);
    } else if (char === '"') {
      this.readDoubleQuoted(word);
    } else if (char === '\\') {
      this.readEscape(word);
    } else if (char === '`') {
      this.readBackticks(word);
    } else if (char === '$') {
      this.readDollar(word, false);
    } else {
      return false;
    }
    return true;
  }

  /** `opening` is true where a word's value may open: a here-string or an `@(` only opens there, `a@(b)` being text and a value. */
  private readPowerShellQuote(word: WordBuilder, opening: boolean): boolean {
    const char = this.at();
    const hereStringBody = char === '@' && opening ? this.hereStringBody() : undefined;
    if (this.isSingleQuote(char)) {
      this.readSingleQuoted(word);
    } else if (this.isDoubleQuote(char)) {
      this.readDoubleQuoted(word);
    } else if (char === '`') {
      this.readPowerShellEscape(word);
    } else if (char === '$') {
      this.readDollar(word, false);
    } else if (hereStringBody !== undefined) {
      this.readHereString(word, hereStringBody);
    } else if (char === '@' && ((this.at(1) === '(' && opening) || (/[A-Za-z_]/.test(this.at(1)) && !word.isStarted))) {
      this.readSplatOrArray(word);
    } else if (char === '<' && this.at(1) === '#' && !word.isStarted) {
      this.skipBlockComment();
    } else {
      return false;
    }
    return true;
  }

  private readCmdQuote(word: WordBuilder): boolean {
    const char = this.at();
    if (char === '"') {
      this.readDoubleQuoted(word);
    } else if (char === '^') {
      this.readEscape(word);
    } else if (char === '%' || char === '!') {
      this.readCmdVariable(word);
    } else {
      return false;
    }
    return true;
  }

  /** `'...'`: literal; in PowerShell a doubled mark inside keeps its second. An unclosed quote takes the rest of the line. */
  private readSingleQuoted(word: WordBuilder): void {
    this.index += 1;
    let text = '';
    while (!this.done) {
      const char = this.at();
      if (this.isSingleQuote(char)) {
        if (this.dialect === 'powershell' && this.isSingleQuote(this.at(1))) {
          text += this.at(1);
          this.index += 2;
          continue;
        }
        this.index += 1;
        word.add(text);
        return;
      }
      text += char;
      this.index += 1;
    }
    word.add(text);
    this.complete = false;
  }

  /**
   * bash `$'...'`, in bash's two steps: the closing quote is the first one no backslash hides, then the text between is
   * decoded on its own. They disagree on `\c\'`, whose decoding takes the backslash the search paired with the quote.
   */
  private readAnsiCQuoted(word: WordBuilder): void {
    this.index += 1;
    const start = this.index;
    while (!this.done && this.at() !== "'") {
      this.index += this.at() === '\\' ? 2 : 1;
    }
    word.add(ansiCValue(this.source.slice(start, this.index)));
    if (this.done) {
      this.complete = false;
    }
    this.index += 1;
  }

  /** `"..."`: expansions inside stay dynamic; bash escapes with `\`, PowerShell with a backtick or a doubled mark, which keeps its second, cmd not at all. */
  private readDoubleQuoted(word: WordBuilder): void {
    this.index += 1;
    word.add('');
    while (!this.done) {
      const char = this.at();
      if (this.isDoubleQuote(char)) {
        if (this.dialect === 'powershell' && this.isDoubleQuote(this.at(1))) {
          word.add(this.at(1));
          this.index += 2;
          continue;
        }
        this.index += 1;
        return;
      }
      if (this.dialect === 'cmd' && char === '\n') {
        // cmd ends the line here, quote or no quote: left in place, it ends the command too.
        return;
      }
      if (this.dialect === 'bash' && char === '\\' && /["\\$`\n]/.test(this.at(1))) {
        word.add(this.at(1) === '\n' ? '' : this.at(1));
        this.index += 2;
      } else if (this.dialect === 'powershell' && char === '`') {
        this.readPowerShellEscape(word);
      } else if (this.dialect !== 'cmd' && char === '$') {
        this.readDollar(word, true);
      } else if (this.dialect === 'bash' && char === '`') {
        this.readBackticks(word);
      } else if (this.dialect === 'cmd' && (char === '%' || char === '!')) {
        this.readCmdVariable(word);
      } else {
        word.add(char);
        this.index += 1;
      }
    }
    this.complete = false;
  }

  /**
   * The escape character (`\` or `^`) keeps the next character; before a newline it joins the lines, or leaves the
   * newline to end the line where the reading says so. With nothing after it, cmd drops its caret and bash keeps its
   * backslash.
   */
  private readEscape(word: WordBuilder): void {
    const next = this.at(1);
    if (next === '\n') {
      this.index += this.reading.caretLine === 'ends' ? 1 : 2;
      return;
    }
    if (next === '' && this.dialect === 'cmd') {
      this.index += 1;
      return;
    }
    word.add(next === '' ? this.at() : next);
    this.index += 2;
  }

  /**
   * At a backtick: the text of a `u{hex}` and where it ends, in a reading that takes one. Anything else there is an
   * error on pwsh, so nothing runs and the letter stands.
   */
  private matchCodePoint(): { readonly text: string; readonly end: number } | undefined {
    const end = this.reading.codePoints ? this.matchEnd(CODE_POINT) : undefined;
    if (end === undefined) {
      return undefined;
    }
    const value = Number.parseInt(this.source.slice(this.index + '`u{'.length, end - 1), 16);
    return value > MAX_CODE_POINT ? undefined : { text: String.fromCodePoint(value), end };
  }

  /**
   * PowerShell's backtick, measured on 5.1 (T2002). Between words it continues the line, whichever line end follows, and
   * before a blank it is only a gap: `a <backtick> b` is the words `a` and `b`. In a word or quotes it keeps ONE character,
   * so `a<backtick><CR><LF>b c` is the word `a<CR>`, then the LF ends the statement and `b c` runs. With nothing after it,
   * or a NUL, the backtick stays. pwsh alone also reads a code point.
   */
  private readPowerShellEscape(word: WordBuilder): void {
    const next = this.at(1);
    if (!word.isStarted && this.escapesGap()) {
      this.index += next === '\r' && this.at(2) === '\n' ? 3 : 2;
      return;
    }
    if (next === '' || next === '\0') {
      word.add(this.at());
      this.index += 1;
      return;
    }
    const codePoint = this.matchCodePoint();
    if (codePoint !== undefined) {
      word.add(codePoint.text);
      this.index = codePoint.end;
      return;
    }
    word.add(POWERSHELL_ESCAPES.get(next) ?? next);
    this.index += 2;
  }

  /**
   * At `$`: a substitution `$(...)` (its commands are read too), arithmetic `$((...))` or bash `$[...]`, `${...}`
   * or a variable, kept as written and dynamic; `quoted` inside double quotes or an expanding body. A `$` that
   * starts none of them is literal.
   */
  private readDollar(word: WordBuilder, quoted: boolean): void {
    const start = this.index;
    const next = this.at(1);
    const variable = this.dialect === 'powershell' ? this.matchEnd(VARIABLE) : undefined;
    if (next === '(' && this.dialect === 'bash' && this.at(2) === '(') {
      this.index += 3;
      this.readArithmetic('(', ')', 2, quoted);
      this.bindingsUnclear = true;
    } else if (next === '[' && this.dialect === 'bash') {
      this.index += 2;
      this.readArithmetic('[', ']', 1, quoted);
      this.bindingsUnclear = true;
    } else if (next === '(') {
      this.index += 2;
      this.readSubstitution();
    } else if (next === '{' && this.dialect === 'bash') {
      this.readBraced(quoted);
      this.bindingsUnclear ||= bracedMayAssign(this.source.slice(start, this.index));
    } else if (next === '{') {
      const close = this.source.indexOf('}', this.index + 2);
      this.complete &&= close !== -1;
      this.index = close === -1 ? this.source.length : close + 1;
    } else if (this.dialect === 'bash' && /[A-Za-z_]/.test(next)) {
      this.index += 1;
      while (/\w/.test(this.at())) {
        this.index += 1;
      }
    } else if (this.dialect === 'bash' && /[0-9@*#?$!-]/.test(next)) {
      this.index += 2;
    } else if (variable !== undefined) {
      this.index = variable;
    } else {
      word.add('$');
      this.index += 1;
      return;
    }
    word.addDollar(this.source.slice(start, this.index), quoted);
  }

  /**
   * bash, at `${`: reads through the first `}` that no quote, escape or substitution holds, and the commands of
   * a substitution inside, as in `${B:-$(git branch --show-current)}`. Inside double quotes or an expanding body
   * (`quoted`) single quotes still hold a `}` but are kept as text, and expansions inside them may run, so a
   * single-quoted piece there that holds anything but plain text is not read with confidence.
   */
  private readBraced(quoted: boolean): void {
    if (!this.enterExpansion()) {
      return;
    }
    const inner = new WordBuilder(false);
    this.index += 2;
    while (!this.done && this.at() !== '}') {
      const char = this.at();
      if (!quoted) {
        if (!this.readBashQuote(inner)) {
          this.index += 1;
        }
      } else if (char === "'") {
        const close = this.source.indexOf("'", this.index + 1);
        if (close === -1 || /[}"$`\\]/.test(this.source.slice(this.index + 1, close))) {
          this.skip();
        }
        this.index = close === -1 ? this.source.length : close + 1;
      } else if (char === '"') {
        this.readDoubleQuoted(inner);
      } else if (char === '\\') {
        this.index += 2;
      } else if (char === '$') {
        this.readDollar(inner, true);
      } else if (char === '`') {
        this.readBackticks(inner);
      } else {
        this.index += 1;
      }
    }
    this.complete &&= !this.done;
    this.index = Math.min(this.index + 1, this.source.length);
    this.expansions -= 1;
  }

  /**
   * Inside `$(`, `@(`, `<(` or a PowerShell value: reads the commands through the `close` that ends it; in bash they run
   * in a subshell.
   */
  private readSubstitution(close: ')' | '}' = ')', hash = false): void {
    if (this.nesting >= MAX_NESTING) {
      this.skip();
      this.index = this.source.length;
      return;
    }
    this.nesting += 1;
    if (this.dialect === 'bash') {
      this.openSubshell();
    }
    this.readList(close, hash);
    if (this.dialect === 'bash') {
      this.subshells.pop();
    }
    this.nesting -= 1;
  }

  /**
   * Reads to the `close` that brings `depth` open brackets to zero, as in `$((1 + (2)))` or `$[a[1]]`, and the
   * commands of the substitutions inside, which run before the sum. A single quote there is an error bash may
   * read past, so a line with one is not read with confidence.
   */
  private readArithmetic(open: string, close: string, depth: number, quoted: boolean): void {
    if (!this.enterExpansion()) {
      return;
    }
    const inner = new WordBuilder(false);
    let left = depth;
    while (!this.done && left > 0) {
      const char = this.at();
      if (char === '$') {
        this.readDollar(inner, quoted);
      } else if (char === '`') {
        this.readBackticks(inner);
      } else if (char === '"') {
        this.readDoubleQuoted(inner);
      } else if (char === '\\') {
        this.index += 2;
      } else {
        this.complete &&= char !== "'";
        left += char === open ? 1 : char === close ? -1 : 0;
        this.index += 1;
      }
    }
    this.complete &&= left === 0;
    this.expansions -= 1;
  }

  /** Counts one more expansion or PowerShell expression the reader is inside; false, with the line unreadable, when they nest too deep. */
  private enterExpansion(): boolean {
    if (this.expansions >= MAX_NESTING) {
      this.skip();
      this.index = this.source.length;
      return false;
    }
    this.expansions += 1;
    return true;
  }

  /** bash backticks: the commands inside are read as their own line, in a subshell; the word keeps them as written. */
  private readBackticks(word: WordBuilder): void {
    const start = this.index;
    let inner = '';
    this.index += 1;
    while (!this.done && this.at() !== '`') {
      if (this.at() === '\\' && /[`\\$]/.test(this.at(1))) {
        this.index += 1;
      }
      inner += this.at();
      this.index += 1;
    }
    if (this.done) {
      this.complete = false;
    } else {
      this.index += 1;
    }
    if (this.nesting >= MAX_NESTING) {
      this.skip();
    } else {
      const subshells = [...this.subshells, this.ids.next];
      this.ids.next += 1;
      const nested = new Scanner(plainReading(inner), 'bash', { nesting: this.nesting + 1, subshells, ids: this.ids }).scan();
      this.commands.push(...nested.commands);
      this.unreadBodies.push(...nested.unreadBodies);
      this.complete &&= nested.complete;
      this.skipped ||= nested.skipped;
      this.bindingsUnclear ||= nested.bindingsUnclear;
    }
    word.add(this.source.slice(start, this.index), 'dynamic');
  }

  /** bash `<(...)` and `>(...)`: a process substitution, read like `$(...)`; false at a plain redirection. */
  private readProcessSubstitution(word: WordBuilder): boolean {
    if (this.dialect !== 'bash' || this.at(1) !== '(' || word.isStarted) {
      return false;
    }
    const start = this.index;
    this.index += 2;
    this.readSubstitution();
    word.add(this.source.slice(start, this.index), 'dynamic');
    return true;
  }

  /** PowerShell `@(...)` (read like `$(...)`) or a splatted `@args`; both are dynamic. */
  private readSplatOrArray(word: WordBuilder): void {
    const start = this.index;
    if (this.at(1) === '(') {
      this.index += 2;
      this.readSubstitution();
    } else {
      this.index += 1;
      while (/\w/.test(this.at())) {
        this.index += 1;
      }
    }
    word.add(this.source.slice(start, this.index), 'dynamic');
  }

  /** Where the sticky `pattern` ends when it matches at the cursor. */
  private matchEnd(pattern: RegExp): number | undefined {
    pattern.lastIndex = this.index;
    return pattern.test(this.source) ? pattern.lastIndex : undefined;
  }

  /** Where the `-name` token `pattern` reads ends at the cursor, if this reading opens one; see {@link Reading.asciiParameters}. */
  private parameterEnd(pattern: RegExp): number | undefined {
    const end = this.matchEnd(pattern);
    return end !== undefined && this.reading.asciiParameters && /[^\0-\x7f]/.test(this.at(1)) ? undefined : end;
  }

  /** PowerShell, right behind a `-name:` token: true at a block comment or a backtick that adds nothing. */
  private opensValueGap(char: string): boolean {
    return (char === '<' && this.at(1) === '#') || (char === '`' && this.escapesGap());
  }

  /** PowerShell: true at a `(`, `{` or `@{`. */
  private atBlock(): boolean {
    const char = this.at();
    return char === '(' || char === '{' || (char === '@' && this.at(1) === '{');
  }

  /** PowerShell, at a `(`, `{` or `@{`: reads the commands inside, which run or may run, like a substitution's. */
  private readBlock(): void {
    const open = this.at();
    this.index += open === '@' ? 2 : 1;
    this.readSubstitution(open === '(' ? ')' : '}', open === '@');
  }

  /** PowerShell: reads a chain of members and indexes into `word`, only known when it runs; true when one is there. */
  private readMembers(word: WordBuilder): boolean {
    const start = this.index;
    let read = false;
    while (this.readMember()) {
      read = true;
    }
    if (read) {
      word.add(this.source.slice(start, this.index), 'dynamic');
    }
    return read;
  }

  /**
   * One link of a chain: `[...]`, or `.` or `::` then a name, a method's `(...)` or `{...}` after it. A dot or a colon
   * with no name after it is plain text: false, the cursor where it was.
   */
  private readMember(): boolean {
    if (this.at() === '[') {
      this.index += 1;
      this.readExpression(']');
      return true;
    }
    const start = this.index;
    this.index += this.at() === '.' ? 1 : this.at() === ':' && this.at(1) === ':' ? 2 : 0;
    if (this.index === start || !this.readMemberName()) {
      this.index = start;
      return false;
    }
    if (this.at() === '(') {
      this.index += 1;
      this.readExpression(')');
    } else if (this.at() === '{') {
      this.readBlock();
    }
    return true;
  }

  /** A member's name: a plain name, a quote, a `(...)` or a variable, whose expression runs. */
  private readMemberName(): boolean {
    const char = this.at();
    if (char === '(') {
      this.readBlock();
      return true;
    }
    if (char === '$' || this.isSingleQuote(char) || this.isDoubleQuote(char)) {
      return this.readPowerShellQuote(new WordBuilder(false), true);
    }
    const end = this.matchEnd(MEMBER_NAME);
    if (end === undefined) {
      return false;
    }
    this.index = end;
    return true;
  }

  /**
   * Inside a PowerShell `[...]` or a method's `(...)`, through the `close`: bare text there is no command, so none is
   * listed, while the quotes, substitutions and blocks in it run. A fresh word each time, as a started one reads `<#` as text.
   */
  private readExpression(close: ']' | ')'): void {
    if (!this.enterExpansion()) {
      return;
    }
    while (!this.done && this.at() !== close) {
      if (this.at() === '#') {
        this.skipComment();
      } else if (this.at() === '[') {
        this.index += 1;
        this.readExpression(']');
      } else if (this.atBlock()) {
        this.readBlock();
      } else if (!this.readPowerShellQuote(new WordBuilder(false), true)) {
        this.index += 1;
      }
    }
    this.complete &&= !this.done;
    this.index = Math.min(this.index + 1, this.source.length);
    this.expansions -= 1;
  }

  /**
   * At a `@{ }` entry: moves past its key and `=`, so the statement after it reads as a command's start, whose words the
   * key would else open. The key may be a quote or a `(...)`, whose commands run. A line that shows no `=` and ran nothing
   * is the next line of the statement before, as in `@{a = b |` and a line under it: the cursor goes back.
   */
  private readHashKey(): void {
    this.skipGaps();
    const start = this.index;
    const listed = this.commands.length;
    while (!this.done && !/[=;}]/.test(this.at()) && !BLANKS.powershell.test(this.at()) && !this.endsLine(this.at())) {
      if (this.atBlock()) {
        this.readBlock();
      } else if (!this.readPowerShellQuote(new WordBuilder(false), true)) {
        this.index += 1;
      }
    }
    this.skipGaps();
    if (this.at() === '=') {
      this.index += 1;
      this.skipGaps();
    } else if (this.commands.length === listed) {
      this.index = start;
    }
  }

  /**
   * Moves past blanks, line ends, comments and a backtick before a blank or a line end, which may sit around a `@{ }`
   * entry's key and `=`, and after a comma.
   */
  private skipGaps(): void {
    while (!this.done) {
      const char = this.at();
      if (char === '#') {
        this.skipComment();
      } else if (char === '<' && this.at(1) === '#') {
        this.skipBlockComment();
      } else if (BLANKS.powershell.test(char) || this.endsLine(char) || (char === '`' && this.escapesGap())) {
        this.index += 1;
      } else {
        return;
      }
    }
  }

  /** PowerShell, at a backtick: true before a blank or a line end, where between words it adds nothing. */
  private escapesGap(): boolean {
    const next = this.at(1);
    return BLANKS.powershell.test(next) || this.endsLine(next);
  }

  /**
   * cmd `%VAR%`, `%1`, `%*`, `%~dp0` and delayed `!VAR!` are dynamic; `%%` is one literal `%`, and a `%` or `!`
   * that starts none of them is literal.
   */
  private readCmdVariable(word: WordBuilder): void {
    const match = /^(?:%%|%~[a-zA-Z]*[0-9]|%[0-9*]|%[^%\s"]+%|![^!\s"]+!)/.exec(this.source.slice(this.index));
    if (match === null) {
      word.add(this.at());
      this.index += 1;
    } else if (match[0] === '%%') {
      word.add('%');
      this.index += 2;
    } else {
      word.add(match[0], 'dynamic');
      this.index += match[0].length;
    }
  }

  /**
   * Moves past a redirection operator; true when a target word follows (`> file`), false when a descriptor
   * does: `2>&1` copies one, `2>&1-` moves it and `2>&-` closes it.
   */
  private readRedirection(): boolean {
    while (/[<>&|]/.test(this.at(1)) || this.dashEndsOperator()) {
      this.index += 1;
    }
    if (this.at() === '-' && this.at(-1) === '&') {
      return false;
    }
    if (this.at() === '&' && /\d/.test(this.at(1))) {
      while (/\d/.test(this.at(1))) {
        this.index += 1;
      }
      if (this.at(1) === '-') {
        this.index += 1;
      }
      return false;
    }
    return true;
  }

  /** Whether the next `-` belongs to the redirection operator: in `<<-` and in `>&-`, not in `>-`, which writes to a file named `-`. */
  private dashEndsOperator(): boolean {
    return this.at(1) === '-' && (this.at() === '&' || (this.at() === '<' && this.at(-1) === '<' && this.at(-2) !== '<'));
  }

  private skipComment(): void {
    while (!this.done && !this.endsLine(this.at())) {
      this.index += 1;
    }
  }

  /** PowerShell `<# ... #>`; an unclosed one runs to the end. */
  private skipBlockComment(): void {
    const close = this.source.indexOf('#>', this.index + 2);
    this.index = close === -1 ? this.source.length : close + 2;
  }

  /**
   * After PowerShell's `--%`: the text up to {@link verbatimEnd} goes to the program as written, with each `%NAME%` left
   * dynamic, so the program's C runtime splits it; see {@link splitLine}. Each word goes to `addWord`, with whether a NUL
   * cut it. Gives the text back, as a quote before the `--%` reaches into it.
   */
  private readVerbatim(addWord: (taken: ShellWord, cut: boolean) => void): readonly LineUnit[] {
    const text = this.verbatimUnits();
    for (const units of splitLine(text, 'ucrt')) {
      const word = new WordBuilder(false, this.reading.nul !== 'kept');
      // An empty pair of quotes is a word too, and it has no unit to start it.
      word.add('');
      for (const unit of units) {
        if (typeof unit === 'string') {
          word.add(unit);
        } else {
          word.add(unit.text, 'dynamic');
        }
      }
      addWord(word.word(), word.isCut);
    }
    return text;
  }

  /** The text after `--%` as a line; see {@link expandedUnits}. */
  private verbatimUnits(): LineUnit[] {
    const end = this.verbatimEnd();
    const units = expandedUnits(this.source.slice(this.index, end));
    this.index = end;
    return units;
  }

  /**
   * Where the text after `--%` ends: a line end, even inside quotes, or a `|` or `&&` outside them. This is the shell
   * looking, not the program, so a curly double quote counts here, and a `%` means nothing: `%a|b%` ends at the `|`.
   */
  private verbatimEnd(): number {
    let inQuotes = false;
    for (let end = this.index; end < this.source.length; end += 1) {
      const char = this.source.charAt(end);
      if (this.endsLine(char) || (!inQuotes && (char === '|' || this.source.startsWith('&&', end)))) {
        return end;
      }
      inQuotes = inQuotes !== this.isDoubleQuote(char);
    }
    return this.source.length;
  }
}
