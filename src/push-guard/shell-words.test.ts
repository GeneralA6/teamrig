import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installCallsOf } from '../package-guard/installs.ts';
import { programsOf } from '../package-guard/programs.ts';
import { bashLineReads } from '../readonly-shell/bash.ts';
import { powershellLineReads } from '../readonly-shell/powershell.ts';
import { prefixWords, type ReadonlyRules } from '../readonly-shell/rules.ts';
import { BLANK_AND_LINE_END_ROWS, ESCAPE_ROWS, EXPRESSION_ROWS, NATIVE_LINE_ROWS, NUL_ROWS, PARAMETER_ROWS, POWERSHELL_BLANKS, POWERSHELL_DOUBLE_QUOTES, POWERSHELL_ESCAPES, POWERSHELL_LINE_ENDS, POWERSHELL_SINGLE_QUOTES, QUOTE_ROWS, VALUE_ROWS, type ShellWordsRow } from '../testing/shell-words.ts';
import { hookSkips } from './hook-skips.ts';
import { findGitInvocations } from './invocations.ts';
import { evaluatePushes, type PushDecision, type RepoState } from './push.ts';
import { parseShell, type ShellDialect, type ShellParse } from './tokenizer.ts';
import { resolveLiteralVariables } from './variables.ts';

const CWD = '/repo';
const HOME = '/u';

const repo: RepoState = {
  branch: () => 'feature',
  head: () => undefined,
  pushTarget: (_dir, branch) => `origin/${branch ?? 'feature'}`,
  config: () => ({ kind: 'unset' }),
};
const readRules: ReadonlyRules = { prefixes: [prefixWords('npx tsc --noEmit')], exported: new Set(['PATH', 'HOME']), exportsAll: false };

/** What each guard answers for a line. */
interface Answers {
  readonly skips: readonly string[];
  readonly push: PushDecision;
  readonly installs: readonly string[];
  readonly programs: readonly string[];
  /** Whether the read-only allow lets the line through; cmd has none. */
  readonly reads: boolean;
}

function answersFor(line: string, dialect: ShellDialect): Answers {
  const place = { cwd: CWD, home: HOME, dialect };
  const found = findGitInvocations(line, { ...place, git: { config: () => ({ kind: 'unset' }) } });
  return {
    skips: hookSkips(found.invocations).map((skip) => `${skip.subcommand}|${skip.by}`),
    push: evaluatePushes(line, { ...place, protectedBranches: ['main', 'master'], pushToProtected: 'ask', repo }).decision,
    installs: installCallsOf(line, place).map(({ call }) => call),
    programs: programsOf(line, place).map((run) => [run.name, ...run.args.map((arg) => arg.text)].join(' ')),
    reads: dialect === 'bash' ? bashLineReads(line, readRules) : dialect === 'powershell' && powershellLineReads(line, readRules),
  };
}

const STRICTNESS: Readonly<Record<PushDecision, number>> = { allow: 0, ask: 1, deny: 2 };

/** Every guard's verdict is at least as strict on the line as typed as on the line it must be judged by. */
function assertVerdictsNoSofter({ dialect, typed, real }: ShellWordsRow): void {
  const seen = answersFor(typed, dialect);
  const truth = answersFor(real, dialect);
  const label = JSON.stringify(typed);
  assert.deepEqual(truth.skips.filter((skip) => !seen.skips.includes(skip)), [], `hook skips of ${label}`);
  assert.ok(STRICTNESS[seen.push] >= STRICTNESS[truth.push], `push of ${label}: ${seen.push}, real ${truth.push}`);
  assert.deepEqual(truth.installs.filter((call) => !seen.installs.includes(call)), [], `installs of ${label}`);
  assert.ok(truth.reads || !seen.reads, `read-only of ${label}`);
}

/** As {@link assertVerdictsNoSofter}, and the line as typed lists every program the real one starts, word for word. */
function assertNoSofter(row: ShellWordsRow): void {
  assertVerdictsNoSofter(row);
  const seen = answersFor(row.typed, row.dialect).programs;
  const missed = answersFor(row.real, row.dialect).programs.filter((run) => !seen.includes(run));
  assert.deepEqual(missed, [], `programs of ${JSON.stringify(row.typed)}`);
}

/** The words of each command. */
function wordsOf(line: string, dialect: ShellDialect): string[][] {
  return parseShell(line, dialect).commands.map((command) => command.words.map((word) => word.text));
}

/** The words of each reading's commands of a PowerShell line, one list per reading; a line that folds has one. */
function readingsOf(line: string): string[][][] {
  const parse = parseShell(line, 'powershell');
  return (parse.readings ?? [parse]).map((reading) => reading.commands.map((command) => command.words.map((word) => word.text)));
}

/** The words of a PowerShell line as its own parser holds them: the plain reading, which comes before 5.1's native ones. */
function plainWordsOf(line: string): string[][] {
  return readingsOf(line)[0] ?? [];
}

describe('the guards read the words the shell runs', () => {
  it('holds on every blank and line end', () => {
    BLANK_AND_LINE_END_ROWS.forEach(assertNoSofter);
  });

  it('holds on every quote, here-string and --% shape', () => {
    QUOTE_ROWS.forEach(assertNoSofter);
  });

  it('holds on every expression argument', () => {
    EXPRESSION_ROWS.forEach(assertNoSofter);
  });

  it('judges a value among the arguments as one word', () => {
    VALUE_ROWS.forEach(assertVerdictsNoSofter);
  });

  it('holds on every backtick', () => {
    ESCAPE_ROWS.forEach(assertNoSofter);
  });

  it('holds on every NUL, code point and caret', () => {
    NUL_ROWS.forEach(assertNoSofter);
  });

  it('holds on a parameter whose first letter 5.1 lacks', () => {
    PARAMETER_ROWS.forEach(assertNoSofter);
  });

  it('holds on the line 5.1 writes for a native program', () => {
    NATIVE_LINE_ROWS.forEach(assertNoSofter);
  });
});

describe('parseShell: blanks, measured on the real shells', () => {
  it('ends a PowerShell word at exactly the units the real parser does', () => {
    const blanks = new Set(POWERSHELL_BLANKS);
    const lineEnds = new Set(POWERSHELL_LINE_ENDS);
    // These act on their own, outside the blanks this table measures: separators and a NUL.
    const apart = new Set([...'\0&(),;{}|']);
    for (let code = 0; code <= 0xffff; code += 1) {
      const unit = String.fromCharCode(code);
      if (apart.has(unit)) {
        continue;
      }
      const expected = blanks.has(unit) ? [['a', 'b']] : lineEnds.has(unit) ? [['a'], ['b']] : undefined;
      const seen = wordsOf(`a${unit}b`, 'powershell');
      if (expected === undefined) {
        assert.equal(seen.flat().length, 1, `U+${code.toString(16)} keeps the word whole`);
      } else {
        assert.deepEqual(seen, expected, `U+${code.toString(16)}`);
      }
    }
  });

  it('reads a PowerShell backtick before a blank as a gap between words, and as that blank in a word', () => {
    for (const blank of POWERSHELL_BLANKS) {
      const unit = `U+${blank.charCodeAt(0).toString(16)}`;
      assert.deepEqual(wordsOf(`x \`${blank}a b`, 'powershell'), [['x', 'a', 'b']], unit);
      assert.deepEqual(wordsOf(`x a,\`${blank}b c`, 'powershell'), [['x', 'a', 'b', 'c']], `${unit} after a comma`);
      assert.deepEqual(wordsOf(`x a\`${blank}b c`, 'powershell'), [['x', `a${blank}b`, 'c']], `${unit} in a word`);
    }
  });

  it('ends a bash or cmd word at a space or a tab alone', () => {
    for (const dialect of ['bash', 'cmd'] as const) {
      assert.deepEqual(wordsOf('a b\tc', dialect), [['a', 'b', 'c']]);
      for (const unit of ['\u000b', '\u000c', '\u0085', '\u00a0', '\u1680', '\u2003', '\u2028', '\u2029', '\u3000', '\ufeff']) {
        assert.deepEqual(wordsOf(`a${unit}b c`, dialect), [[`a${unit}b`, 'c']], `U+${unit.charCodeAt(0).toString(16)} in ${dialect}`);
      }
    }
  });
});

