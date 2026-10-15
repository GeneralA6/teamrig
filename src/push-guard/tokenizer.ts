/** Which shell wrote a command line; it decides the quotes, the escape character and what expands. */
export type ShellDialect = 'bash' | 'powershell' | 'cmd';

/** One word of a simple command, after quote removal. */
export interface ShellWord {
  /** The word's text; a variable or a substitution stays as written, such as `$B` or `$(git branch)`. */
  readonly text: string;
  /** True when part of the word is only known when the shell runs it: a variable, a substitution, a brace list. */
  readonly dynamic: boolean;
}

/** One simple command: a program and its arguments, or a keyword line such as `for x in a b`. */
export interface ShellCommand {
  readonly words: readonly ShellWord[];
  /**
   * The bash subshells it runs in, outermost first: `( )`, `$( )`, backticks and `<( )` each open one, so a
   * `cd` inside never moves the commands after it. Always empty in PowerShell and cmd, where `(` and `$( )`
   * run in the same process.
   */
  readonly subshells: readonly number[];
}

/** The simple commands of a command line, as its shell would split them. */
export interface ShellParse {
  /** Every simple command in order; a substitution's commands come before the command that holds them. */
  readonly commands: readonly ShellCommand[];
  /** False when a quote, a bracket or a substitution never closes, or nesting runs too deep: the line is not read with confidence. */
  readonly complete: boolean;
}

/** A PowerShell here-string: `@'` or `@"` ending its line, through the matching `'@` or `"@` line. */
const HERE_STRING = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g;
/** A bash heredoc start: `<<EOF`, `<<'EOF'`, `<<-EOF`, but not the `<<<` here-string. */
const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g;
/** How deep substitutions may nest before the parse stops and calls itself incomplete. */
const MAX_NESTING = 16;

/**
 * Removes the bodies of bash heredocs and PowerShell here-strings, which are data, not commands. A heredoc
 * whose terminator never appears is kept, so a stray `<<` cannot hide a real command, and so is the body of
 * a heredoc on a line `keepBody` accepts, such as `bash <<EOF`, whose body a shell runs.
 */
export function stripHeredocs(command: string, keepBody: (line: string) => boolean = () => false): string {
  const lines = command.replace(HERE_STRING, "''").split('\n');
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    kept.push(line);
    index += 1;
    if (keepBody(line)) {
      continue;
    }
    for (const match of line.matchAll(HEREDOC_START)) {
      const terminator = match[2];
      const end = lines.findIndex((candidate, at) => at >= index && candidate.replace(/\r$/, '').trim() === terminator);
      if (end === -1) {
        break;
      }
      index = end + 1;
    }
  }
  return kept.join('\n');
}

/** Splits a command line into simple commands the way `dialect` would; see {@link Scanner}. */
export function parseShell(command: string, dialect: ShellDialect): ShellParse {
  return new Scanner(command, dialect, { nesting: 0, subshells: [], ids: { next: 0 } }).parse();
}

/** The word being read: its text so far, whether anything dynamic went in, and bash brace-list hints. */
class WordBuilder {
  private text = '';
  private dynamic = false;
  private started = false;
  private brace = false;
  private braceList = false;

  get isStarted(): boolean {
    return this.started;
  }

  get value(): string {
    return this.text;
  }

  add(chars: string, dynamic = false): void {
    this.text += chars;
    this.started = true;
    this.dynamic ||= dynamic;
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
    const word = this.started ? { text: this.text, dynamic: this.dynamic || this.braceList } : undefined;
    this.text = '';
    this.dynamic = false;
    this.started = false;
    this.brace = false;
    this.braceList = false;
    return word;
  }
}

/** Escapes that bash's `$'...'` quoting turns into one character. */
const ANSI_C_ESCAPES = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['f', '\f'],
  ['v', '\v'],
]);

/** Where a scanner sits: how deep in substitutions, which bash subshells it is inside, and the shared subshell counter. */
interface ScanScope {
  readonly nesting: number;
  readonly subshells: number[];
  readonly ids: { next: number };
}

/**
 * Reads a command line the way bash, PowerShell or cmd splits it: quotes group words, an unquoted separator
 * ends a command (`; & | ( )` and a newline, `{ }` in PowerShell, only `& | ( )` in cmd), `#` at a word start
 * begins a comment (bash and PowerShell), and a redirection is dropped with its target. A variable, `$(...)`,
 * backticks (bash), `@(...)` (PowerShell) or `%VAR%` (cmd) leave the word dynamic, and the commands inside a
 * substitution are read too. PowerShell's `&` call operator is kept as a word at a command's start.
 */
