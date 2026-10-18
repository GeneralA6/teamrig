import { programReads, type ProgramArgument } from './programs.ts';
import { startsWithPrefix, type ReadonlyRules } from './rules.ts';

/**
 * The cmdlets a line may run: they read, print or move the shell's own location. Those that take a script block
 * (ForEach-Object, Where-Object, Sort-Object...) run only blocks written in the line, each checked like the line.
 */
const CMDLETS: ReadonlySet<string> = new Set([
  'get-content',
  'get-childitem',
  'get-item',
  'get-date',
  'get-location',
  'set-location',
  'push-location',
  'pop-location',
  'get-process',
  'test-path',
  'split-path',
  'join-path',
  'resolve-path',
  'select-object',
  'select-string',
  'sort-object',
  'measure-object',
  'group-object',
  'compare-object',
  'foreach-object',
  'where-object',
  'convertfrom-json',
  'convertto-json',
  'convertfrom-csv',
  'convertto-csv',
  'format-table',
  'format-list',
  'out-string',
  'write-output',
  'write-host',
]);

/** The native programs a line may run, under the same argument checks as in bash. */
const NATIVE_PROGRAMS: ReadonlySet<string> = new Set(['git', 'kubectl']);

/** Keywords a statement may start with (`$x = if (...) {...} else {...}`); the groups after them are checked as values. */
const KEYWORDS: ReadonlySet<string> = new Set(['if', 'elseif', 'else']);

/**
 * The methods a line may call: they return a new value and change nothing on the string, date or collection they
 * are called on. Not `Replace`: on a file object (`Get-Item`) it replaces another file.
 */
const METHODS: ReadonlySet<string> = new Set([
  'trim',
  'trimstart',
  'trimend',
  'split',
  'substring',
  'tostring',
  'tolower',
  'toupper',
  'startswith',
  'endswith',
  'contains',
  'indexof',
  'lastindexof',
  'padleft',
  'padright',
  'gettype',
  'adddays',
  'addhours',
  'addminutes',
  'addseconds',
]);

/** Marks a masked string (`<mark><index><mark>`) and a checked group; neither may appear in a line. */
const STRING_MARK = '\u0001';
const GROUP_MARK = '\u0002';
const PAREN = `${GROUP_MARK}p${GROUP_MARK}`;
const BLOCK = `${GROUP_MARK}b${GROUP_MARK}`;
const MASKED_STRING = new RegExp(`${STRING_MARK}(\\d+)${STRING_MARK}`, 'g');

/**
 * Text PowerShell reads in a way the masking below does not: the curly quotes and dashes it takes for `'`, `"` and
 * `-`, line breaks JavaScript does not split on, here-strings, the `function:` drive and anything naming a script
 * block, whose objects run the code they hold.
 */