describe('parseShell: a PowerShell -name: token with no value tight behind it', () => {
  it('ends its word at a block comment or a backtick that adds nothing', () => {
    assert.deepEqual(plainWordsOf('x -y:<#c#>z'), [['x', '-y:', 'z']]);
    assert.deepEqual(plainWordsOf(`x -y:<#c#>'a b' c`), [['x', '-y:', 'a b', 'c']]);
    assert.deepEqual(plainWordsOf('x -y:<#c#>`\nz c'), [['x', '-y:', 'z', 'c']]);
    assert.deepEqual(plainWordsOf('x -y:`\n<#c#>z c'), [['x', '-y:', 'z', 'c']]);
    assert.deepEqual(plainWordsOf('x -y:` z c'), [['x', '-y:', 'z', 'c']]);
    assert.deepEqual(plainWordsOf('x -y:`\nz c'), [['x', '-y:', 'z', 'c']]);
  });

  it('keeps an escape that adds a character in the word', () => {
    assert.deepEqual(plainWordsOf('x -y:`z c'), [['x', '-y:z', 'c']]);
  });

  it('takes the next word as its value, so a --% there ends at the statement', () => {
    assert.deepEqual(plainWordsOf('x -y: --% a;b c'), [['x', '-y:', '--%', 'a'], ['b', 'c']]);
    assert.deepEqual(plainWordsOf('x -y: --%;b c'), [['x', '-y:', '--%'], ['b', 'c']]);
    assert.deepEqual(plainWordsOf('x -y: -z: -w: --% a;b c'), [['x', '-y:', '-z:', '-w:', '--%', 'a'], ['b', 'c']]);
  });

  it('leaves a --% the parser marker anywhere else', () => {
    assert.deepEqual(plainWordsOf('x -y: -z: --% a;b c'), [['x', '-y:', '-z:', '--%', 'a;b', 'c']]);
    assert.deepEqual(plainWordsOf('x -y: -z --% a;b c'), [['x', '-y:', '-z', '--%', 'a;b', 'c']]);
    assert.deepEqual(plainWordsOf('x -y: a --% b;c d'), [['x', '-y:', 'a', '--%', 'b;c', 'd']]);
    assert.deepEqual(plainWordsOf(`x -y:'' --% a;b c`), [['x', '-y:', '--%', 'a;b', 'c']]);
    assert.deepEqual(plainWordsOf('x y,-m: --% a;b c'), [['x', 'y', '-m:', '--%', 'a;b', 'c']]);
  });
});

describe('parseShell: PowerShell quotes', () => {
  it('groups a word at exactly the units the real parser does', () => {
    const quotes = new Set([...POWERSHELL_SINGLE_QUOTES, ...POWERSHELL_DOUBLE_QUOTES]);
    for (let code = 0; code <= 0xffff; code += 1) {
      const unit = String.fromCharCode(code);
      const seen = wordsOf(`x${unit}a b${unit}`, 'powershell').flat();
      assert.equal(seen.length === 1, quotes.has(unit), `U+${code.toString(16)} read as ${JSON.stringify(seen)}`);
    }
  });

  it('closes a quote at any mark of its class, and at no mark of the other', () => {
    for (const [marks, other] of [[POWERSHELL_SINGLE_QUOTES, '"'], [POWERSHELL_DOUBLE_QUOTES, "'"]] as const) {
      for (const open of marks) {
        for (const close of marks) {
          assert.deepEqual(wordsOf(`${open}a${other}b${close} c`, 'powershell'), [[`a${other}b`, 'c']]);
        }
      }
    }
  });

  it('keeps the second mark of a doubled pair', () => {
    assert.deepEqual(wordsOf('"a\u201d\u201cb"', 'powershell'), [['a\u201cb']]);
    assert.deepEqual(wordsOf("'a\u2018'b'", 'powershell'), [["a'b"]]);
  });

  it('takes no curly mark for a quote in bash or cmd', () => {
    assert.deepEqual(wordsOf('\u201ca b\u201d', 'bash'), [['\u201ca', 'b\u201d']]);
    assert.deepEqual(wordsOf('\u201ca b\u201d', 'cmd'), [['\u201ca', 'b\u201d']]);
    assert.deepEqual(wordsOf("a\u2019b 'c d'", 'bash'), [['a\u2019b', 'c d']]);
  });
});

describe('parseShell: a PowerShell word ends where what starts it closes', () => {
  it('after a quote', () => {
    assert.deepEqual(wordsOf('x "a"b c', 'powershell'), [['x', 'a', 'b', 'c']]);
    assert.deepEqual(wordsOf('x "a"--flag c', 'powershell'), [['x', 'a', '--flag', 'c']]);
    assert.deepEqual(wordsOf("x 'a'--flag", 'powershell'), [['x', 'a', '--flag']]);
    assert.deepEqual(wordsOf('x "a"\'b\'', 'powershell'), [['x', 'a', 'b']]);
    assert.deepEqual(wordsOf('x \u201ca\u201d--flag', 'powershell'), [['x', 'a', '--flag']]);
  });

  it('after a here-string', () => {
    assert.deepEqual(wordsOf("x @'\nbody\n'@y c", 'powershell'), [['x', 'body', 'y', 'c']]);
  });

  it('after a substitution or an array, leaving the word dynamic', () => {
    const [, line] = parseShell('x $(echo a)--flag c', 'powershell').commands;
    assert.deepEqual(line?.words.map((word) => [word.text, word.dynamic]), [['x', false], ['$(echo a)', true], ['--flag', false], ['c', false]]);
    assert.deepEqual(wordsOf('x @(1)--flag', 'powershell').at(-1), ['x', '@(1)', '--flag']);
    assert.deepEqual(wordsOf('x $(echo a)"b"', 'powershell').at(-1), ['x', '$(echo a)', 'b']);
  });

  it('keeps a comment after it a comment', () => {
    assert.deepEqual(wordsOf('x "a"#b c', 'powershell'), [['x', 'a']]);
    assert.deepEqual(wordsOf('x $(echo a)#b c', 'powershell').at(-1), ['x', '$(echo a)']);
  });

  it('leaves a word whole when a quote or a substitution comes later in it', () => {
    assert.deepEqual(wordsOf('x a"b"c', 'powershell'), [['x', 'abc']]);
    assert.deepEqual(wordsOf('x -"a b" c', 'powershell'), [['x', '-a b', 'c']]);
    assert.deepEqual(wordsOf('x --y="a b"', 'powershell'), [['x', '--y=a b']]);
    assert.deepEqual(wordsOf('x a$(echo b)--flag', 'powershell').at(-1), ['x', 'a$(echo b)--flag']);
  });

  it('leaves a word whole when a variable, a number or a splat starts it', () => {
    assert.deepEqual(wordsOf('x $v--flag c', 'powershell'), [['x', '$v--flag', 'c']]);
    assert.deepEqual(wordsOf('x $v"b" c', 'powershell'), [['x', '$vb', 'c']]);
    assert.deepEqual(wordsOf('x ${v}--flag', 'powershell'), [['x', '${v}--flag']]);
    assert.deepEqual(wordsOf('x 1"b"', 'powershell'), [['x', '1b']]);
    assert.deepEqual(wordsOf('x @v--flag', 'powershell'), [['x', '@v--flag']]);
  });

  it('keeps to PowerShell: bash and cmd join what touches a closed quote', () => {
    assert.deepEqual(wordsOf('x "a"--flag', 'bash'), [['x', 'a--flag']]);
    assert.deepEqual(wordsOf('x "a"--flag', 'cmd'), [['x', 'a--flag']]);
  });
});