class Scanner {
  private index = 0;
  private complete = true;
  private nesting: number;
  private readonly commands: ShellCommand[] = [];
  private readonly subshells: number[];
  private readonly ids: { next: number };
  private readonly source: string;
  private readonly dialect: ShellDialect;

  constructor(source: string, dialect: ShellDialect, scope: ScanScope) {
    this.source = source;
    this.dialect = dialect;
    this.nesting = scope.nesting;
    this.subshells = scope.subshells;
    this.ids = scope.ids;
  }

  parse(): ShellParse {
    this.readList(false);
    return { commands: this.commands, complete: this.complete };
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

  /** Reads commands to the end or, inside a substitution, through the `)` that closes it. */
  private readList(inSubstitution: boolean): void {
    let words: ShellWord[] = [];
    const word = new WordBuilder();
    let skipTarget = false;
    let verbatim = false;
    let depth = 0;

    const endWord = (): void => {
      const taken = word.take();
      if (taken === undefined) {
        return;
      }
      if (skipTarget) {
        skipTarget = false;
        return;
      }
      words.push(taken);
      verbatim = this.dialect === 'powershell' && taken.text === '--%' && !taken.dynamic;
    };
    const endCommand = (): void => {
      endWord();
      skipTarget = false;
      verbatim = false;
      if (words.length > 0) {
        this.commands.push({ words, subshells: [...this.subshells] });
      }
      words = [];
    };

    while (!this.done) {
      if (verbatim) {
        words.push(...this.readVerbatim());
        verbatim = false;
        continue;
      }
      const char = this.at();
      if (char === ')' && depth === 0 && inSubstitution) {
        this.index += 1;
        endCommand();
        return;
      }
      if (this.readQuoteOrExpansion(word)) {
        continue;
      }
      if (char === '\n') {
        endCommand();
      } else if (char === '(') {
        endCommand();
        depth += 1;
        if (this.dialect === 'bash') {
          this.openSubshell();
        }
      } else if (char === ')') {
        endCommand();
        if (depth > 0) {
          depth -= 1;
          if (this.dialect === 'bash') {
            this.subshells.pop();
          }
        }
      } else if (this.isCallOperator(char, words.length === 0 && !word.isStarted)) {
        words.push({ text: '&', dynamic: false });
      } else if (this.isSeparator(char)) {
        endCommand();
      } else if (char === '#' && !word.isStarted && this.dialect !== 'cmd') {
        this.skipComment();
        continue;
      } else if (char === '<' || char === '>') {
        if (this.readProcessSubstitution(word)) {
          continue;
        }
        // A file-descriptor number (`2>`) or PowerShell's `*>` belongs to the redirection.
        if (word.isStarted && /^(?:\d+|\*)$/.test(word.value)) {
          word.take();
        } else {
          endWord();
        }
        skipTarget = this.readRedirection();
      } else if (/\s/.test(char)) {
        endWord();
      } else if (char === ',' && this.dialect === 'powershell') {
        // An unquoted comma builds an array: each element reaches a native program as its own argument.
        endWord();
      } else if (char === '@' && this.dialect === 'cmd' && words.length === 0 && !word.isStarted) {
        // cmd's `@` before a command only hides its echo.
      } else {
        if (this.dialect === 'bash') {
          word.noteBrace(char);
        }
        word.add(char);
      }
      this.index += 1;
    }
    endCommand();
    if (inSubstitution || depth > 0) {
      this.complete = false;
    }
    if (this.dialect === 'bash') {
      this.subshells.length = Math.max(0, this.subshells.length - depth);
    }
  }

  /** PowerShell's `&` at a command's start calls the program named next; elsewhere `&` separates commands. */
  private isCallOperator(char: string, atCommandStart: boolean): boolean {
    return this.dialect === 'powershell' && char === '&' && this.at(1) !== '&' && this.at(-1) !== '&' && atCommandStart;
  }

  private isSeparator(char: string): boolean {
    switch (this.dialect) {
      case 'bash':
        return char === ';' || char === '&' || char === '|';
      case 'powershell':
        return char === ';' || char === '&' || char === '|' || char === '{' || char === '}';
      case 'cmd':
        return char === '&' || char === '|';
    }
  }

  /** Reads a quote, an escape or an expansion at the cursor into `word`; false when the cursor holds none. */
  private readQuoteOrExpansion(word: WordBuilder): boolean {
    switch (this.dialect) {
      case 'bash':
        return this.readBashQuote(word);
      case 'powershell':
        return this.readPowerShellQuote(word);
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
      this.readDollar(word);
    } else {
      return false;
    }
    return true;
  }

  private readPowerShellQuote(word: WordBuilder): boolean {
    const char = this.at();
    if (char === "'") {
      this.readSingleQuoted(word);
    } else if (char === '"') {
      this.readDoubleQuoted(word);
    } else if (char === '`') {
      this.readEscape(word);
    } else if (char === '$') {
      this.readDollar(word);
    } else if (char === '@' && (this.at(1) === '(' || (/[A-Za-z_]/.test(this.at(1)) && !word.isStarted))) {
      this.readSplatOrArray(word);
    } else if (char === '<' && this.at(1) === '#') {
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

  /** `'...'`: literal; in PowerShell `''` inside is one quote. An unclosed quote takes the rest of the line. */
  private readSingleQuoted(word: WordBuilder): void {
    this.index += 1;
    let text = '';
    while (!this.done) {
      const char = this.at();
      if (char === "'") {
        if (this.dialect === 'powershell' && this.at(1) === "'") {
          text += "'";
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

  /** bash `$'...'`: backslash escapes such as `\n`, `\x41` and `\'` are decoded. */
  private readAnsiCQuoted(word: WordBuilder): void {
    this.index += 1;
    let text = '';
    while (!this.done) {
      const char = this.at();
      if (char === "'") {
        this.index += 1;
        word.add(text);
        return;
      }
      if (char === '\\') {
        text += this.readAnsiCEscape();
        continue;
      }
      text += char;
      this.index += 1;
    }
    word.add(text);
    this.complete = false;
  }

  /** At a backslash inside `$'...'`: decodes one escape and moves past it. */
  private readAnsiCEscape(): string {
    const letter = this.at(1);
    const simple = ANSI_C_ESCAPES.get(letter);
    if (simple !== undefined) {
      this.index += 2;
      return simple;
    }
    const numeric = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|([0-7]{1,3}))/.exec(this.source.slice(this.index + 1));
    if (numeric === null) {
      this.index += 2;
      return letter;
    }
    this.index += 1 + numeric[0].length;
    const [, hex, unicode, octal] = numeric;
    const code = hex !== undefined ? parseInt(hex, 16) : unicode !== undefined ? parseInt(unicode, 16) : parseInt(octal ?? '0', 8);
    return String.fromCodePoint(code);
  }

  /** `"..."`: expansions inside stay dynamic; bash escapes with `\`, PowerShell with a backtick or `""`, cmd not at all. */
  private readDoubleQuoted(word: WordBuilder): void {
    this.index += 1;
    word.add('');
    while (!this.done) {
      const char = this.at();
      if (char === '"') {
        if (this.dialect === 'powershell' && this.at(1) === '"') {
          word.add('"');
          this.index += 2;
          continue;
        }
        this.index += 1;
        return;
      }
      if (this.dialect === 'bash' && char === '\\' && /["\\$`\n]/.test(this.at(1))) {
        word.add(this.at(1) === '\n' ? '' : this.at(1));
        this.index += 2;
      } else if (this.dialect === 'powershell' && char === '`') {
        this.readEscape(word);
      } else if (this.dialect !== 'cmd' && char === '$') {
        this.readDollar(word);
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

  /** The escape character (`\`, a backtick or `^`) keeps the next character; before a newline it joins the lines. */
  private readEscape(word: WordBuilder): void {
    const next = this.at(1);
    if (next === '\n') {
      this.index += 2;
      return;
    }
    if (next === '\r' && this.at(2) === '\n') {
      this.index += 3;
      return;
    }
    word.add(next === '' ? this.at() : next);
    this.index += 2;
  }

  /**
   * At `$`: a substitution `$(...)` (its commands are read too), arithmetic `$((...))`, `${...}` or a variable,
   * kept as written and dynamic. A `$` that starts none of them is literal.
   */
  private readDollar(word: WordBuilder): void {
    const start = this.index;
    const next = this.at(1);
    if (next === '(' && this.dialect === 'bash' && this.at(2) === '(') {
      this.index += 3;
      this.skipParens(2);
    } else if (next === '(') {
      this.index += 2;
      this.readSubstitution();
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
    } else if (this.dialect === 'powershell' && /[\w?$^]/.test(next)) {
      this.index += 1;
      while (/[\w:?$^]/.test(this.at())) {
        this.index += 1;
      }
    } else {
      word.add('$');
      this.index += 1;
      return;
    }
    word.add(this.source.slice(start, this.index), true);
  }

  /** Inside `$(`, `@(` or `<(`: reads the commands through the closing `)`; in bash they run in a subshell. */
  private readSubstitution(): void {
    if (this.nesting >= MAX_NESTING) {
      this.complete = false;
      this.index = this.source.length;
      return;
    }
    this.nesting += 1;
    if (this.dialect === 'bash') {
      this.openSubshell();
    }
    this.readList(true);
    if (this.dialect === 'bash') {
      this.subshells.pop();
    }
    this.nesting -= 1;
  }

  /** Skips to the `)` that brings `depth` open parentheses to zero, as in `$((1 + (2)))`. */
  private skipParens(depth: number): void {
    let open = depth;
    while (!this.done && open > 0) {
      const char = this.at();
      open += char === '(' ? 1 : char === ')' ? -1 : 0;
      this.index += 1;
    }
    this.complete &&= open === 0;
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
      this.complete = false;
    } else {
      const subshells = [...this.subshells, this.ids.next];
      this.ids.next += 1;
      const nested = new Scanner(inner, 'bash', { nesting: this.nesting + 1, subshells, ids: this.ids }).parse();
      this.commands.push(...nested.commands);
      this.complete &&= nested.complete;
    }
    word.add(this.source.slice(start, this.index), true);
  }

  /** bash `<(...)` and `>(...)`: a process substitution, read like `$(...)`; false at a plain redirection. */
  private readProcessSubstitution(word: WordBuilder): boolean {
    if (this.dialect !== 'bash' || this.at(1) !== '(' || word.isStarted) {
      return false;
    }
    const start = this.index;
    this.index += 2;
    this.readSubstitution();
    word.add(this.source.slice(start, this.index), true);
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
    word.add(this.source.slice(start, this.index), true);
  }

  /**
   * cmd `%VAR%`, `%1`, `%*`, `%~dp0` and delayed `!VAR!` are dynamic; `%%` is one literal `%`, and a `%` or `!`
   * that starts none of them is literal.
   */
  private readCmdVariable(word: WordBuilder): void {
    const rest = this.source.slice(this.index);
    const match = /^(?:%%|%~[a-zA-Z]*[0-9]|%[0-9*]|%[^%\s"]+%|![^!\s"]+!)/.exec(rest);
    if (match === null) {
      word.add(this.at());
      this.index += 1;
    } else if (match[0] === '%%') {
      word.add('%');
      this.index += 2;
    } else {
      word.add(match[0], true);
      this.index += match[0].length;
    }
  }

  /** Moves past a redirection operator; true when a target word follows (`> file`), false for `2>&1`. */
  private readRedirection(): boolean {
    while (/[<>&|-]/.test(this.at(1))) {
      this.index += 1;
    }
    if (this.at() === '&' && /\d/.test(this.at(1))) {
      while (/\d/.test(this.at(1))) {
        this.index += 1;
      }
      return false;
    }
    return true;
  }

  private skipComment(): void {
    while (!this.done && this.at() !== '\n') {
      this.index += 1;
    }
  }

  /** PowerShell `<# ... #>`; an unclosed one runs to the end. */
  private skipBlockComment(): void {
    const close = this.source.indexOf('#>', this.index + 2);
    this.index = close === -1 ? this.source.length : close + 2;
  }

  /**
   * After PowerShell's `--%`: the rest of the line up to a newline or `|` goes to the program as written,
   * split on spaces and double quotes, with cmd-style `%VAR%` left dynamic.
   */
  private readVerbatim(): ShellWord[] {
    const words: ShellWord[] = [];
    const word = new WordBuilder();
    const flush = (): void => {
      const taken = word.take();
      if (taken !== undefined) {
        words.push(taken);
      }
    };
    while (!this.done && this.at() !== '\n' && this.at() !== '|') {
      const char = this.at();
      if (char === '"') {
        this.index += 1;
        word.add('');
        while (!this.done && this.at() !== '"' && this.at() !== '\n') {
          word.add(this.at());
          this.index += 1;
        }
        this.index += this.at() === '"' ? 1 : 0;
      } else if (char === '%') {
        this.readCmdVariable(word);
      } else {
        if (/\s/.test(char)) {
          flush();
        } else {
          word.add(char);
        }
        this.index += 1;
      }
    }
    flush();
    return words;
  }
}
