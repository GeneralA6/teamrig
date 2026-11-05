import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStaticWord, parseHeldText, parseShell, type ShellDialect, type ShellWord } from './tokenizer.ts';

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
const skipped = (command: string): boolean => parseShell(command, 'bash').skipped;

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
    assert.deepEqual(words("git $'\\x70ush' $'\\u0041\\101\\n\\'\\q'"), [['git', 'push', "AA\n'\\q"]]);
    assert.deepEqual(words('echo $"text"'), [['echo', 'text']]);
  });

  it("ends a $'...' value at a NUL, and the word carries on after the closing quote", () => {
    assert.deepEqual(words("a $'\\0' b"), [['a', '', 'b']]);
    assert.deepEqual(words("a $'\\0'$'\\0' b"), [['a', '', 'b']]);
    assert.deepEqual(words("a $'x\\0y'z b"), [['a', 'xz', 'b']]);
    assert.deepEqual(words("a $'\\0'\"two words\" b"), [['a', 'two words', 'b']]);
  });

  it("decodes the $'...' escapes a shorter table misses", () => {
    assert.deepEqual(words("git $'\\560'ush $'\\x{2d}'-force $'\\U0000002d'-all"), [['git', 'push', '--force', '--all']]);
  });

  it("finds the closing quote of $'...' before it decodes, as bash does in two steps", () => {
    assert.deepEqual(words("a $'\\c\\'x' b"), [['a', "\x1c'x", 'b']]);
    assert.deepEqual(words("a $'\\c\\\\x' b"), [['a', '\x1cx', 'b']]);
  });

  it("calls a line with an open $'...' incomplete, a backslash at its very end too", () => {
    for (const line of ["a $'open", "a $'open\\'", "a $'open\\", "a $'\\0"]) {
      assert.equal(complete(line), false, line);
    }
    assert.equal(complete("a $'\\0' b"), true);
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

  it('keeps a command substitution written in quotes or escapes as held text, read as commands only on demand', () => {
    const held = (command: string, dialect: ShellDialect = 'bash'): (string | undefined)[] =>
      parseShell(command, dialect).commands.at(-1)?.words.map((word) => word.held) ?? [];
    assert.deepEqual(held(`echo 'a[$(git push)]' "b\\\`git fetch\\\`" c\\$\\(d $'\\x24(e)' "$(git status)" 'plain'`), [
      undefined,
      'a[$(git push)]',
      'b`git fetch`',
      'c$(d',
      '$(e)',
      undefined,
      undefined,
    ]);
    assert.deepEqual(held("echo '$(git push)'", 'powershell'), [undefined, undefined]);
    const run = (text: string): string[][] => parseHeldText(text).commands.map((parsed) => parsed.words.map(show));
    assert.deepEqual(run(`a[$(git push origin "main")] \`git fetch\` \\$(no) '$(git status)'`), [
      ['git', 'push', 'origin', 'main'],
      ['git', 'fetch'],
      ['git', 'status'],
    ]);
    // Held text that never closes is read to its end: bash runs the substitutions before its error.
    const pattern = parseHeldText("^##\\|push(`##\\|'## ");
    assert.deepEqual([pattern.commands.length, pattern.complete, pattern.skipped], [0, false, false]);
    const unclosed = parseHeldText('$(git push) $(git status');
    assert.deepEqual([run('$(git push) $(git status'), unclosed.complete, unclosed.skipped], [[['git', 'push'], ['git', 'status']], false, false]);
    assert.equal(parseHeldText(`${'$('.repeat(20)}git push${')'.repeat(20)}`).skipped, true);
  });

  it('reads a single-quoted piece of a double-quoted ${...} with confidence only when it is plain text', () => {
    assert.equal(complete(`echo "\${B:-'a b'}"; cat <<EOF\n\${B:-'x'}\nEOF`), true);
    assert.equal(skipped(`echo "\${B:-'a b'}"`), false);
    for (const command of [`echo "\${B:-'}"'$(git push)''}"`, `echo "\${B:-'$(git push)'}"`, `echo "\${B:-'open}"`]) {
      assert.equal(complete(command), false, command);
      assert.equal(skipped(command), true, command);
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

  it('reads &> and &>> as redirections, and keeps a command of redirections alone', () => {
    const parse = parseShell('a &>out; b&>>log && c &&>x; d |&>y; >new; e & 2>err', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words.map(show), command.redirections.map((redirection) => [redirection.operator, redirection.target?.text])]),
      [
        [['a'], [['&>', 'out']]],
        [['b'], [['&>>', 'log']]],
        [['c'], []],
        [[], [['>', 'x']]],
        [['d'], []],
        [[], [['>', 'y']]],
        [[], [['>', 'new']]],
        [['e'], []],
        [[], [['2>', 'err']]],
      ],
    );
  });

  it('reads a descriptor that is closed or moved, a {NAME} descriptor and a file named -, keeping the words after them', () => {
    const parse = parseShell('a 2>&- b; c >&1- d; e 2>& - f; g >- h; i {fd}>/dev/null j; k <<-EOF\n\tx\n\tEOF', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words.map(show), command.redirections.map(({ operator, target }) => [operator, target?.text])]),
      [
        [['a', 'b'], [['2>&-', undefined]]],
        [['c', 'd'], [['>&1-', undefined]]],
        [['e', 'f'], [['2>&', '-']]],
        [['g', 'h'], [['>', '-']]],
        [['i', 'j'], [['{fd}>', '/dev/null']]],
        [['k'], [['<<-', 'EOF']]],
      ],
    );
  });

  it('leaves a heredoc on a line of redirections alone unread', () => {
    const parse = parseShell('<<EOF\nbody\nEOF\ncat', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words.map(show), command.stdin === undefined]),
      [
        [[], true],
        [['cat'], true],
      ],
    );
    assert.deepEqual(parse.unreadBodies.map(show), ['body']);
  });

  it("gives the redirections after a ( ) group's ) to the command it closed on, which keeps the link after them", () => {
    const parse = parseShell('(a; (b)) > out 2>&1; c', 'bash');
    assert.deepEqual(
      parse.commands.map((command) => [command.words.map(show), command.terminator, command.redirections.map((redirection) => redirection.operator)]),
      [
        [['a'], ';(', []],
        [['b'], '));', ['>', '2>&1']],
        [['c'], '', []],
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

  it('reports an unclosed quote, substitution or bracket as incomplete, and nesting too deep as skipped', () => {
    for (const command of ["echo 'open", 'echo "open', 'echo $(git push', 'echo `git push', 'echo ${open', "echo $'open", '(git push', 'echo $((1 + 2']) {
      assert.equal(complete(command), false, command);
      assert.equal(skipped(command), false, command);
    }
    assert.equal(complete('echo "closed" $(ok) `ok` ${ok}'), true);
    for (const command of [
      `echo ${'$('.repeat(20)}x${')'.repeat(20)}`,
      `echo ${'`'.repeat(1)}${'$('.repeat(16)}x${')'.repeat(16)}\``,
      `echo ${'${x:-'.repeat(20)}x${'}'.repeat(20)}`,
      `echo ${'$(('.repeat(20)}1${'))'.repeat(20)}`,
    ]) {
      assert.equal(complete(command), false, command);
      assert.equal(skipped(command), true, command);
    }
    assert.equal(complete(`echo ${'$(('.repeat(10)}1${'))'.repeat(10)}`), true);
  });

  it('reads the substitutions inside arithmetic, and a single quote there as unreadable', () => {
    assert.deepEqual(words('echo $(( $(git push) + `git fetch` + (1) ))x $[ "$(echo 1)" + a[2] ]'), [
      ['git', 'push'],
      ['git', 'fetch'],
      ['echo', '1'],
      ['echo', '~$(( $(git push) + `git fetch` + (1) ))x', '~$[ "$(echo 1)" + a[2] ]'],
    ]);
    assert.equal(complete("echo $(( '1' ))"), false);
    assert.equal(skipped("echo $(( '1' ))"), false);
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

  it('flags arithmetic, a ${...} that can assign and a heredoc left as commands', () => {
    for (const line of [
      '((B = 1))',
      'for ((i = 0; i < 2; i++)); do :; done',
      ': $((B = 1))',
      'echo "$((1 + 2))"',
      ': $[B = 1]',
      ': ${B:=main}',
      'echo "${B=main}"',
      ': ${B:i=1} ${B: -1:2}',
      ': ${A[i=1]} ${A[$i]} ${A[1+1]} ${A[0]:1}',
      ': ${!R} ${!R*}',
      ': ${B@P} ${B@}',
      ': ${#} ${B x}',
      ': ${B:-$((C = 1))}',
      ': "${B:-${C:=x}}"',
      'echo `: ${B=main}`',
      'x=$(cat <<EOF\n$((B = 1))\nEOF\n)',
      'cat <<EOF\nB=feat',
      'cat <<$D\nB=feat\n$D',
      'cat <<',
      'echo $[',
      'echo x {B}>/dev/null',
    ]) {
      assert.equal(unclear(line), true, line);
    }
  });

  it('passes over quoted text, plain variables, a ${...} that only reads and heredocs it reads', () => {
    for (const line of [
      "echo '((x<<2))' \"<<EOF\" $'$((1))'",
      'echo $B ${B} "${B}"',
      'echo ${x%%|*} "${x#*|}" ${B%.*} ${B##*/} ${B/a/b} ${B//a} ${B^^} ${B,} ${B@Q} ${B@a}',
      'echo ${B:-a} ${B-a} ${B:+a} ${B?a} ${#B} ${#A[@]} ${A[*]} ${A[@]:-x} ${1} ${10} ${@} ${?}',
      'echo "exit ${PIPESTATUS[0]}" ${A[12]:-x} ${#A[1]}',
      'echo ${B:-$(C=1)} "${B:-`C=1`}" ${B:-${C:-x}}',
      'cat <<EOF\n${B}\nEOF',
      "cat <<'EOF'\n$((B = 1))\nEOF",
    ]) {
      assert.equal(unclear(line), false, line);
    }
    assert.equal(unclear('${x:=1}; $((1))', 'powershell'), false);
  });

  it('reads $[...] as one dynamic word', () => {
    assert.deepEqual(words('echo $[a[1] + 2]x y'), [['echo', '~$[a[1] + 2]x', 'y']]);
  });
});

describe('isStaticWord', () => {
  /** Each word of the line's own command: the last one, after the commands of its substitutions. */
  const statics = (line: string): boolean[] => (parseShell(line, 'bash').commands.at(-1)?.words ?? []).map(isStaticWord);

  it('takes text, quoted or not, whose value is its text', () => {
    assert.deepEqual(statics(`git -C /w 'a b' "c*" '~' x=1`), [true, true, true, true, true, true, true]);
  });

  it('refuses a word only known when it runs, or unquoted text bash expands', () => {
    assert.deepEqual(statics('echo $B "$B" $(x) {a,b} *.ts a?b [ab] ~/x'), [true, false, false, false, false, false, false, false, false]);
    assert.equal(isStaticWord({ text: 'a', dynamic: false }), false);
  });
});