describe('parseShell: PowerShell values among the arguments', () => {
  /** A letter past the first 65,536 units, which 5.1's parser never counted as one: built here to stay plain ASCII. */
  const PAIR = String.fromCodePoint(0x10400);

  it('reads a ( ), { } or @{ } as one word, with its commands before the command holding it', () => {
    assert.deepEqual(wordsOf('a (b c) d', 'powershell'), [['b', 'c'], ['a', '(b c)', 'd']]);
    assert.deepEqual(wordsOf('a {b c} d', 'powershell'), [['b', 'c'], ['a', '{b c}', 'd']]);
    assert.deepEqual(wordsOf('a @{b = c} d', 'powershell'), [['c'], ['a', '@{b = c}', 'd']]);
  });

  it('ends the word where the value closes, and a value that touches text starts a new one', () => {
    assert.deepEqual(wordsOf('a (b)--c', 'powershell'), [['b'], ['a', '(b)', '--c']]);
    assert.deepEqual(wordsOf('a x(b) c', 'powershell'), [['b'], ['a', 'x', '(b)', 'c']]);
    assert.deepEqual(wordsOf('a x{b} c', 'powershell'), [['b'], ['a', 'x', '{b}', 'c']]);
  });

  it('keeps a chain of members and indexes on its value, and ends the word after it', () => {
    assert.deepEqual(wordsOf('a $v.b--c', 'powershell'), [['a', '$v.b', '--c']]);
    assert.deepEqual(wordsOf('a $v::b--c', 'powershell'), [['a', '$v::b', '--c']]);
    assert.deepEqual(wordsOf('a $v[0]--c', 'powershell'), [['a', '$v[0]', '--c']]);
    assert.deepEqual(wordsOf('a "x".b()--c', 'powershell'), [['a', 'x.b()', '--c']]);
    assert.deepEqual(wordsOf('a (b).c--d', 'powershell'), [['b'], ['a', '(b).c', '--d']]);
  });

  it('runs what a member or an index holds', () => {
    assert.deepEqual(wordsOf('a $v.(b)', 'powershell'), [['b'], ['a', '$v.(b)']]);
    assert.deepEqual(wordsOf('a $v[(b)]', 'powershell'), [['b'], ['a', '$v[(b)]']]);
    assert.deepEqual(wordsOf('a $v.m((b))', 'powershell'), [['b'], ['a', '$v.m((b))']]);
    assert.deepEqual(wordsOf('a $v.m({b})', 'powershell'), [['b'], ['a', '$v.m({b})']]);
  });

  it('leaves a dot with no name after it as text', () => {
    assert.deepEqual(wordsOf('a $v. b', 'powershell'), [['a', '$v', '.', 'b']]);
    assert.deepEqual(wordsOf('a .\\x.ps1 b', 'powershell'), [['a', '.\\x.ps1', 'b']]);
  });

  it('joins a -name: token and the value touching it into one word', () => {
    assert.deepEqual(wordsOf('a -m:"x"--c', 'powershell'), [['a', '-m:x', '--c']]);
    assert.deepEqual(wordsOf('a -m:$v.b--c', 'powershell'), [['a', '-m:$v.b', '--c']]);
    assert.deepEqual(wordsOf('a -m:(b) --c', 'powershell'), [['b'], ['a', '-m:(b)', '--c']]);
    assert.deepEqual(wordsOf('a -m::x', 'powershell'), [['a', '-m::x']]);
  });

  it('takes a ] at a word\'s start as a word of its own', () => {
    assert.deepEqual(wordsOf('a ]--c', 'powershell'), [['a', ']', '--c']]);
    assert.deepEqual(wordsOf('a b]--c', 'powershell'), [['a', 'b]--c']]);
  });

  it('never ends a variable\'s or a parameter\'s word at a surrogate pair, which no table counted as a letter', () => {
    assert.deepEqual(wordsOf(`a $v${PAIR}--c`, 'powershell'), [['a', `$v${PAIR}--c`]]);
    assert.deepEqual(wordsOf(`a -${PAIR}:"x"--c`, 'powershell'), [['a', `-${PAIR}:x--c`]]);
  });

  it('keeps a keyword\'s ( ) and { } as parts of its statement', () => {
    assert.deepEqual(wordsOf('if (a) { b } else { c }', 'powershell'), [['if'], ['a'], [], ['b'], ['else'], ['c']].filter((words) => words.length > 0));
    assert.deepEqual(wordsOf('do {} while (0) b', 'powershell'), [['do'], ['while'], ['0'], ['b']]);
  });

  it('calls a line an unclosed value left open incomplete', () => {
    assert.equal(parseShell('a (b', 'powershell').complete, false);
    assert.equal(parseShell('a {b', 'powershell').complete, false);
    assert.equal(parseShell('a $v[0', 'powershell').complete, false);
    assert.equal(parseShell('a @{b = c', 'powershell').complete, false);
  });
});

describe('parseShell: PowerShell hash literals', () => {
  it('reads each value as a command, its key apart', () => {
    assert.deepEqual(wordsOf('$x = @{a = b c; d = e}', 'powershell'), [['b', 'c'], ['e'], ['$x', '=', '@{a = b c; d = e}']]);
    assert.deepEqual(wordsOf('$x = @{a=b}', 'powershell'), [['b'], ['$x', '=', '@{a=b}']]);
    assert.deepEqual(wordsOf("$x = @{'a' = b}", 'powershell'), [['b'], ['$x', '=', "@{'a' = b}"]]);
  });

  it('opens a new entry on a line of its own', () => {
    assert.deepEqual(wordsOf('$x = @{\n a = b\n c = d\n}', 'powershell').slice(0, 2), [['b'], ['d']]);
  });

  it('reads the line after a pipe as the pipe\'s command, not an entry', () => {
    assert.deepEqual(wordsOf('$x = @{a = b |\n c d}', 'powershell').slice(0, 2), [['b'], ['c', 'd']]);
  });

  it('runs a key in ( )', () => {
    assert.deepEqual(wordsOf('$x = @{(b) = 1}', 'powershell').slice(0, 1), [['b']]);
  });

  it('reads a backtick line end around a key as a gap', () => {
    assert.deepEqual(wordsOf('$x = @{a `\n= b c}', 'powershell').slice(0, 1), [['b', 'c']]);
    assert.deepEqual(wordsOf('$x = @{a = `\nb c}', 'powershell').slice(0, 1), [['b', 'c']]);
    assert.deepEqual(wordsOf('$x = @{`\na = b c}', 'powershell').slice(0, 1), [['b', 'c']]);
  });
});

describe('parseShell: PowerShell redirections and block comments', () => {
  it('keeps < and > as text inside a word', () => {
    for (const text of ['a>b', 'a<b', 'a2>x', 'a>>b', '--flag>b', 'a<b#c', 'a>#b', 'a<', '$v>b', '$v<b', 'a><#x#>b']) {
      assert.deepEqual(parseShell(`p ${text} c`, 'powershell').commands.map((command) => command.redirections), [[]], text);
      assert.deepEqual(wordsOf(`p ${text} c`, 'powershell'), [['p', text, 'c']]);
    }
  });

  it('opens a redirection at a word start or after a descriptor alone', () => {
    for (const [line, operator] of [['p 2>x c', '2>'], ['p *>x c', '*>'], ['p "a">x c', '>'], ['p >x c', '>'], ['p <x c', '<']] as const) {
      const [command] = parseShell(line, 'powershell').commands;
      assert.deepEqual(command?.redirections.map((redirection) => [redirection.operator, redirection.target?.text]), [[operator, 'x']], line);
    }
  });

  it('opens a block comment only at a word start', () => {
    assert.deepEqual(wordsOf('p <#x#>a c', 'powershell'), [['p', 'a', 'c']]);
    assert.deepEqual(wordsOf('p <#x#> a c', 'powershell'), [['p', 'a', 'c']]);
    assert.deepEqual(wordsOf('p a <#x#>b c', 'powershell'), [['p', 'a', 'b', 'c']]);
    assert.deepEqual(wordsOf('p a<#x#>b c', 'powershell'), [['p', 'a<#x#>b', 'c']]);
  });

  it('leaves bash and cmd breaking a word at < and >', () => {
    for (const dialect of ['bash', 'cmd'] as const) {
      assert.deepEqual(wordsOf('p a>b c', dialect), [['p', 'a', 'c']]);
    }
  });
});