const UNREAD_TEXT = /[\u0001\u0002\u0085\u2013-\u2015\u2018-\u201e\u2028\u2029]|@['"]|function:|scriptblock/i;

/**
 * Outside strings: escapes, call operators, redirections, comments, static members, stop-parsing, subexpressions
 * and braced variable names, which can name a file (`${C:\x.txt} = ...` writes it).
 */
const UNREAD_SYNTAX = /[`&<>#]|::|--%|\$\(|\$\{|@\(|@\{/;

/** `-as` converts to a type named by a string too: `'C:\x' -as 'IO.StreamWriter'` empties that file. */
const CAST = /-as(?![\w-])/i;

/** A redirection that writes nothing: output thrown away to `$null`, or one stream merged into another (`2>&1`). */
const DISCARDED = /[0-9*]?>>?\s*\$null(?=[\s;|)}]|$)|[0-9*]?>&[0-9]/gi;

/** The clock, the one static member a line may read. */
const CLOCK = /\[\s*(?:System\.)?DateTime\s*\]\s*::\s*(?:UtcNow|Now|Today)\b/gi;

/** `(` opens a group after these and after `if`/`elseif`; after anything else it calls what comes before it. */
const GROUP_OPENERS = /[\s(\[{|;,=!+*/%-]/;
const CONDITION = /(?:^|[^\w$.:-])(?:if|elseif)$/i;
const METHOD_CALL = /\.([A-Za-z_]\w*)$/;

/**
 * Text before a `[` that indexes a value: a `)`, a `]`, or a name not led by `-`. Anywhere else the `[` starts a
 * type, and a cast builds an object from text: `[IO.StreamWriter]'C:\x'` (also after `-eq`) empties that file.
 */
const INDEXED = /(?:[)\]]|(?:^|[^\w-])\w+)$/;

const INNER_GROUP = /\(([^(){}]*)\)|\{([^(){}]*)\}/;
/** `$name =`, `+=` or `-=` at a statement's start. */
const LEADING_ASSIGNMENT = /^\$(\w+)\s*[+-]?=\s*/;
/** The variables PowerShell itself reads: preferences, `$PSDefaultParameterValues` (which can bind any parameter), `$OFS`. */
const SHELL_VARIABLES = /^(?:ps\w*|\w*preference|ofs)$/i;
/** The common parameters that set a variable (`-OutVariable`, `-ov`...), by any prefix PowerShell accepts. */
const VARIABLE_PARAMETER = /^-(?:outv|errorv|warningv|informationv|pipelinev|[oewip]v(?![a-z]))/i;
/** The operators that take a script block as their right-hand side and run it. */
const BLOCK_OPERATORS = /^-[ci]?(?:replace|split)$/i;
/** A value: a variable, a string, a group or a number (a token that only starts with a digit, like `7z`, names a program). */
const VALUE_START = new RegExp(`^(?:\\$|${STRING_MARK}|${GROUP_MARK}|-?\\d+(?:\\.\\d+)?(?:$|\\.\\.|[^\\w.]))`);
/** `@name` as an argument splats an array or table into arguments, which the check never sees. */
const SPLAT = /(?:^|[,:=])@/;
const SCOPED_VARIABLE = /\$(\w+):/g;
const INCREMENT = /^(?:\$\w+\+\+|\+\+\$\w+)$/;
const DECREMENT = /^(?:--|--[A-Za-z][\w-]*(?:=.*)?|\$\w+--|--\$\w+)$/;

interface MaskedString {
  /** The value, escapes resolved where it matters to a program's arguments. */
  readonly text: string;
  /** A double-quoted string with a variable in it. */
  readonly dynamic: boolean;
}

interface Masked {
  readonly text: string;
  readonly strings: readonly MaskedString[];
}

interface Context {
  readonly strings: readonly MaskedString[];
  readonly rules: ReadonlyRules;
}

interface StringRead {
  readonly string: MaskedString;
  readonly next: number;
}

/** A single-quoted string from `start` (after its quote): `''` is a quote; undefined when it never closes. */
function readSingle(line: string, start: number): StringRead | undefined {
  let text = '';
  for (let index = start; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (char === "'" && line.charAt(index + 1) === "'") {
      text += "'";
      index += 1;
    } else if (char === "'") {
      return { string: { text, dynamic: false }, next: index + 1 };
    } else {
      text += char;
    }
  }
  return undefined;
}

/**
 * A double-quoted string from `start`: a backtick escapes the next character, `""` is a quote. Undefined when it
 * never closes or holds a `$(...)` subexpression, which runs inside the quotes.
 */
function readDouble(line: string, start: number): StringRead | undefined {
  let text = '';
  for (let index = start; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (char === '`') {
      text += line.charAt(index + 1);
      index += 1;
    } else if (char === '"' && line.charAt(index + 1) === '"') {
      text += '"';
      index += 1;
    } else if (char === '"') {
      return text.includes('$(') ? undefined : { string: { text, dynamic: text.includes('$') }, next: index + 1 };
    } else {
      text += char;
    }
  }
  return undefined;
}

