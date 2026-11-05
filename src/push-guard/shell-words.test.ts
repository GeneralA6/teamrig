import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installCallsOf } from '../package-guard/installs.ts';
import { programsOf } from '../package-guard/programs.ts';
import { bashLineReads } from '../readonly-shell/bash.ts';
import { powershellLineReads } from '../readonly-shell/powershell.ts';
import { prefixWords, type ReadonlyRules } from '../readonly-shell/rules.ts';
import { BLANK_AND_LINE_END_ROWS, POWERSHELL_BLANKS, POWERSHELL_DOUBLE_QUOTES, POWERSHELL_LINE_ENDS, POWERSHELL_SINGLE_QUOTES, QUOTE_ROWS, type ShellWordsRow } from '../testing/shell-words.ts';
import { hookSkips } from './hook-skips.ts';
import { findGitInvocations } from './invocations.ts';
import { evaluatePushes, type PushDecision, type RepoState } from './push.ts';
import { parseShell, type ShellDialect } from './tokenizer.ts';
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

/** Every guard is at least as strict on the line as typed as on the line the shell really runs. */
function assertNoSofter({ dialect, typed, real }: ShellWordsRow): void {
  const seen = answersFor(typed, dialect);
  const truth = answersFor(real, dialect);
  const label = JSON.stringify(typed);
  assert.deepEqual(truth.skips.filter((skip) => !seen.skips.includes(skip)), [], `hook skips of ${label}`);
  assert.ok(STRICTNESS[seen.push] >= STRICTNESS[truth.push], `push of ${label}: ${seen.push}, real ${truth.push}`);
  assert.deepEqual(truth.installs.filter((call) => !seen.installs.includes(call)), [], `installs of ${label}`);
  assert.deepEqual(truth.programs.filter((run) => !seen.programs.includes(run)), [], `programs of ${label}`);
  assert.ok(truth.reads || !seen.reads, `read-only of ${label}`);
}

/** The words of each command. */
function wordsOf(line: string, dialect: ShellDialect): string[][] {
  return parseShell(line, dialect).commands.map((command) => command.words.map((word) => word.text));
}

describe('the guards read the words the shell runs', () => {
  it('holds on every blank and line end', () => {
    BLANK_AND_LINE_END_ROWS.forEach(assertNoSofter);
  });

  it('holds on every quote, here-string and --% shape', () => {
    QUOTE_ROWS.forEach(assertNoSofter);
  });
});

describe('parseShell: blanks, measured on the real shells', () => {
  it('ends a PowerShell word at exactly the units the real parser does', () => {
    const blanks = new Set(POWERSHELL_BLANKS);
    const lineEnds = new Set(POWERSHELL_LINE_ENDS);
    // These act on their own, outside the blanks this table measures: separators, redirections, a NUL.
    const apart = new Set([...'\0&(),;{}|<>']);
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

  it('ends a bash or cmd word at a space or a tab alone', () => {
    for (const dialect of ['bash', 'cmd'] as const) {
      assert.deepEqual(wordsOf('a b\tc', dialect), [['a', 'b', 'c']]);
      for (const unit of ['\u000b', '\u000c', '\u0085', '\u00a0', '\u1680', '\u2003', '\u2028', '\u2029', '\u3000', '\ufeff']) {
        assert.deepEqual(wordsOf(`a${unit}b c`, dialect), [[`a${unit}b`, 'c']], `U+${unit.charCodeAt(0).toString(16)} in ${dialect}`);
      }
    }
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
          assert.deepEqual(wordsOf(`x @${open}\nb\n${other}@\n${close}@ y`, 'powershell'), [['x', `b\n${other}@`, 'y']]);
        }
      }
    }
  });

  it('closes an empty body on the line end of its opener', () => {
    for (const lineEnd of ['\n', '\r\n', '\r']) {
      assert.deepEqual(wordsOf(`x @'${lineEnd}'@ y`, 'powershell'), [['x', '', 'y']], JSON.stringify(lineEnd));
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
  it('is no marker in a word a quote starts', () => {
    assert.deepEqual(wordsOf("x '--%' a; y", 'powershell'), [['x', '--%', 'a'], ['y']]);
    assert.deepEqual(wordsOf('x "--%" a; y', 'powershell'), [['x', '--%', 'a'], ['y']]);
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

  it('reads %VAR% in quotes too, and never past the end of the text', () => {
    const [, ...rest] = parseShell('x --% "%A%"', 'powershell').commands[0]?.words ?? [];
    assert.deepEqual(rest.map((word) => [word.text, word.dynamic]), [['--%', false], ['%A%', true]]);
    assert.deepEqual(wordsOf('x --% %a|y\u0085z%', 'powershell'), [['x', '--%', '%a'], ['y', 'z%']]);
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
});