describe('parseShell: PowerShell here-strings', () => {
  it('opens after any blanks and any line end', () => {
    for (const blank of ['', ' ', '\u00a0', '\u0085', '\u3000']) {
      for (const lineEnd of ['\n', '\r\n', '\r']) {
        assert.deepEqual(wordsOf(`x @'${blank}${lineEnd}body${lineEnd}'@ y`, 'powershell'), [['x', 'body', 'y']], JSON.stringify([blank, lineEnd]));
      }
    }
  });

  it('opens at any mark of a class and closes at any mark of it', () => {
    for (const [marks, other] of [[POWERSHELL_SINGLE_QUOTES, '"'], [POWERSHELL_DOUBLE_QUOTES, "'"]] as const) {
      for (const open of marks) {
        for (const close of marks) {
          assert.deepEqual(plainWordsOf(`x @${open}\nb\n${other}@\n${close}@ y`), [['x', `b\n${other}@`, 'y']]);
        }
      }
    }
  });

  it('closes an empty body on the line end of its opener', () => {
    for (const lineEnd of ['\n', '\r\n', '\r']) {
      assert.deepEqual(readingsOf(`x @'${lineEnd}'@ y`), [[['x', '', 'y']], [['x', 'y']]], JSON.stringify(lineEnd));
    }
  });

  it('does not close on a mark with a blank before it', () => {
    for (const blank of [' ', '\t', '\u00a0']) {
      const parsed = parseShell(`x @'\n${blank}'@\n'@ y`, 'powershell');
      assert.deepEqual(parsed.commands.map((command) => command.words.map((word) => word.text)), [['x', `${blank}'@`, 'y']]);
      assert.equal(parsed.complete, true);
    }
  });

  it('sees the command after a closer the old reading took for an earlier one', () => {
    assert.deepEqual(wordsOf("x @'\n '@ \"\n'@\nsecond\n# \"", 'powershell'), [['x', ' \'@ "'], ['second']]);
  });

  it('expands only the double class', () => {
    assert.deepEqual(wordsOf('x @\u201c\n$(y)\n\u201d@', 'powershell'), [['y'], ['x', '$(y)']]);
    assert.deepEqual(wordsOf('x @\u2018\n$(y)\n\u2019@', 'powershell'), [['x', '$(y)']]);
  });

  it('opens none where a word has started or text follows the mark', () => {
    assert.deepEqual(wordsOf("x a@'\nb'", 'powershell'), [['x', 'a@\nb']]);
    assert.deepEqual(wordsOf("x @' y\n'@ z", 'powershell'), [['x', '@ y\n@', 'z']]);
  });
});

describe('parseShell: PowerShell --%', () => {
  it('is no marker to the parser in a word a quote starts', () => {
    assert.deepEqual(plainWordsOf("x '--%' a; y"), [['x', '--%', 'a'], ['y']]);
    assert.deepEqual(plainWordsOf('x "--%" a; y'), [['x', '--%', 'a'], ['y']]);
    assert.deepEqual(wordsOf('x "--"% a; y', 'powershell'), [['x', '--', '%', 'a'], ['y']]);
  });

  it('is the marker in every other spelling', () => {
    for (const spelled of ['`--%', '-`-%', '--`%', '-"-%"', '--"%"', "-'-%'", "--'%'", '--""%', '--%""']) {
      assert.deepEqual(wordsOf(`x ${spelled} a; y`, 'powershell'), [['x', '--%', 'a;', 'y']], spelled);
    }
  });

  it('ends at a line end, even inside quotes', () => {
    assert.deepEqual(wordsOf('x --% a\rb c', 'powershell'), [['x', '--%', 'a'], ['b', 'c']]);
    assert.deepEqual(wordsOf('x --% a\nb c', 'powershell'), [['x', '--%', 'a'], ['b', 'c']]);
    assert.deepEqual(wordsOf('x --% "a\rb c', 'powershell'), [['x', '--%', 'a'], ['b', 'c']]);
    assert.deepEqual(wordsOf('x --% "a\nb c', 'powershell'), [['x', '--%', 'a'], ['b', 'c']]);
  });

  it('ends at a | or && outside quotes, and a single & is text', () => {
    assert.deepEqual(wordsOf('x --% a | b', 'powershell'), [['x', '--%', 'a'], ['b']]);
    assert.deepEqual(wordsOf('x --% a && b', 'powershell'), [['x', '--%', 'a'], ['b']]);
    assert.deepEqual(wordsOf('x --% a&b', 'powershell'), [['x', '--%', 'a&b']]);
    assert.deepEqual(wordsOf('x --% "a&&b|c"', 'powershell'), [['x', '--%', 'a&&b|c']]);
  });

  it('takes a curly double quote as a quote when it looks for the end, but groups on a plain one alone', () => {
    assert.deepEqual(wordsOf('x --% \u201ca|b\u201d', 'powershell'), [['x', '--%', '\u201ca|b\u201d']]);
    assert.deepEqual(wordsOf('x --% \u201ca b\u201d c', 'powershell'), [['x', '--%', '\u201ca', 'b\u201d', 'c']]);
  });

  it('splits on a space or a tab alone', () => {
    assert.deepEqual(wordsOf('x --% a\u00a0b\u3000c\u0085d\te', 'powershell'), [['x', '--%', 'a\u00a0b\u3000c\u0085d', 'e']]);
  });

  it('splits the text as the C runtime does, so a backslash keeps a quote from grouping', () => {
    assert.deepEqual(wordsOf('x --% -m a\\" --no-verify', 'powershell'), [['x', '--%', '-m', 'a"', '--no-verify']]);
    assert.deepEqual(wordsOf('x --% a\\\\"b c"', 'powershell'), [['x', '--%', 'a\\b c']]);
    assert.deepEqual(wordsOf('x --% a\\b c', 'powershell'), [['x', '--%', 'a\\b', 'c']]);
    assert.deepEqual(readingsOf('x --% "a""b" c'), [[['x', '--%', 'a"b', 'c']], [['x', '--%', 'a"b c']]]);
  });

  it('keeps an empty pair of quotes as a word', () => {
    assert.deepEqual(wordsOf('x --% "" a', 'powershell'), [['x', '--%', '', 'a']]);
  });

  it('takes no quote or blank from inside a %VAR%, which stays dynamic in its word', () => {
    const [, , ...rest] = parseShell('x --% a%B%c d', 'powershell').commands[0]?.words ?? [];
    assert.deepEqual(rest.map((word) => [word.text, word.dynamic]), [['a%B%c', true], ['d', false]]);
  });

  it('keeps a comma right behind it as the text\'s first character', () => {
    assert.deepEqual(wordsOf('x --%,b c', 'powershell'), [['x', '--%', ',b', 'c']]);
    assert.deepEqual(wordsOf('x --%,\nb c', 'powershell'), [['x', '--%', ','], ['b', 'c']]);
  });

  it('marks nothing as an array\'s element, though it does behind a whole array', () => {
    assert.deepEqual(plainWordsOf('x a,--% b;c d'), [['x', 'a', '--%', 'b'], ['c', 'd']]);
    assert.deepEqual(plainWordsOf('x a, --% b;c d'), [['x', 'a', '--%', 'b'], ['c', 'd']]);
    assert.deepEqual(plainWordsOf('x a,b --% c;d e'), [['x', 'a', 'b', '--%', 'c;d', 'e']]);
    assert.deepEqual(readingsOf('x a,--% b;c d').at(-1), [['x', 'a,--%', 'b'], ['c', 'd']]);
  });

  it('leaves %% and a lone % as they stand: a --% is not cmd', () => {
    assert.deepEqual(wordsOf('x --% a%%b c%', 'powershell'), [['x', '--%', 'a%%b', 'c%']]);
  });

  it('reads none of cmd\'s other forms as a value', () => {
    ['%1', '%*', '%~dp0', '!W!'].forEach((value) => {
      const [, , ...rest] = parseShell(`x --% ${value} c`, 'powershell').commands[0]?.words ?? [];
      assert.deepEqual(rest.map((word) => [word.text, word.dynamic]), [[value, false], ['c', false]]);
    });
  });

  it('reads a %NAME% behind a percent that cannot open it', () => {
    const [, , ...rest] = parseShell('x --% %%W% c', 'powershell').commands[0]?.words ?? [];
    assert.deepEqual(rest.map((word) => [word.text, word.dynamic]), [['%%W%', true], ['c', false]]);
  });

  it('reads %VAR% in quotes too, and never past the end of the text', () => {
    const [, ...rest] = parseShell('x --% "%A%"', 'powershell').commands[0]?.words ?? [];
    assert.deepEqual(rest.map((word) => [word.text, word.dynamic]), [['--%', false], ['%A%', true]]);
    assert.deepEqual(wordsOf('x --% %a|y\u0085z%', 'powershell'), [['x', '--%', '%a'], ['y', 'z%']]);
  });
});

