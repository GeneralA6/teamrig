import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, stripHeredocs, type ShellDialect } from './tokenizer.ts';

/** The words of each command, a dynamic word marked with a leading `~`. */
function words(command: string, dialect: ShellDialect = 'bash'): string[][] {
  return parseShell(command, dialect).commands.map((parsed) => parsed.words.map((word) => (word.dynamic ? `~${word.text}` : word.text)));
}

const complete = (command: string, dialect: ShellDialect = 'bash'): boolean => parseShell(command, dialect).complete;

describe('parseShell: bash', () => {
  it('splits on separators and drops redirections with their targets', () => {
    assert.deepEqual(words('a 1 && b "two words" | c > out.log 2>&1; d &> all.log; e >&2'), [['a', '1'], ['b', 'two words'], ['c'], ['d'], ['e']]);
  });

  it('removes quotes and escapes, and joins a continued line', () => {
    assert.deepEqual(words('echo a\\ b "q\\"uote" \'single $x\' "lit\\eral"'), [['echo', 'a b', 'q"uote', 'single $x', 'lit\\eral']]);
    assert.deepEqual(words('git \\\npush "a\\\nb"'), [['git', 'push', 'ab']]);
    assert.deepEqual(words('echo end\\'), [['echo', 'end\\']]);
  });

  it("decodes $'...' quoting", () => {
    assert.deepEqual(words("git $'\\x70ush' $'\\u0041\\101\\n\\'\\q'"), [['git', 'push', "AA\n'q"]]);
    assert.deepEqual(words('echo $"text"'), [['echo', 'text']]);
  });

  it('keeps variables, substitutions and brace lists as written and marks them dynamic', () => {
    assert.deepEqual(words('git push $R "${B}" $1 x$((1 + (2))) {a,b} {1..3} @{push} {} $'), [
      ['git', 'push', '~$R', '~${B}', '~$1', '~x$((1 + (2)))', '~{a,b}', '~{1..3}', '@{push}', '{}', '$'],
    ]);
  });

  it("reads a substitution's commands before the command that holds them", () => {
    assert.deepEqual(words('git push origin "$(git branch --show-current)" `git rev-parse \\`x\\``'), [
      ['git', 'branch', '--show-current'],
      ['x'],
      ['git', 'rev-parse', '~`x`'],
      ['git', 'push', 'origin', '~$(git branch --show-current)', '~`git rev-parse \\`x\\``'],
    ]);
  });

  it('records the subshell each command runs in', () => {
    const parse = parseShell('cd a; (cd b && git push) ; x=$(git push) <(git status); `git log`', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words[0]?.text, command.subshells]),
      [
        ['cd', []],
        ['cd', [0]],
        ['git', [0]],
        ['git', [1]],
        ['git', [2]],
        ['x=$(git push)', []],
        ['git', [3]],
        ['`git log`', []],
      ],
    );
    assert.equal(parse.complete, true);
    assert.deepEqual(
      parseShell('(cd b) ; $(x)', 'powershell').commands.map((command) => command.subshells),
      [[], [], []],
    );
  });

  it('records how many substitutions deep each command sits', () => {
    const nesting = (line: string, dialect: ShellDialect = 'bash'): (readonly [string | undefined, number])[] =>
      parseShell(line, dialect).commands.map((command): readonly [string | undefined, number] => [command.words[0]?.text, command.nesting]);
    assert.deepEqual(nesting('a $(b `c`) <(d); (e)'), [
      ['c', 2],
      ['b', 1],
      ['d', 1],
      ['a', 0],
      ['e', 0],
    ]);
    assert.deepEqual(nesting('a $(b) @(c)', 'powershell'), [
      ['b', 1],
      ['c', 1],
      ['a', 0],
    ]);
  });

  it('records the separators after each command, newlines kept and blanks left out', () => {
    const parse = parseShell('a ; b &&\nc || d | e |& f & g\n\nh; (i) ; x=$(j; k) `l`\nm 2>&1', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words[0]?.text, command.terminator]),
      [
        ['a', ';'],
        ['b', '&&\n'],
        ['c', '||'],
        ['d', '|'],
        ['e', '|&'],
        ['f', '&'],
        ['g', '\n\n'],
        ['h', ';('],
        ['i', ');'],
        ['j', ';'],
        ['k', ''],
        ['l', ''],
        ['x=$(j; k)', '\n'],
        ['m', ''],
      ],
    );
  });

  it('marks a command that carries a redirection', () => {
    const parse = parseShell('a > out; b 2>&1; c <(d); e', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words[0]?.text, command.redirected]),
      [
        ['a', true],
        ['b', true],
        ['d', false],
        ['c', false],
        ['e', false],
      ],
    );
  });

  it('splits a bash word into quoted and unquoted text and plain variable references', () => {
    const last = parseShell(`B='x'y "$C"\${D} \\E=f a$1 $(g) \${H:-i} {a,b}$J`, 'bash').commands.at(-1);
    assert.deepEqual(
      last?.words.map((word) => word.parts),
      [
        [
          { kind: 'text', text: 'B=', quoted: false },
          { kind: 'text', text: 'x', quoted: true },
          { kind: 'text', text: 'y', quoted: false },
        ],
        [
          { kind: 'variable', name: 'C' },
          { kind: 'variable', name: 'D' },
        ],
        [
          { kind: 'text', text: 'E', quoted: true },
          { kind: 'text', text: '=f', quoted: false },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    );
  });

  it('gives words parts only in bash', () => {
    const dialects: readonly ShellDialect[] = ['powershell', 'cmd'];
    for (const dialect of dialects) {
      const parsed = parseShell('git push origin $B %B%', dialect).commands.flatMap((command) => command.words);
      assert.equal(
        parsed.some((word) => word.parts !== undefined),
        false,
        dialect,
      );
    }
  });

  it('reads # as a comment only at a word start', () => {
    assert.deepEqual(words('git push origin a#b # main\nls'), [['git', 'push', 'origin', 'a#b'], ['ls']]);
  });

  it('reports an unclosed quote, substitution or bracket as incomplete', () => {
    for (const command of ["echo 'open", 'echo "open', 'echo $(git push', 'echo `git push', 'echo ${open', "echo $'open", '(git push', 'echo $((1 + 2']) {
      assert.equal(complete(command), false, command);
    }
    assert.equal(complete('echo "closed" $(ok) `ok` ${ok}'), true);
    assert.equal(complete(`echo ${'$('.repeat(20)}x${')'.repeat(20)}`), false);
    assert.equal(complete(`echo ${'`'.repeat(1)}${'$('.repeat(16)}x${')'.repeat(16)}\``), false);
  });
});

describe('parseShell: PowerShell', () => {
  it('applies the backtick escape, doubled quotes and comma arrays', () => {
    assert.deepEqual(words('Set-Location D:\\work\\app', 'powershell'), [['Set-Location', 'D:\\work\\app']]);
    assert.deepEqual(words('echo "a`"b" \'it\'\'s\' "say ""hi""" a,b', 'powershell'), [['echo', 'a"b', "it's", 'say "hi"', 'a', 'b']]);
  });

  it('keeps the call operator, splits on braces and skips block comments', () => {
    assert.deepEqual(words("& 'C:\\Program Files\\Git\\cmd\\git.exe' push; if ($ok) { git push } <# git push #> x && y", 'powershell'), [
      ['&', 'C:\\Program Files\\Git\\cmd\\git.exe', 'push'],
      ['if'],
      ['~$ok'],
      ['git', 'push'],
      ['x'],
      ['y'],
    ]);
  });

  it('marks variables, subexpressions and splats dynamic', () => {
    assert.deepEqual(words('git push $env:REMOTE "$($b)" @(1) @args $', 'powershell'), [['~$b'], ['1'], ['git', 'push', '~$env:REMOTE', '~$($b)', '~@(1)', '~@args', '$']]);
  });

  it('passes the rest of the line verbatim after --%', () => {
    assert.deepEqual(words('git --% push "origin" %B% main | Out-Null', 'powershell'), [['git', '--%', 'push', 'origin', '~%B%', 'main'], ['Out-Null']]);
  });

  it('drops redirections, including *>', () => {
    assert.deepEqual(words('git push 2>&1 *> $null', 'powershell'), [['git', 'push']]);
  });
});

describe('parseShell: cmd', () => {
  it('applies the caret escape and reads %VAR% and !VAR! as dynamic', () => {
    assert.deepEqual(words('@git push ^"origin^" %REMOTE% !B! "%HOME%\\x" 100%% 5% a!b & ver', 'cmd'), [
      ['git', 'push', '"origin"', '~%REMOTE%', '~!B!', '~%HOME%\\x', '100%', '5%', 'a!b'],
      ['ver'],
    ]);
  });

  it('never reads # as a comment', () => {
    assert.deepEqual(words('echo #x', 'cmd'), [['echo', '#x']]);
  });
});

describe('stripHeredocs', () => {
  it('removes heredoc and here-string bodies and keeps unterminated ones', () => {
    assert.equal(stripHeredocs("cat <<'EOF'\ngit push origin main\nEOF\necho done"), "cat <<'EOF'\necho done");
    assert.equal(stripHeredocs('cat <<-END\n\tbody\n\tEND'), 'cat <<-END');
    assert.equal(stripHeredocs('x = @"\nbody\n"@; y'), "x = ''; y");
    assert.equal(stripHeredocs('cat <<EOF\ngit push origin main'), 'cat <<EOF\ngit push origin main');
    assert.equal(stripHeredocs('grep x <<< "here string"'), 'grep x <<< "here string"');
  });

  it('keeps the body of a heredoc a shell runs', () => {
    const command = 'bash <<EOF\ngit push origin main\nEOF';
    assert.equal(stripHeredocs(command, (line) => line.startsWith('bash')), command);
  });
});
