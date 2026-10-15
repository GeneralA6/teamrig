import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, type ShellDialect, type ShellWord } from './tokenizer.ts';

const show = (word: ShellWord): string => (word.dynamic ? `~${word.text}` : word.text);

/** The words of each command, a dynamic word marked with a leading `~`. */
function words(command: string, dialect: ShellDialect = 'bash'): string[][] {
  return parseShell(command, dialect).commands.map((parsed) => parsed.words.map(show));
}

/** Each command as one line of words, then ` < ` and what it reads on stdin, when the line gives it that. */
function withStdin(command: string): string[] {
  return parseShell(command, 'bash').commands.map((parsed) => {
    const line = parsed.words.map(show).join(' ');
    return parsed.stdin === undefined ? line : `${line} < ${show(parsed.stdin)}`;
  });
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

  it('reads the substitutions inside ${...}, which ends at the first } nothing holds', () => {
    assert.deepEqual(words('echo ${B:-$(git push origin main)} "${C:-`git fetch`}" ${D:-$(echo })}x'), [
      ['git', 'push', 'origin', 'main'],
      ['git', 'fetch'],
      ['echo', '}'],
      ['echo', '~${B:-$(git push origin main)}', '~${C:-`git fetch`}', '~${D:-$(echo })}x'],
    ]);
    assert.deepEqual(words("echo ${B:-'}'}x ${C:-\\}} ${D:-{a}b} ${E:-'$(git push)'}"), [
      ['echo', "~${B:-'}'}x", '~${C:-\\}}', '~${D:-{a}b}', "~${E:-'$(git push)'}"],
    ]);
    assert.deepEqual(words('cat <<EOF\n${B:-$(git push)}\nEOF'), [['git', 'push'], ['cat']]);
  });

  it('reads a single-quoted piece of a double-quoted ${...} with confidence only when it is plain text', () => {
    assert.equal(complete(`echo "\${B:-'a b'}"; cat <<EOF\n\${B:-'x'}\nEOF`), true);
    for (const command of [`echo "\${B:-'}"'$(git push)''}"`, `echo "\${B:-'$(git push)'}"`, `echo "\${B:-'open}"`]) {
      assert.equal(complete(command), false, command);
    }
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

  it("records each command's redirections: the operator with its descriptor, then the target", () => {
    const parse = parseShell('a > out; b 2>&1 1>>"x y"; c <(d); e 2>', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words[0]?.text, command.redirections.map((redirection) => [redirection.operator, redirection.target?.text])]),
      [
        ['a', [['>', 'out']]],
        [
          'b',
          [
            ['2>&1', undefined],
            ['1>>', 'x y'],
          ],
        ],
        ['d', []],
        ['c', []],
        ['e', [['2>', undefined]]],
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
          { kind: 'variable', name: 'C', quoted: true },
          { kind: 'variable', name: 'D', quoted: false },
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

  it('reads a here-string as one word: literal after @\', expanded after @"', () => {
    assert.deepEqual(words("$x = @'\nbody 'q' \"d\" $y\nx '@ y\n'@; z", 'powershell'), [['~$x', '=', "body 'q' \"d\" $y\nx '@ y"], ['z']]);
    assert.deepEqual(words('$x = @"\n$(git push) b\n"@; y', 'powershell'), [['git', 'push'], ['~$x', '=', '~$(git push) b'], ['y']]);
    assert.deepEqual(words('$e = @"\n"@', 'powershell'), [['~$e', '=', '']]);
    assert.deepEqual(words('$x = @"\n`$(no) b\n"@', 'powershell'), [['~$x', '=', '$(no) b']]);
    assert.equal(complete("x @'\nnever closes", 'powershell'), false);
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

describe('parseShell: bash heredocs and here-strings', () => {
  it("reads a heredoc's body as its command's stdin, not as commands", () => {
    assert.deepEqual(withStdin("cat <<'EOF'\ngit push origin main\nEOF\necho done"), ['cat < git push origin main', 'echo done']);
    assert.deepEqual(withStdin('cat <<EOF\nEOF'), ['cat < ']);
    assert.deepEqual(withStdin('f <<A | g <<B\na\nA\nb\nB\nh'), ['f < a', 'g < b', 'h']);
  });

  it('closes a heredoc only at a line that is exactly its delimiter, after tabs for <<-', () => {
    assert.deepEqual(withStdin('cat <<EOF\n EOF\nEOF \ngit x\nEOF'), ['cat < \u0020EOF\nEOF \ngit x']);
    assert.deepEqual(withStdin('cat <<-EOF\n\t\tx\n\tEOF\ny'), ['cat < \t\tx', 'y']);
  });

  it("reads an unquoted body's substitutions as commands, before its reader, and keeps a quoted body literal", () => {
    assert.deepEqual(words('cat <<EOF\n$(git push origin main) `rm x` ${y} \\$(no)\nEOF\nz'), [['git', 'push', 'origin', 'main'], ['rm', 'x'], ['cat'], ['z']]);
    assert.deepEqual(withStdin("cat <<'E F'\n$(git push)\nE F"), ['cat < $(git push)']);
    assert.deepEqual(withStdin('cat <<E"OF"\n$x\nEOF'), ['cat < $x']);
  });

  it('keeps the lines as commands when a heredoc never closes or its delimiter is only known when it runs', () => {
    assert.deepEqual(withStdin('cat <<EOF\ngit push origin main'), ['cat', 'git push origin main']);
    assert.deepEqual(withStdin('cat <<$X\nbody\n$X'), ['cat', 'body', '~$X']);
  });

  it('opens no heredoc inside quotes or arithmetic', () => {
    assert.deepEqual(withStdin('echo "<<EOF"\ngit push'), ['echo <<EOF', 'git push']);
    assert.deepEqual(withStdin('((x<<2))\ngit push'), ['x', 'git push']);
  });

  it('gives a command its last input and keeps the bodies nothing reads', () => {
    const twice = parseShell('cat <<A <<B\na\nA\nb\nB', 'bash');
    assert.deepEqual([twice.commands.map((command) => command.stdin?.text), twice.unreadBodies.map(show)], [['b'], ['a']]);
    const file = parseShell('cat <<A < file\na\nA', 'bash');
    assert.deepEqual([file.commands.map((command) => command.stdin?.text), file.unreadBodies.map(show)], [[undefined], ['a']]);
  });

  it('reads a here-string as stdin', () => {
    assert.deepEqual(withStdin('grep x <<< "here string"; y <<<$v'), ['grep x < here string', 'y < ~$v']);
  });

  it('reads heredocs only in bash', () => {
    assert.deepEqual(words('cat <<EOF\ngit push\nEOF', 'powershell'), [['cat'], ['git', 'push'], ['EOF']]);
  });
});

describe('parseShell: bindings the commands may not show', () => {
  const unclear = (command: string, dialect: ShellDialect = 'bash'): boolean => parseShell(command, dialect).bindingsUnclear;

  it('flags arithmetic, a ${...} operator and a heredoc left as commands', () => {
    for (const line of [
      '((B = 1))',
      'for ((i = 0; i < 2; i++)); do :; done',
      ': $((B = 1))',
      'echo "$((1 + 2))"',
      ': $[B = 1]',
      ': ${B:=main}',
      'echo "${#B}"',
      'echo `: ${B=main}`',
      'x=$(cat <<EOF\n$((B = 1))\nEOF\n)',
      'cat <<EOF\nB=feat',
      'cat <<$D\nB=feat\n$D',
      'cat <<',
      'echo $[',
    ]) {
      assert.equal(unclear(line), true, line);
    }
  });

  it('passes over quoted text, plain variables and heredocs it reads', () => {
    for (const line of ["echo '((x<<2))' \"<<EOF\" $'$((1))'", 'echo $B ${B} "${B}"', 'cat <<EOF\n${B}\nEOF', "cat <<'EOF'\n$((B = 1))\nEOF"]) {
      assert.equal(unclear(line), false, line);
    }
    assert.equal(unclear('${x:=1}; $((1))', 'powershell'), false);
  });

  it('reads $[...] as one dynamic word', () => {
    assert.deepEqual(words('echo $[a[1] + 2]x y'), [['echo', '~$[a[1] + 2]x', 'y']]);
  });
});