describe('parseShell: the line 5.1 writes for a native program', () => {
  it('folds when the program gets the words as written', () => {
    const parse = parseShell('git commit -m "a b" --amend', 'powershell');
    assert.equal(parse.complete, true);
    assert.equal(parse.readings, undefined);
    assert.deepEqual(wordsOf('git commit -m "a b" --amend', 'powershell'), [['git', 'commit', '-m', 'a b', '--amend']]);
  });

  it('takes no other reading for a line with no mark the line can differ on', () => {
    assert.deepEqual(readingsOf('git commit --amend'), [[['git', 'commit', '--amend']]]);
  });

  it('holds a lone quote swallowing the next word as a reading of its own', () => {
    assert.deepEqual(readingsOf(`git commit 'a"' --verify`), [
      [['git', 'commit', 'a"', '--verify']],
      [['git', 'commit', 'a --verify']],
    ]);
    assert.equal(parseShell(`git commit 'a"' --verify`, 'powershell').complete, false);
  });

  it('drops an empty value, so the word after it moves up', () => {
    assert.deepEqual(readingsOf(`git commit -m '' --verify`), [
      [['git', 'commit', '-m', '', '--verify']],
      [['git', 'commit', '-m', '--verify']],
    ]);
  });

  it('lets one value come apart', () => {
    assert.deepEqual(readingsOf(`git commit 'a\\" --no-verify'`), [
      [['git', 'commit', 'a\\" --no-verify']],
      [['git', 'commit', 'a"', '--no-verify']],
    ]);
  });

  it('reads a trailing backslash on a line that holds no quote', () => {
    assert.deepEqual(readingsOf('git commit a` b\\ c'), [
      [['git', 'commit', 'a b\\', 'c']],
      [['git', 'commit', 'a b" c']],
    ]);
  });

  it('splits by both runtimes, which differ on a doubled quote inside quotes', () => {
    assert.deepEqual(readingsOf(`git commit 'a "" b' c`), [
      [['git', 'commit', 'a "" b', 'c']],
      [['git', 'commit', 'a " b', 'c']],
      [['git', 'commit', 'a "', 'b c']],
    ]);
  });

  it('leaves the head alone, and the program after a & or a dot', () => {
    assert.deepEqual(readingsOf(`& 'a"' b`), [[['&', 'a"', 'b']]]);
    assert.deepEqual(readingsOf(`. 'a"' b`), [[['.', 'a"', 'b']]]);
  });

  it('reads the call on an assignment right side, past a label', () => {
    assert.deepEqual(readingsOf(`$x = git commit 'a"' b`).at(-1), [['$x', '=', 'git', 'commit', 'a b']]);
    assert.deepEqual(readingsOf(`$x=git commit 'a"' b`).at(-1), [['$x=git', 'commit', 'a b']]);
    assert.deepEqual(readingsOf(`:l git commit 'a"' b`).at(-1), [[':l', 'git', 'commit', 'a b']]);
  });

  it('rebuilds nothing for a value alone, a keyword or an expression', () => {
    assert.deepEqual(readingsOf(`$x = 'a"'`), [[['$x', '=', 'a"']]]);
    assert.deepEqual(readingsOf(`$x 'a"' b`), [[['$x', 'a"', 'b']]]);
    assert.deepEqual(readingsOf(`[int] 'a"' b`), [[['[int]', 'a"', 'b']]]);
    assert.deepEqual(readingsOf(`return 'a"' b`).length, 2);
    assert.deepEqual(readingsOf(`foreach 'a"' b`), [[['foreach', 'a"', 'b']]]);
  });

  it('reads a call inside a group and a substitution too', () => {
    assert.ok(readingsOf(`(git commit 'a"' b)`).some((reading) => reading.some((words) => words.includes('a b'))));
    assert.ok(readingsOf(`x $(git commit 'a"' b)`).some((reading) => reading.some((words) => words.includes('a b'))));
  });

  it('reads the text after a --% with the words before it', () => {
    assert.deepEqual(readingsOf(`git commit 'a"' --% " --no-verify`).at(-1), [['git', 'commit', 'a --%  ', '--no-verify']]);
  });

  it('folds a --% line when the words before it open no quote', () => {
    assert.equal(parseShell('git commit --% -m "a b" c', 'powershell').complete, true);
    assert.deepEqual(wordsOf('git commit --% -m "a b" c', 'powershell'), [['git', 'commit', '--%', '-m', 'a b', 'c']]);
  });

  it('adds no text after a NUL cut the words before a --%', () => {
    const native = parseShell('x a\0b --% "c d"', 'powershell').readings?.[0];
    assert.deepEqual(native?.commands.map((command) => command.words.map((word) => word.text)), [['x', 'a']]);
  });

  it('keeps each element of an array a word in the plain reading', () => {
    assert.deepEqual(plainWordsOf('x a,b c'), [['x', 'a', 'b', 'c']]);
  });

  it('joins an array with no gap into one argument', () => {
    const rows: readonly (readonly [string, readonly string[]])[] = [
      ['x a,b c', ['a,b', 'c']],
      [`x 'a b',c d`, ['a b,c', 'd']],
      ['x a,b,c d', ['a,b,c', 'd']],
      [`x a,'',c d`, ['a,c', 'd']],
      [`x '',b c`, ['b', 'c']],
      ['x ],b c', ['],b', 'c']],
      ['x a<#x#>,b c', ['a<#x#>,b', 'c']],
      ['x -m:a,b c', ['-m:a,b', 'c']],
      [`x 'a','b' 'c' ,d e`, ['a,b', 'c', 'd', 'e']],
    ];
    for (const [line, words] of rows) {
      assert.deepEqual(readingsOf(line).at(-1), [['x', ...words]], line);
    }
    // A group's own command comes first; its value is the array's element.
    assert.deepEqual(readingsOf('x (1),b c').at(-1)?.at(-1), ['x', '(1),b', 'c']);
  });

  it('keeps the elements apart when any comma of the array has a gap', () => {
    const rows: readonly (readonly [string, readonly string[]])[] = [
      ['x a ,b c', ['a', 'b', 'c']],
      ['x a, b c', ['a', 'b', 'c']],
      ['x a,b, c d', ['a', 'b', 'c', 'd']],
      ['x a ,b,c d', ['a', 'b', 'c', 'd']],
      ['x a <#x#>,b c', ['a', 'b', 'c']],
      [`x 'a'<#x#>,b c`, ['a', 'b', 'c']],
      ['x a,<#x#>b c', ['a', 'b', 'c']],
      ['x -m:a, b c', ['-m:a', 'b', 'c']],
      ['x a,\nb c', ['a', 'b', 'c']],
    ];
    for (const [line, words] of rows) {
      assert.deepEqual(readingsOf(line).at(-1), [['x', ...words]], line);
    }
  });

  it('writes one blank for an array with a gap, none for its empty elements', () => {
    // A quote keeps the blanks in the word, so these rows show how many the line holds.
    const rows: readonly (readonly [string, string])[] = [
      [`x '"', '', b`, ' b'],
      [`x '', '"', b`, ' b'],
      [`x '"' '','' b`, '  b'],
    ];
    for (const [line, word] of rows) {
      assert.deepEqual(readingsOf(line).at(-1), [['x', word]], line);
    }
  });

  it('ends a -name: token at its colon past a comma, in every reading', () => {
    assert.deepEqual(plainWordsOf('x a,-m:b c'), [['x', 'a', '-m:', 'b', 'c']]);
    const rows: readonly (readonly [string, readonly string[]])[] = [
      ['x a,-m:b', ['a,-m:', 'b']],
      ['x a ,-m:b', ['a', '-m:', 'b']],
      ['x a, -m:b', ['a', '-m:', 'b']],
      ['x -n:a,-m:b', ['-n:a,-m:', 'b']],
      [`x a,-m:'b c'`, ['a,-m:', 'b c']],
      ['x a,-m:b,c', ['a,-m:', 'b,c']],
      ['x a,-m:,b', ['a,-m:,b']],
      ['x a,-m:b,-n:c', ['a,-m:', 'b,-n:', 'c']],
    ];
    for (const [line, words] of rows) {
      assert.deepEqual(readingsOf(line).at(-1), [['x', ...words]], line);
    }
  });

  it('keeps a first element\'s value, and a token that opens no parameter whole', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['x -m:a,b', '-m:a,b'],
      ['x a,--m:b', 'a,--m:b'],
      ['x a,-1:b', 'a,-1:b'],
      ['x a,-:b', 'a,-:b'],
    ];
    for (const [line, word] of rows) {
      assert.deepEqual(readingsOf(line).at(-1), [['x', word]], line);
    }
  });

  it('reads a --% behind a comma\'s -name: token as the parser\'s marker', () => {
    assert.deepEqual(readingsOf('x a,-m:--% b;c d').at(-1), [['x', 'a,-m:', '--%', 'b;c', 'd']]);
  });

  it('joins nothing into the head, and stops an array at a NUL', () => {
    assert.deepEqual(readingsOf('a,b c').at(-1), [['a', 'b', 'c']]);
    assert.deepEqual(parseShell('x a\0b,c d', 'powershell').readings?.[0]?.commands.map((command) => command.words.map((word) => word.text)), [['x', 'a']]);
  });

  it('starts each command with no arrays of the one before', () => {
    assert.deepEqual(readingsOf('x a,b; y c d').at(-1), [['x', 'a,b'], ['y', 'c', 'd']]);
  });

  it('reads the text after a --% behind an array', () => {
    assert.deepEqual(readingsOf('x a,b --% c d').at(-1), [['x', 'a,b', '--%', 'c', 'd']]);
  });
});

