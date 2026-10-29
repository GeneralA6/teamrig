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
   * `cd` inside never moves the commands after it. Always empty in PowerShell and cmd, where `(` and `$( )`
   * run in the same process.
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
  /** How many substitutions (`$( )`, backticks, `<( )`, PowerShell `@( )`) it sits inside: 0 for the line's own commands. */
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
  /** False when a quote, a bracket or a substitution never closes, or text is skipped: the line is not read with confidence. */
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
}

/** How deep substitutions may nest before the parse stops and calls itself incomplete. */
const MAX_NESTING = 16;

/** Splits a command line into simple commands the way `dialect` would; see {@link Scanner}. */
export function parseShell(command: string, dialect: ShellDialect): ShellParse {
  return new Scanner(command, dialect, { nesting: 0, subshells: [], ids: { next: 0 } }).parse();
}

/**
 * The commands bash runs when an expansion reads a word's {@link ShellWord.held} text again: the substitutions
 * in it, read as in an unquoted heredoc's body, where quotes are plain text and a backslash keeps a `$`.
 * bash expands that text left to right, so where it never closes bash stops at the error after running the
 * substitutions before it, which the commands hold; only {@link ShellParse.skipped} text may hide one.
 */
export function parseHeldText(held: string): ShellParse {
  return new Scanner(held, 'bash', { nesting: 0, subshells: [], ids: { next: 0 } }).parseExpandable();
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
  private readonly tracksParts: boolean;

  constructor(tracksParts: boolean) {
    this.tracksParts = tracksParts;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get value(): string {
    return this.text;
  }

  /** Adds text; a piece read through a quote or an escape is `quoted`, as is any text outside bash. */
  add(chars: string, piece: Piece = 'quoted'): void {
    this.text += chars;
    this.literal += piece === 'dynamic' ? '' : chars;
    this.started = true;
    this.dynamic ||= piece === 'dynamic';
    if (this.parts !== undefined) {
      this.parts = piece === 'dynamic' ? undefined : withText(this.parts, chars, piece === 'quoted');
    }
  }

  /** Adds a `$` expansion as written; a plain variable stays a part, `quoted` inside double quotes or an expanding body. */
  addDollar(written: string, quoted: boolean): void {
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
 * begins a comment (bash and PowerShell), and a redirection is kept apart from the words with its target. A
 * variable, `$(...)`, backticks (bash), `@(...)` (PowerShell) or `%VAR%` (cmd) leave the word dynamic, and the
 * commands inside a substitution are read too. PowerShell's `&` call operator is kept as a word at a command's
 * start. A bash heredoc's body, after the newline that ends its line, is its command's stdin, not commands
 * (the substitutions an unquoted one expands are read); a PowerShell here-string is one word.
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
  /** How many bash `${...}`, `$((...))` and `$[...]` the reader is inside, bounded like substitutions. */
  private expansions = 0;
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
    return this.scan();
  }

  /** Reads the whole source as expandable text; the commands are those of the substitutions in it. */
  parseExpandable(): ShellParse {
    this.readExpandable(new WordBuilder(true), this.source.length);
    return this.result();
  }

  /** Reads the whole source; its commands stay open to the separators an enclosing scanner adds after them. */
  private scan(): ShellParse & { readonly commands: ScannedCommand[] } {
    this.readList(false);
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

  /** Reads commands to the end or, inside a substitution, through the `)` that closes it. */
  private readList(inSubstitution: boolean): void {
    let words: ShellWord[] = [];
    const word = new WordBuilder(this.dialect === 'bash');
    /** The operator of a redirection whose target is the next word. */
    let awaiting: string | undefined;
    let verbatim = false;
    let redirections: Redirection[] = [];
    let depth = 0;
    /** The depth a bash `((` arithmetic command opened at: inside it `<<` shifts and starts no heredoc. */
    let arithmetic: number | undefined;
    /**
     * The command a `( )` group closed on, until the command after its `)` ends: redirections there belong
     * to the group, so they join that command, as those after a `{ }` group's `}` join the `}` command.
     */
    let closedGroup: ScannedCommand | undefined;

    const endWord = (): void => {
      const taken = word.take();
      if (taken === undefined) {
        return;
      }
      if (awaiting === undefined) {
        words.push(taken);
        verbatim = this.dialect === 'powershell' && taken.text === '--%' && !taken.dynamic;
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
      const command: ScannedCommand | undefined =
        words.length > 0 || (redirections.length > 0 && closedGroup === undefined)
          ? { words, subshells: [...this.subshells], terminator: '', redirections, nesting: this.nesting }
          : undefined;
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
        this.addTerminator(char);
        this.index += 1;
        this.readHeredocBodies();
        continue;
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
      } else if (this.isCallOperator(char, words.length === 0 && !word.isStarted)) {
        words.push({ text: '&', dynamic: false });
      } else if (this.isSeparator(char)) {
        endCommand();
        this.addTerminator(char);
      } else if (char === '#' && !word.isStarted && this.dialect !== 'cmd') {
        this.skipComment();
        continue;
      } else if (char === '<' || char === '>' || this.isOutputAndErrorRedirection(char)) {
        if (this.readProcessSubstitution(word)) {
          continue;
        }
        // A file-descriptor number (`2>`), PowerShell's `*>` or bash's `{NAME}>` belongs to the redirection.
        const named = this.dialect === 'bash' && /^\{[A-Za-z_]\w*\}$/.test(word.value);
        let descriptor = '';
        if (char !== '&' && word.isStarted && (named || /^(?:\d+|\*)$/.test(word.value))) {
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
        word.add(char, 'unquoted');
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
        this.readEscape(word);
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

  /** At `@`: true when `@'` or `@"` ends its line, which opens a PowerShell here-string. */
  private opensHereString(): boolean {
    const quote = this.at(1);
    const opener = /[ \t]*\r?\n/y;
    opener.lastIndex = this.index + 2;
    return (quote === "'" || quote === '"') && opener.test(this.source);
  }

  /**
   * PowerShell `@'...'@` (literal) and `@"..."@` (expandable): the lines between the opening line and the first
   * line that starts with the closing `'@` or `"@`, blanks before it allowed. One that never closes takes the rest.
   */
  private readHereString(word: WordBuilder): void {
    const quote = this.at(1);
    const start = this.source.indexOf('\n', this.index) + 1;
    const closing = new RegExp(`\\r?\\n[ \\t]*${quote}@`, 'g');
    closing.lastIndex = start - 1;
    const close = closing.exec(this.source);
    const end = close === null ? this.source.length : Math.max(start, close.index);
    this.index = start;
    if (quote === '"') {
      this.readExpandable(word, end);
    } else {
      word.add(this.source.slice(start, end));
    }
    this.complete &&= close !== null;
    this.index = close === null ? this.source.length : Math.max(this.index, close.index + close[0].length);
  }

  /** PowerShell's `&` at a command's start calls the program named next; elsewhere `&` separates commands. */
  private isCallOperator(char: string, atCommandStart: boolean): boolean {
    return this.dialect === 'powershell' && char === '&' && this.at(1) !== '&' && this.at(-1) !== '&' && atCommandStart;
  }

  /** bash `&>` and `&>>` send stdout and stderr to a file: a redirection, where `&&>` and `|&>` end a command first. */
  private isOutputAndErrorRedirection(char: string): boolean {
    return this.dialect === 'bash' && char === '&' && this.at(1) === '>' && this.at(-1) !== '&' && this.at(-1) !== '|';
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
      this.readDollar(word, false);
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
      this.readDollar(word, false);
    } else if (char === '@' && !word.isStarted && this.opensHereString()) {
      this.readHereString(word);
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
   * At `$`: a substitution `$(...)` (its commands are read too), arithmetic `$((...))` or bash `$[...]`, `${...}`
   * or a variable, kept as written and dynamic; `quoted` inside double quotes or an expanding body. A `$` that
   * starts none of them is literal.
   */
  private readDollar(word: WordBuilder, quoted: boolean): void {
    const start = this.index;
    const next = this.at(1);
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

  /** Inside `$(`, `@(` or `<(`: reads the commands through the closing `)`; in bash they run in a subshell. */
  private readSubstitution(): void {
    if (this.nesting >= MAX_NESTING) {
      this.skip();
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

  /** Counts one more bash expansion the reader is inside; false, with the line unreadable, when they nest too deep. */
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
      const nested = new Scanner(inner, 'bash', { nesting: this.nesting + 1, subshells, ids: this.ids }).scan();
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
    const word = new WordBuilder(false);
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