/** The line with each string replaced by a numbered mark, so the checks below read only code; undefined for an unclosed string. */
function maskStrings(line: string): Masked | undefined {
  const strings: MaskedString[] = [];
  let text = '';
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    const read = char === "'" ? readSingle(line, index + 1) : char === '"' ? readDouble(line, index + 1) : null;
    if (read === undefined) {
      return undefined;
    }
    if (read === null) {
      text += char;
      index += 1;
    } else {
      text += `${STRING_MARK}${strings.length}${STRING_MARK}`;
      strings.push(read.string);
      index = read.next;
    }
  }
  return { text, strings };
}

/**
 * Whether every `(` opens a group or calls a method on the list by its written name: `.'Delete'()`, `$x.$name()`
 * and `$x.Delete.Invoke()` all fail, since the name before their `(` is no listed method.
 */
function callsRead(text: string): boolean {
  for (let index = text.indexOf('('); index !== -1; index = text.indexOf('(', index + 1)) {
    const before = text.slice(0, index);
    if (index === 0 || GROUP_OPENERS.test(text.charAt(index - 1)) || CONDITION.test(before)) {
      continue;
    }
    const method = METHOD_CALL.exec(before)?.[1];
    if (method === undefined || !METHODS.has(method.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** Whether every `[` indexes a value rather than naming a type. */
function bracketsIndex(text: string): boolean {
  for (let index = text.indexOf('['); index !== -1; index = text.indexOf('[', index + 1)) {
    if (!INDEXED.test(text.slice(0, index))) {
      return false;
    }
  }
  return true;
}

/**
 * A token as a native program receives it: dynamic when a variable, group or comma (an array) decides it, or when
 * Windows PowerShell 5.1 passes it as something else. It drops an empty argument (`git -C '' status push` runs
 * push) and quotes one holding a space without escaping a `"` or a final `\` in it, which splits or joins arguments.
 */
function argumentOf(token: string, strings: readonly MaskedString[]): ProgramArgument {
  const marks = [...token.matchAll(MASKED_STRING)].map((match) => strings[Number(match[1])]);
  const text = token.replace(MASKED_STRING, (_match, index: string) => strings[Number(index)]?.text ?? '');
  const unsafeText = text === '' || text.includes('"') || (/\s/.test(text) && text.endsWith('\\'));
  const dynamic = /[$,]/.test(token) || token.includes(GROUP_MARK) || marks.some((string) => string === undefined || string.dynamic) || unsafeText;
  return { text, dynamic, single: !dynamic };
}

/**
 * One token anywhere in a statement: no splat, no scope-qualified variable but `$env:` (`$C:x` names a file), and
 * `++`/`--` only on a plain variable (on a property they can change a file's).
 */
function tokenReads(token: string): boolean {
  if (SPLAT.test(token) || [...token.matchAll(SCOPED_VARIABLE)].some((match) => match[1]?.toLowerCase() !== 'env')) {
    return false;
  }
  if (token.includes('++') && !INCREMENT.test(token)) {
    return false;
  }
  return !token.includes('--') || DECREMENT.test(token);
}

/**
 * An expression statement: no assignment (`$x.Prop = 1`, `$env:PATH=...`; in a command's arguments `=` is text),
 * no bare `--` (a decrement of the value after it), and after a `-replace` or `-split` nothing that could hold a
 * script block, which those operators run.
 */
function expressionReads(tokens: readonly string[]): boolean {
  const operator = tokens.findIndex((token) => BLOCK_OPERATORS.test(token));
  const operands = operator === -1 ? [] : tokens.slice(operator + 1);
  return (
    !tokens.some((token) => token === '--' || token.includes('=')) &&
    operands.every((token) => !token.includes('$') && !token.includes(GROUP_MARK))
  );
}

/**
 * A cmdlet's arguments: words, strings, numbers and parameter names, plus script blocks written in the line. A
 * variable or a group could hold a script block from elsewhere, which a parameter would run; ForEach-Object takes
 * only blocks, since a name there calls that method on every object (`ForEach-Object Delete`). No common parameter
 * that sets a variable.
 */
function cmdletArgumentsRead(cmdlet: string, args: readonly string[]): boolean {
  if (args.some((arg) => VARIABLE_PARAMETER.test(arg))) {
    return false;
  }
  if (cmdlet === 'foreach-object') {
    return args.every((arg) => arg === BLOCK || /^-(?:process|begin|end)$/i.test(arg));
  }
  return args.every((arg) => arg === BLOCK || (!arg.includes('$') && !arg.includes(GROUP_MARK)));
}

/** One pipeline element, its leading keywords stripped: a value, a cmdlet, git or kubectl, or a team-trusted prefix. */
function segmentReads(tokens: readonly string[], context: Context): boolean {
  const start = tokens.findIndex((token) => !KEYWORDS.has(token.toLowerCase()));
  const words = start === -1 ? [] : tokens.slice(start);
  const [first, ...args] = words;
  if (first === undefined || !words.every(tokenReads)) {
    return false;
  }
  if (VALUE_START.test(first)) {
    return expressionReads(words);
  }
  const name = first.toLowerCase();
  if (CMDLETS.has(name)) {
    return cmdletArgumentsRead(name, args);
  }
  const resolved = words.map((token) => argumentOf(token, context.strings));
  if (startsWithPrefix(resolved, context.rules.prefixes)) {
    return true;
  }
  return NATIVE_PROGRAMS.has(name) && programReads(name, resolved.slice(1));
}

/**
 * Statements (split on `;` and line breaks, `\r` alone included) of `|`-separated segments, each read by
 * `segmentReads`. The first segment may assign its value to a variable PowerShell does not read itself. A pipe
 * with nothing on one side is refused.
 */
function statementsRead(text: string, context: Context): boolean {
  let segments = 0;
  for (const statement of text.split(/[;\r\n]/)) {
    const parts = statement.split('|');
    for (const [index, part] of parts.entries()) {
      const trimmed = part.trim();
      const assigned = index === 0 ? LEADING_ASSIGNMENT.exec(trimmed) : null;
      if (assigned?.[1] !== undefined && SHELL_VARIABLES.test(assigned[1])) {
        return false;
      }
      const segment = assigned === null ? trimmed : trimmed.slice(assigned[0].length);
      if (segment === '') {
        if (parts.length > 1) {
          return false;
        }
        continue;
      }
      if (!segmentReads(segment.split(/\s+/), context)) {
        return false;
      }
      segments += 1;
    }
  }
  return segments > 0;
}

/**
 * Whether a PowerShell line only reads. Strings are masked first, so the checks read only code; then the line's
 * groups are checked innermost first, each `( )` and `{ }` as statements of its own, and replaced by a mark,
 * until the statements left are flat.
 */
export function powershellLineReads(line: string, rules: ReadonlyRules): boolean {
  if (line.trim() === '' || UNREAD_TEXT.test(line)) {
    return false;
  }
  const masked = maskStrings(line);
  if (masked === undefined) {
    return false;
  }
  const code = masked.text.replace(DISCARDED, ' ').replace(CLOCK, ' $dt');
  if (UNREAD_SYNTAX.test(code) || CAST.test(code) || !callsRead(code) || !bracketsIndex(code)) {
    return false;
  }
  const context: Context = { strings: masked.strings, rules };
  let flat = code.replace(/\s*\|\s*/g, ' | ');
  for (let group = INNER_GROUP.exec(flat); group !== null; group = INNER_GROUP.exec(flat)) {
    const paren = group[1];
    const inner = (paren ?? group[2] ?? '').trim();
    if (inner !== '' && !statementsRead(inner, context)) {
      return false;
    }
    flat = `${flat.slice(0, group.index)} ${paren === undefined ? BLOCK : PAREN} ${flat.slice(group.index + group[0].length)}`;
  }
  return !/[(){}]/.test(flat) && statementsRead(flat, context);
}