describe("parseShell: the binder's --%, a value no parser took as its marker", () => {
  /** Rows of a line and what its head's arguments are in 5.1's last reading. */
  type Row = readonly [string, readonly string[]];

  function assertLastReadings(rows: readonly Row[]): void {
    for (const [line, words] of rows) {
      assert.deepEqual(readingsOf(line).at(-1), [['x', ...words]], line);
    }
  }

  it('drops a whole value and writes what follows bare, so a quoted word comes apart', () => {
    assertLastReadings([
      [`x '--%' 'a b' c`, ['a', 'b', 'c']],
      [`x "--%" 'a b' c`, ['a', 'b', 'c']],
      [`x '--%'`, []],
      [`x '--%' '--%' 'a b' c`, ['a', 'b', 'c']],
      [`x '--%' '' 'a b'`, ['a', 'b']],
    ]);
  });

  it("takes a -name: token's value in any spelling, and keeps the token", () => {
    assertLastReadings([
      [`x -y:--% 'a b' c`, ['-y:', 'a', 'b', 'c']],
      [`x -y:'--%' 'a b' c`, ['-y:', 'a', 'b', 'c']],
      [`x -y:"--%" 'a b' c`, ['-y:', 'a', 'b', 'c']],
      [`x -y:--'%' 'a b' c`, ['-y:', 'a', 'b', 'c']],
    ]);
  });

  it('takes the value past a gap, which the parser leaves alone', () => {
    assertLastReadings([
      [`x -y: --% 'a b' c`, ['-y:', 'a', 'b', 'c']],
      [`x -y: '--%' 'a b' c`, ['-y:', 'a', 'b', 'c']],
    ]);
  });

  it('still ends the statement at a semicolon', () => {
    assert.deepEqual(readingsOf(`x '--%' a;y 'b c'`).at(-1), [['x', 'a'], ['y', 'b c']]);
    assert.deepEqual(readingsOf('x -y: --% a;y b').at(-1), [['x', '-y:', 'a'], ['y', 'b']]);
  });

  it('is no such value inside an array, whichever element holds it', () => {
    assertLastReadings([
      [`x '--%',y 'a b' c`, ['--%,y', 'a b', 'c']],
      [`x y,'--%' 'a b' c`, ['y,--%', 'a b', 'c']],
      [`x '--%' ,y 'a b' c`, ['--%', 'y', 'a b', 'c']],
      [`x -y:'--%',a 'b c'`, ['-y:--%,a', 'b c']],
      [`x -y:'--%' ,a 'b c'`, ['-y:--%', 'a', 'b c']],
    ]);
  });

  it('is no such value when the word holds more than the marker', () => {
    assertLastReadings([
      [`x -y:--%x 'a b' c`, ['-y:--%x', 'a b', 'c']],
      [`x -y:'--%x' 'a b' c`, ['-y:--%x', 'a b', 'c']],
      [`x 'a--%' 'b c' d`, ['a--%', 'b c', 'd']],
      [`x -y:a--% 'b c' d`, ['-y:a--%', 'b c', 'd']],
      [`x -y:'a--%' 'b c' d`, ['-y:a--%', 'b c', 'd']],
      [`x x'--%' 'b c' d`, ['x--%', 'b c', 'd']],
    ]);
  });

  it('leaves a program name alone', () => {
    // Measured through an alias of that name: a head is no value, so nothing goes in bare.
    assert.deepEqual(readingsOf(`& '--%' 'a b'`).at(-1), [['&', '--%', 'a b']]);
  });

  it('writes arrays and later tokens behind it bare too', () => {
    assertLastReadings([
      [`x '--%' y ,z 'c d'`, ['y', 'z', 'c', 'd']],
      [`x '--%' 'a b' ,c`, ['a', 'b', 'c']],
      [`x '--%' 'a b','c d'`, ['a', 'b,c', 'd']],
      [`x -y:--% -z:--% 'a b'`, ['-y:', '-z:', 'a', 'b']],
      [`x -y:--% -z:'b c' d`, ['-y:', '-z:b', 'c', 'd']],
    ]);
  });

  it('lets the runtime read a bare value, a quote and a backslash in it', () => {
    assertLastReadings([
      [`x '--%' 'a"b' c`, ['ab c']],
      [`x '--%' 'a\\ b\\' c`, ['a\\', 'b\\', 'c']],
    ]);
  });

  it('takes a %NAME% in a value behind it as a value only known when the line runs', () => {
    const rows: readonly (readonly [string, readonly (readonly [string, boolean])[]])[] = [
      [`x '--%' '%W%' c`, [['%W%', true], ['c', false]]],
      [`x -y:--% '%W%' c`, [['-y:', false], ['%W%', true], ['c', false]]],
      [`x -y: --% '%W%' c`, [['-y:', false], ['%W%', true], ['c', false]]],
      [`x '--%' a,'%W%' c`, [['a,%W%', true], ['c', false]]],
      [`x '--%' 'q%W%r' c`, [['q%W%r', true], ['c', false]]],
    ];
    for (const [line, words] of rows) {
      const parse = parseShell(line, 'powershell');
      const native = (parse.readings ?? [parse]).at(-1)?.commands[0]?.words ?? [];
      assert.deepEqual(native.slice(1).map((word) => [word.text, word.dynamic]), words, line);
    }
  });

  it('reads no %NAME% ahead of it, where the binder expands nothing', () => {
    const parse = parseShell(`x '%W%' c`, 'powershell');
    const [, value] = (parse.readings ?? [parse]).at(-1)?.commands[0]?.words ?? [];
    assert.deepEqual([value?.text, value?.dynamic], ['%W%', false]);
  });

  it('still comes apart where a blank in the percents leaves them text', () => {
    assertLastReadings([[`x '--%' '%a --no-verify b%' c`, ['%a', '--no-verify', 'b%', 'c']]]);
  });

  it('keeps its blank on the line, shown by a quote the words before it opened', () => {
    assertLastReadings([
      [`x 'a"' '--%' 'b c'`, ['a  b c']],
      [`x 'a"' -y:--% 'b c'`, ['a -y: b c']],
      [`x 'a"' -y: --% 'b c'`, ['a -y:  b c']],
      [`x 'a"' '--%' '' 'b c'`, ['a   b c']],
    ]);
  });

  it('reads a here-string holding it as a whole value', () => {
    assert.deepEqual(readingsOf(`x @'\n--%\n'@ 'a b' c`).at(-1), [['x', 'a', 'b', 'c']]);
  });

  it('cuts a value behind it at its own NUL, where a NUL ahead of it ends the line', () => {
    const rows: readonly Row[] = [
      ["x '--%' \"a`0b c\" d", ['a', 'd']],
      ["x '--%' \"`0b\" c", ['c']],
      ["x '--%' \"a`0b\",c d", ['a,c', 'd']],
      ["x -y:--% \"a`0b c\" d", ['-y:', 'a', 'd']],
      ["x \"a`0b c\" '--%' d", ['a']],
    ];
    for (const [line, words] of rows) {
      assert.deepEqual(readingsOf(line)[0], [['x', ...words]], line);
    }
  });
});

describe('parseShell: PowerShell backticks', () => {
  it('reads each letter of the real table as its character, bare and in quotes', () => {
    // `0 is a NUL, which each reading takes its own way: see the NUL specs.
    for (const [letter, value] of POWERSHELL_ESCAPES.filter(([letter]) => letter !== '0')) {
      assert.deepEqual(wordsOf(`c a\`${letter}b`, 'powershell'), [['c', `a${value}b`]], letter);
      assert.deepEqual(wordsOf(`c "a\`${letter}b"`, 'powershell'), [['c', `a${value}b`]], letter);
    }
  });

  it('keeps every other letter, `e` and `u` among them, as 5.1 does', () => {
    assert.deepEqual(wordsOf('c a`eb a`ub a`zb a`$b', 'powershell'), [['c', 'aeb', 'aub', 'azb', 'a$b']]);
    assert.deepEqual(readingsOf('c "a`eb" "a`$b" "a`"b"'), [[['c', 'aeb', 'a$b', 'a"b']], [['c', 'aeb', 'a$b', 'ab']]]);
  });

  it('keeps an escaped blank in its word', () => {
    assert.deepEqual(wordsOf('c a`\tb a` b', 'powershell'), [['c', 'a\tb', 'a b']]);
  });

  it('continues the line between words, whichever line end follows', () => {
    for (const end of ['\n', '\r', '\r\n']) {
      assert.deepEqual(wordsOf(`a \`${end}b`, 'powershell'), [['a', 'b']], JSON.stringify(end));
    }
  });

  it('keeps one character of a line end inside a word, so the LF of a CR LF still ends the statement', () => {
    assert.deepEqual(wordsOf('c a`\nb', 'powershell'), [['c', 'a\nb']]);
    assert.deepEqual(wordsOf('c a`\rb', 'powershell'), [['c', 'a\rb']]);
    assert.deepEqual(wordsOf('c a`\r\nb d', 'powershell'), [['c', 'a\r'], ['b', 'd']]);
  });

  it('keeps one character of a line end in quotes, the rest being text there', () => {
    assert.deepEqual(wordsOf('c "a`\r\nb"', 'powershell'), [['c', 'a\r\nb']]);
    assert.deepEqual(wordsOf('c @"\nx`ny\n"@', 'powershell'), [['c', 'x\ny']]);
  });

  it('keeps a backtick with nothing after it, or a NUL', () => {
    assert.deepEqual(wordsOf('c a`', 'powershell'), [['c', 'a`']]);
    assert.deepEqual(wordsOf('c "a`\0b"', 'powershell'), [['c', 'a`'], ['c', 'a`\0b']]);
  });

  it('keeps a backtick inside a -name: token as text', () => {
    assert.deepEqual(wordsOf('c -a`b:"c"d e', 'powershell'), [['c', '-a`b:c', 'd', 'e']]);
  });
});

describe('parseShell: a NUL in PowerShell', () => {
  it('reads a line each way the host may: cut there, the word alone cut, or kept', () => {
    const readings = [['c', 'a'], ['c', 'a\0b', 'd'], ['c', 'a', 'd']];
    assert.deepEqual(wordsOf('c a`0b d', 'powershell'), readings);
    assert.deepEqual(wordsOf('c "a`0b" d', 'powershell'), readings);
    assert.deepEqual(wordsOf('c "a\0b" d', 'powershell'), readings);
    assert.deepEqual(wordsOf('c @"\na`0b\n"@ d', 'powershell'), readings);
  });

  it('hands a program nothing for a word that is only the NUL, when the line ends there', () => {
    assert.deepEqual(wordsOf('x `0 a', 'powershell'), [['x'], ['x', '\0', 'a'], ['x', '', 'a']]);
  });

  it('ends a word at a raw NUL outside quotes, the NUL leading the next word', () => {
    assert.deepEqual(wordsOf('c a\0b d', 'powershell'), [['c', 'a'], ['c', 'a', '\0b', 'd'], ['c', 'a', '', 'd']]);
  });

  it('still takes a separator and a redirection after a cut', () => {
    const lineReading = (line: string): ShellParse | undefined => parseShell(line, 'powershell').readings?.[0];
    assert.deepEqual(lineReading('c a`0b d; e f')?.commands.map((command) => command.words.map((word) => word.text)), [['c', 'a'], ['e', 'f']]);
    assert.deepEqual(lineReading('c a`0b > out d')?.commands[0]?.redirections.map((redirection) => redirection.target?.text), ['out']);
  });

  it('cuts a redirection target without ending the line', () => {
    const command = parseShell('c > a`0b d', 'powershell').readings?.[0]?.commands[0];
    assert.deepEqual(command?.words.map((word) => word.text), ['c', 'd']);
    assert.deepEqual(command?.redirections.map((redirection) => redirection.target?.text), ['a']);
  });

  it('lists a substitution at and after a cut, as it runs, in every reading', () => {
    const readings = parseShell('c a`0$(x y) $(z)', 'powershell').readings ?? [];
    assert.equal(readings.length, 3);
    for (const reading of readings) {
      const heads = reading.commands.map((command) => command.words[0]?.text);
      assert.ok(heads.includes('x') && heads.includes('z'), JSON.stringify(heads));
    }
  });

  it('keeps a cut word exact: what follows the NUL adds nothing to it', () => {
    const word = parseShell('c a`0$v', 'powershell').readings?.[0]?.commands[0]?.words[1];
    assert.deepEqual([word?.text, word?.dynamic], ['a', false]);
  });

  it('cuts the text after --%', () => {
    assert.deepEqual(wordsOf('c --% a\0b d', 'powershell'), [['c', '--%', 'a'], ['c', '--%', 'a\0b', 'd'], ['c', '--%', 'a', 'd']]);
  });

  it('still reads the rest as written after a --% the cut dropped', () => {
    assert.deepEqual(parseShell('c a`0 --% b;d e', 'powershell').readings?.[0]?.commands.map((command) => command.words.map((word) => word.text)), [['c', 'a']]);
  });

  it('takes no marker from a --% the NUL touches', () => {
    assert.deepEqual(wordsOf('c --%`0 b;d e', 'powershell'), [['c', '--%'], ['d', 'e'], ['c', '--%\0', 'b'], ['d', 'e'], ['c', '--%', 'b'], ['d', 'e']]);
  });

  it('stays complete when the readings agree, and is not when they differ', () => {
    for (const line of ['c ``0', 'c # a`0 b', "c 'a`0b'", 'c -\u00e9:x']) {
      const parsed = parseShell(line, 'powershell');
      assert.deepEqual([parsed.complete, parsed.readings], [true, undefined], line);
    }
    assert.equal(parseShell('c a`0b', 'powershell').complete, false);
  });

  it('forks on a parameter 5.1 may not take: one word there, the value and the rest on pwsh', () => {
    const line = 'c -\ua7c2:"x"--d';
    assert.deepEqual(wordsOf(line, 'powershell'), [['c', '-\ua7c2:x--d'], ['c', '-\ua7c2:x', '--d']]);
    assert.equal(parseShell(line, 'powershell').complete, false);
  });
});

describe('parseShell: a backtick code point in PowerShell', () => {
  it('reads the letter on 5.1 and the character on pwsh', () => {
    assert.deepEqual(wordsOf('c "a`u{2d}b"', 'powershell'), [['c', 'au{2d}b'], ['c', 'a-b']]);
  });

  it('reads one bare too', () => {
    assert.ok(wordsOf('c a`u{2d}b', 'powershell').some((words) => words.join(' ') === 'c a-b'));
  });

  it('cuts at a code point that is a NUL, in the readings that do', () => {
    assert.deepEqual(wordsOf('c "a`u{0}b" d', 'powershell'), [['c', 'au{0}b', 'd'], ['c', 'a'], ['c', 'a', 'd'], ['c', 'a\0b', 'd']]);
  });

  it('keeps the letter of anything that is no code point, which pwsh refuses', () => {
    for (const hex of ['110000', 'zz', '0000041']) {
      assert.deepEqual(wordsOf(`c "a\`u{${hex}}b"`, 'powershell'), [['c', `au{${hex}}b`]], hex);
    }
  });
});

describe('parseShell: PowerShell line ends', () => {
  it('ends a statement at a lone CR, and keeps it in quotes', () => {
    assert.deepEqual(wordsOf('a b\rc d', 'powershell'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(wordsOf('a\r\nb', 'powershell'), [['a'], ['b']]);
    assert.deepEqual(wordsOf('"a\rb" \'c\rd\'', 'powershell'), [['a\rb', 'c\rd']]);
  });

  it('ends a comment at a lone CR', () => {
    assert.deepEqual(wordsOf('a # note\rb c', 'powershell'), [['a'], ['b', 'c']]);
  });

  it('writes a CR as a newline in the terminator, which is all the pipe readers know', () => {
    assert.equal(parseShell('a |\rb', 'powershell').commands[0]?.terminator, '|\n');
  });

  it('reads past every gap after a comma to the next element', () => {
    const gaps = ['\n', '\r\n', '  \n  ', '\n\n', '#x\n', ' #x\n#y\n', '<#x#>\n', '`\n', '`\n\n', '\n`\n', '`\r\n', '`\r\n\r\n', '#x`\n', '<#x#>`\n#y\n  '];
    for (const gap of gaps) {
      assert.deepEqual(wordsOf(`p a,${gap}b c`, 'powershell'), [['p', 'a', 'b', 'c']], JSON.stringify(gap));
    }
  });

  it('reads on through a chain of commas, and stops at the first line end after an element', () => {
    assert.deepEqual(wordsOf('p a,b,\nc d', 'powershell'), [['p', 'a', 'b', 'c', 'd']]);
    assert.deepEqual(wordsOf('p a,\nb,\nc d', 'powershell'), [['p', 'a', 'b', 'c', 'd']]);
    assert.deepEqual(wordsOf('p a,\nb\nc d', 'powershell'), [['p', 'a', 'b'], ['c', 'd']]);
  });

  it('keeps the words of a comma nothing follows', () => {
    assert.deepEqual(wordsOf('p a,', 'powershell'), [['p', 'a']]);
    assert.deepEqual(wordsOf('p a,\n', 'powershell'), [['p', 'a']]);
    assert.deepEqual(wordsOf('(p a,\n)', 'powershell'), [['p', 'a']]);
  });
});

describe('parseShell: a CR in bash', () => {
  it('reads the line with the CR dropped, as Git Bash does, and with it kept, as bash elsewhere does', () => {
    assert.deepEqual(wordsOf('a\rb c', 'bash'), [['ab', 'c'], ['a\rb', 'c']]);
    assert.deepEqual(wordsOf('"a\rb"', 'bash'), [['ab'], ['a\rb']]);
    assert.deepEqual(wordsOf('f a\r\nf b', 'bash'), [['f', 'a'], ['f', 'b'], ['f', 'a\r'], ['f', 'b']]);
  });

  it('runs on past a comment to the newline in both readings', () => {
    assert.deepEqual(wordsOf('a # note\rf b\nf c', 'bash'), [['a'], ['f', 'c']]);
  });

  it('joins lines over a backslash and CR only where the CR is gone', () => {
    assert.deepEqual(wordsOf('f a\\\r\nf b', 'bash'), [['f', 'af', 'b'], ['f', 'a\r'], ['f', 'b']]);
  });

  it('does not doubt a line whose readings agree', () => {
    const parsed = parseShell('a # note\r', 'bash');
    assert.deepEqual(parsed.commands.map((command) => command.subshells), [[]]);
    assert.equal(parsed.complete, true);
  });

  it('calls a line whose readings differ not read with confidence', () => {
    assert.equal(parseShell('a\rb', 'bash').complete, false);
  });

  it('keeps one reading from moving the next: each sits in a subshell of its own', () => {
    const subshells = parseShell('cd s\rub; (a)', 'bash').commands.map((command) => command.subshells);
    assert.deepEqual(subshells, [[-1], [-1, 0], [-2], [-2, 0]]);
  });

  it('carries what any reading leaves unread', () => {
    const parsed = parseShell('cat <<A <<B\na\nA\nb\r\nB\n', 'bash');
    assert.deepEqual(parsed.unreadBodies.map((body) => body.text), ['a', 'a']);
    assert.equal(parseShell('echo $((1))\r', 'bash').bindingsUnclear, true);
  });

  it('binds a variable within its own reading, so two values for a name are not a clash', () => {
    const resolved = resolveLiteralVariables(parseShell('B=ma\rin; echo $B', 'bash'));
    // A value with a CR is not one the binder trusts, so the kept reading leaves the variable unknown.
    assert.deepEqual(resolved.map((command) => command.words.map((word) => word.text)), [['B=main'], ['echo', 'main'], ['B=ma\rin'], ['echo', '$B']]);
  });

  it('keeps both readings of a body no command reads, even where the commands agree', () => {
    const parsed = parseShell('cat <<A <<B\na\r\nA\nb\nB\n', 'bash');
    assert.deepEqual(parsed.unreadBodies.map((body) => body.text), ['a', 'a\r']);
  });
});

describe('parseShell: cmd', () => {
  it('drops every CR, in a word, in quotes, after a caret and in the command name', () => {
    assert.deepEqual(wordsOf('no\rde a\rb "c\rd" e^\rf', 'cmd'), [['node', 'ab', 'cd', 'ef']]);
  });

  it('ends a quote at a newline, and the next line is a command', () => {
    assert.deepEqual(wordsOf('a "b\n" c', 'cmd'), [['a', 'b'], [' c']]);
    assert.deepEqual(wordsOf('"a\nb c', 'cmd'), [['a'], ['b', 'c']]);
    assert.equal(parseShell('a "b\nc d', 'cmd').complete, true);
  });

  it('drops a caret at the very end, and keeps one in quotes or escaped', () => {
    assert.deepEqual(wordsOf('a^', 'cmd'), [['a']]);
    assert.deepEqual(wordsOf('a ^', 'cmd'), [['a']]);
    assert.deepEqual(wordsOf('"a^"', 'cmd'), [['a^']]);
    assert.deepEqual(wordsOf('a^^', 'cmd'), [['a^']]);
  });

  it('reads a caret before a newline both ways: stdin joins the lines, /c ends the line there', () => {
    assert.deepEqual(wordsOf('a^\nb c', 'cmd'), [['ab', 'c'], ['a'], ['b', 'c']]);
    assert.deepEqual(wordsOf('a ^\nb c', 'cmd'), [['a', 'b', 'c'], ['a'], ['b', 'c']]);
    assert.deepEqual(wordsOf('a^\r\nb c', 'cmd'), [['ab', 'c'], ['a'], ['b', 'c']]);
  });
});
