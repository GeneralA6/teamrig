import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, type ShellWord } from './tokenizer.ts';
import { resolveLiteralVariables } from './variables.ts';

/**
 * The words of the line's last command that mentions a push, after resolving with HOME at `home` when given;
 * a word left dynamic is marked with a leading `~`.
 */
function pushCommand(line: string, home?: string): string {
  return pushWords(line, home)
    .map((word) => (word.dynamic ? `~${word.text}` : word.text))
    .join(' ');
}

/** The resolved words of the line's last command that mentions a push. */
function pushWords(line: string, home?: string): readonly ShellWord[] {
  const commands = resolveLiteralVariables(parseShell(line, 'bash'), home);
  return commands.findLast((command) => command.words.some((word) => word.text.includes('push')))?.words ?? [];
}

describe('resolveLiteralVariables: what resolves', () => {
  it('replaces a variable an earlier binding statement set to a literal', () => {
    const rows: readonly (readonly [line: string, expected: string])[] = [
      ['B=feat; git push -u origin $B', 'git push -u origin feat'],
      ['B=feat && git push origin "$B"', 'git push origin feat'],
      ['B=feat\ngit push origin ${B}', 'git push origin feat'],
      ["B='feat'\n\ngit push origin $B", 'git push origin feat'],
      ['B="feat/x-1.2"; git push origin HEAD:refs/heads/$B', 'git push origin HEAD:refs/heads/feat/x-1.2'],
      ["B=$'feat'; git push origin $B", 'git push origin feat'],
      ['export B=feat; git push origin $B', 'git push origin feat'],
      ["export 'B=feat' C; git push origin $B", 'git push origin feat'],
      ['B=feat; export B; git push origin $B', 'git push origin feat'],
      ['B=feat; B=feat; git push origin $B', 'git push origin feat'],
      ['A=feat B=x; git push origin $A-$B', 'git push origin feat-x'],
      ['B=feat; bash -c "git push origin $B"', 'bash -c git push origin feat'],
      ['B=+main; git push origin $B', 'git push origin +main'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(pushCommand(line), expected, line);
    }
  });

  it('follows the binding through lists, pipes, background jobs and groups that keep it in the same shell', () => {
    for (const line of [
      'cd sub && B=feat && git push origin $B',
      'git fetch | tail -1 && B=feat && git push origin $B',
      'B=feat || true; git push origin $B',
      'B=feat && echo set || echo failed\ngit push origin $B',
      'B=feat; git fetch && git push origin $B',
      'true & B=feat; git push origin $B',
      'B=feat; sleep 1 & git push origin $B',
      'B=feat; echo x | git push origin $B',
      '(B=feat; git push origin $B)',
      'cd sub; (B=feat; git push origin $B)',
      'true && (B=feat && git push origin $B)',
      'B=feat # a comment\ngit push origin $B',
      'B=feat; git push origin $B 2>&1 | tail -5',
    ]) {
      assert.equal(pushCommand(line), 'git push origin feat', line);
    }
  });

  it('passes over the substitutions between the binding and its use, which run in subshells of their own', () => {
    for (const line of [
      'B=feat; true $(date); git push origin $B',
      'B=feat; cd sub && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && git push origin $B 2>&1 | grep -E "error"',
      'B=feat; [ "`git rev-parse HEAD`" = x ] && git push origin $B',
      'B=feat; echo "$(date "$(echo +%s)")" <(true) && git push origin $B',
      'git fetch && [ "$(git rev-parse HEAD)" = x ] && B=feat && git push origin $B',
      'echo $(date); B=feat; git push origin $B',
    ]) {
      assert.equal(pushCommand(line), 'git push origin feat', line);
    }
  });

  it('follows the binding into the subshells started after it, which start with a copy of its variables', () => {
    for (const line of [
      'B=feat; (git push origin $B)',
      'B=feat; (cd sub && git push origin $B)',
      'B=feat; ( (git push origin $B) )',
      'B=feat; (cd sub); git push origin $B',
      'B=feat\n(cd sub)\ngit push origin $B',
      'B=feat && (true) && git push origin $B',
      'B=feat; (true) || git push origin $B',
      'B=feat; (sleep 1) & git push origin $B',
      'B=feat; (cd sub) > out; git push origin $B',
      '(cd sub; B=feat; (true); git push origin $B)',
    ]) {
      assert.equal(pushCommand(line), 'git push origin feat', line);
    }
    for (const line of ['B=feat; echo "$(git push origin $B)"', 'B=feat; (echo `git push origin $B`)', 'B=feat; diff <(git push origin $B) x']) {
      const push = resolveLiteralVariables(parseShell(line, 'bash')).find((command) => command.words[0]?.text === 'git');
      assert.equal(push?.words.map((word) => word.text).join(' '), 'git push origin feat', line);
    }
  });

  it('reads heredoc bodies as input and quoted text as text', () => {
    for (const line of [
      'B=feat; cat <<EOF\nx\nEOF\ngit push origin $B',
      'bash <<EOF\nB=main\nEOF\nB=feat; git push origin $B',
      "cat <<'EOF'\n$((B = 1)) ${B:=main}\nEOF\nB=feat; git push origin $B",
      "B=feat; echo '((x<<2))' \"<<EOF\" $'${B:=main} $[1]'; git push origin $B",
      'B=feat; grep x <<< "$B"; git push origin $B',
    ]) {
      assert.equal(pushCommand(line), 'git push origin feat', line);
    }
  });

  it('splits an unquoted value into words at blanks, as the program too, and keeps a quoted one whole', () => {
    const rows: readonly (readonly [line: string, expected: readonly string[]])[] = [
      ["B='a b'; git push origin $B", ['git', 'push', 'origin', 'a', 'b']],
      ["B='a b'; git push origin \"$B\"", ['git', 'push', 'origin', 'a b']],
      ['B="  a\tb  "; git push origin x$B', ['git', 'push', 'origin', 'x', 'a', 'b']],
      ["B=''; git push origin \"$B\"", ['git', 'push', 'origin', '']],
      ['G="git -C /w"; $G push origin main', ['git', '-C', '/w', 'push', 'origin', 'main']],
      ['X="git push"; $X origin main', ['git', 'push', 'origin', 'main']],
      ['A=git; X="$A push"; $X origin main', ['git', 'push', 'origin', 'main']],
      ['C=feat; export B="$C x"; git push origin $B', ['git', 'push', 'origin', 'feat', 'x']],
      ['B="ma*"; git push origin "$B"', ['git', 'push', 'origin', 'ma*']],
    ];
    for (const [line, expected] of rows) {
      assert.deepEqual(
        pushWords(line).map((word) => word.text),
        expected,
        line,
      );
      assert.ok(
        pushWords(line).every((word) => !word.dynamic),
        line,
      );
    }
  });

  it('keeps a variable a value names but the line does not know as one dynamic piece', () => {
    const rows: readonly (readonly [line: string, expected: string])[] = [
      ['B="feat$C"; git push origin $B', 'git push origin ~feat${C}'],
      ['H="node --flag $C queue --session s"\n$H --what "x" -- git push -u origin topic', 'node --flag ~${C} queue --session s --what x -- git push -u origin topic'],
      ['C=~/cli.ts; H="node $C queue"; $H -- git push', 'node ~${HOME}/cli.ts queue -- git push'],
      ['false && C=x; H="git $C"; $H push', 'git ~${C} push'],
      ['B="x$B"; git push origin $B', 'git push origin ~x${B}'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(pushCommand(line), expected, line);
    }
  });

  it('reads past a ${...} that only reads, as a probe loop writes it', () => {
    const rows: readonly (readonly [line: string, expected: string])[] = [
      ['B=feat; echo ${x%%|*} "${x#*|}" ${#B} ${B/a/b} ${A[@]:-x} ${B@Q}; git push origin $B', 'git push origin feat'],
      ['T="node main.js"; for x in "a|b"; do $T push ${x%%|*} "${x#*|}"; done', 'do node main.js push ~${x%%|*} ~${x#*|}'],
      ['T="node main.js"\nfor x in "a|b"; do\n$T push ${x%%|*}\ndone', 'node main.js push ~${x%%|*}'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(pushCommand(line), expected, line);
    }
  });

  it('follows a binding into, through and past a loop, an if and a { } group', () => {
    const rows: readonly (readonly [line: string, expected: string])[] = [
      ['P="node probe.ts"\nfor l in a \'b c\'; do echo "== $l"; $P "$l"; done; B=feat; git push origin $B', 'git push origin feat'],
      ['B=feat; for x in a; do git push origin $B; done', 'do git push origin feat'],
      ['B=feat; for x in a; do for y in b\ndo :; done; done; git push origin $B', 'git push origin feat'],
      ['B=feat; for x; do :; done; git push origin $B', 'git push origin feat'],
      ['B=feat; echo $(for x in a; do :; done); git push origin $B', 'git push origin feat'],
      ['B=feat; while true; do :; done; git push origin $B', 'git push origin feat'],
      ['B=feat; while git push origin $B; do :; done', 'while git push origin feat'],
      ['B=feat; until false\ndo git push origin $B\ndone', 'do git push origin feat'],
      ['B=feat; if true; then git push origin $B; fi', 'then git push origin feat'],
      ['B=feat; if a; then :; elif b; then :; else git push origin $B; fi', 'else git push origin feat'],
      ['B=feat; if ! a; then :; fi && git push origin $B', 'git push origin feat'],
      ['B=feat; { git push origin $B; } 2>&1 | tail -1', '{ git push origin feat'],
      ['B=feat; for x in a; do if b; then { git push origin $B; }; fi; done', 'then { git push origin feat'],
      ['B=feat; ! git push origin $B', '! git push origin feat'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(pushCommand(line), expected, line);
    }
  });

  it('resolves a program a variable names when it sets no variable', () => {
    for (const line of ['P="node probe.ts"; B=feat; $P "$l"; git push origin $B', 'P=true; B=feat; $P; git push origin $B']) {
      assert.equal(pushCommand(line), 'git push origin feat', line);
    }
  });
});

describe('resolveLiteralVariables: the home folder', () => {
  const HOME = 'C:\\Users\\me';

  it('reads $HOME and a value that starts with ~ as the home folder, with forward slashes', () => {
    const rows: readonly (readonly [line: string, expected: string])[] = [
      ['G=~/bin/git; $G push origin main', 'C:/Users/me/bin/git push origin main'],
      ['export G=~/bin/git; "$G" push origin main', 'C:/Users/me/bin/git push origin main'],
      ['$HOME/bin/git push origin main', 'C:/Users/me/bin/git push origin main'],
      ['"${HOME}/bin/git" push origin main', 'C:/Users/me/bin/git push origin main'],
      ['D=~; git -C $D/repo push origin main', 'git -C C:/Users/me/repo push origin main'],
      ['P=~/bin/; ${P}git push origin main', 'C:/Users/me/bin/git push origin main'],
      ['HOME=/h; G=~/git; $G push origin main', '/h/git push origin main'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(pushCommand(line, HOME), expected, line);
    }
  });

  it('splits an unquoted $HOME at its blanks, as bash does, and keeps a quoted one whole', () => {
    assert.deepEqual(
      pushWords('$HOME/git push', 'D:\\work\\a b').map((word) => word.text),
      ['D:/work/a', 'b/git', 'push'],
    );
    assert.deepEqual(
      pushWords('"$HOME/git" push', 'D:\\work\\a b').map((word) => word.text),
      ['D:/work/a b/git', 'push'],
    );
  });

  it('keeps a ~ bash does not expand to HOME as written, or leaves the binding unresolved', () => {
    const rows: readonly (readonly [line: string, expected: string])[] = [
      ['G="~/bin/git"; $G push', '~/bin/git push'],
      ["G='~'; $G push", '~ push'],
      ['G=~bob/git; $G push', '~$G push'],
      ['G=~+/git; $G push', '~$G push'],
      ['G=~"/git"; $G push', '~$G push'],
      ['G=~$B; $G push', '~$G push'],
      ['G=a:~/git; $G push', '~$G push'],
      ['G=~/a~b; $G push', '~$G push'],
    ];
    for (const [line, expected] of rows) {
      assert.equal(pushCommand(line, HOME), expected, line);
    }
  });

  it('keeps HOME unknown when the line assigns it in a way it does not follow, or the caller does not know it', () => {
    for (const line of [
      'HOME=/h true; $HOME/git push',
      'HOME=/a; HOME=/b; $HOME/git push',
      'HOME+=/x; $HOME/git push',
      'for HOME in /a; do :; done; $HOME/git push',
      '(HOME=/h); G=~/git; $G push',
    ]) {
      assert.match(pushCommand(line, HOME), /^~/, line);
    }
    // A program with an unknown piece stays the variable, as for `G=$C/git`; elsewhere the piece shows as HOME.
    assert.equal(pushCommand('G=~/git; $G push'), '~$G push');
    assert.equal(pushCommand('G=~/r; git -C $G push'), 'git -C ~${HOME}/r push');
    assert.equal(pushCommand('$HOME/git push'), '~$HOME/git push');
  });
});

describe('resolveLiteralVariables: what stays unresolved', () => {
  it('keeps a variable it cannot prove literal', () => {
    for (const line of [
      'git push origin $B',
      'B=feat git push origin $B',
      'B=$(git rev-parse --abbrev-ref HEAD); git push origin $B',
      'B=$OTHER; git push origin $B',
      'B="feat$C"; git push origin $B',
      'B=`echo feat`; git push origin $B',
      "B='ma*'; git push origin $B",
      "B='a?'; git push origin $B",
      "B='a(b)'; git push origin $B",
      "B='a\\b'; git push origin $B",
      'B=a; B="$B"; git push origin $B',
      'B=feat; B="$C"; git push origin $B',
      'B=~/x; git push origin $B',
      'B=; git push origin $B',
      "B=''; git push origin $B",
      "'B'=feat; git push origin $B",
      '\\B=feat; git push origin $B',
      'B+=feat; git push origin $B',
      'B=feat; B+=x; git push origin $B',
      'B=feat; B=main; git push origin $B',
      'B=feat; export B=main; git push origin $B',
      'B=feat; (B=main); git push origin $B',
      'B=feat; x=$(B=main); git push origin $B',
      'B=feat >/dev/null; git push origin $B',
      'export B=feat 2>/dev/null; git push origin $B',
      'B=feat; env B=main true; git push origin $B',
      'B=feat; exec {B}>/tmp/fd; git push origin $B',
      '_=feat; git push origin $_',
      'PWD=feat; git push origin $PWD',
      'BASH_X=feat; git push origin $BASH_X',
      'B=feat; git push origin $B$1',
      'B=feat; git push origin {$B,x}',
      'B=feat; git push origin ${B:-main}',
    ]) {
      assert.match(pushCommand(line), /~/, line);
    }
  });

  it('keeps every variable of a line that can set one unseen', () => {
    for (const line of [
      'for B in main; do :; done; B=feat; git push origin $B',
      'function f { :; }; B=feat; git push origin $B',
      'B=feat; read B; git push origin $B',
      'B=feat; source ./set.sh; git push origin $B',
      'B=feat; . ./set.sh; git push origin $B',
      'B=feat; eval "B=main"; git push origin $B',
      'B=feat; declare -u B; git push origin $B',
      'B=feat; let B=1; git push origin $B',
      'B=feat; : $((B=1)); git push origin $B',
      'B=feat; (( B = 1 )); git push origin $B',
      'B=feat; : $[B=1]; git push origin $B',
      'B=feat; : ${B:=main}; git push origin $B',
      'B=feat; : ${C:-x} ${B=main}; git push origin $B',
      'B=feat; : ${C:B=1}; git push origin $B',
      'B=feat; : ${A[B=1]}; git push origin $B',
      'B=feat; : ${!R}; git push origin $B',
      'B=feat; : ${R@P}; git push origin $B',
      'B=feat; : ${C:-$((B=1))}; git push origin $B',
      'B=feat; printf -v B main; git push origin $B',
      'B=feat; printf "$F" x; git push origin $B',
      'B=feat; export -n B; git push origin $B',
      'B=feat; export "$X"; git push origin $B',
      'B=feat; export C=$X; git push origin $B',
      'B=feat; export C=x{,B=main}; git push origin $B',
      'B=feat; export C="$(echo x)"; git push origin $B',
      'B=feat; $SET; git push origin $B',
      'P="export B=main"; B=feat; $P; git push origin $B',
      'P=export; A=B=main; B=feat; $P $A; git push origin $B',
      'P=printf; B=feat; $P -v B main; git push origin $B',
      'P=read; B=feat; $P B; git push origin $B',
      'P="$Q"; B=feat; $P; git push origin $B',
      '(P=true); B=feat; $P; git push origin $B',
      'P=""; B=feat; $P; git push origin $B',
      'B=feat; a[0]=x; git push origin $B',
      'B=feat; IFS=-; git push origin $B',
      'B=feat; cat <<EOF\n${B:=main}\nEOF\ngit push origin $B',
      'B=feat; cat <<< "$((B = 1))"; git push origin $B',
      'cat <<$D\nB=feat\n$D\ngit push origin $B',
      'cat <<EOF\nB=feat\ngit push origin $B',
      'B=feat; wait -p B; git push origin $B',
      'B=feat; trap "B=main" DEBUG; git push origin $B',
    ]) {
      assert.match(pushCommand(line), /~\$/, line);
    }
  });

  it('keeps a loop variable, a binding in a compound command, and every variable of a compound it does not follow', () => {
    for (const line of [
      'for B in main; do git push origin $B; done',
      'for x in a; do B=feat; done; git push origin $B',
      'for x in a; do B=feat; git push origin $B; done',
      'for x in a; do export B=feat; done; git push origin $B',
      'while a; do B=feat; done; git push origin $B',
      'until B=feat; do :; done; git push origin $B',
      'if a; then B=feat; fi; git push origin $B',
      'if B=feat; then git push origin $B; fi',
      'if a; then :; else B=feat; fi; git push origin $B',
      '{ B=feat; }; git push origin $B',
      'if true; then B=main; fi; B=feat; git push origin $B',
      'f() { B=main; }; B=feat; f; git push origin $B',
      '! B=feat; git push origin $B',
      'B=feat; for x in a; do :; git push origin $B',
      'B=feat; for x in a\ngit push origin $B',
      'B=feat; do :; done; git push origin $B',
      'B=feat; :; done; git push origin $B',
      'B=feat; for $X in a; do :; done; git push origin $B',
      'B=feat; for x y; do :; done; git push origin $B',
      'B=feat; for; do :; done; git push origin $B',
      'B=feat; for x in a; do :; done x; git push origin $B',
      'B=feat; for x in a; do echo $(done); git push origin $B',
      'B=feat; if a; then :; git push origin $B',
      'B=feat; then :; fi; git push origin $B',
      'B=feat; if a; then :; done; git push origin $B',
      'B=feat; if a; else :; fi; git push origin $B',
      'B=feat; while a; then :; fi; git push origin $B',
      'B=feat; if a; then (:; fi); git push origin $B',
      'B=feat; { :; } x; git push origin $B',
      'B=feat; "if" a; then :; fi; git push origin $B',
      'B=feat; if a; then \\fi; fi; git push origin $B',
      'B=feat; case a in a) :;; esac; git push origin $B',
      'B=feat; select x in a; do :; done; git push origin $B',
      'for (( i = 0; i < 2; i++ )); do :; done; B=feat; git push origin $B',
    ]) {
      assert.match(pushCommand(line), /~\$/, line);
    }
  });

  it('keeps a binding that may not have run, or ran in another shell', () => {
    for (const line of [
      'false && B=feat; git push origin $B',
      'false || B=feat; git push origin $B',
      'B=feat & git push origin $B',
      'B=feat && true & git push origin $B',
      'B=feat | git push origin $B',
      'echo x | B=feat; git push origin $B',
      'true || B=feat && git push origin $B',
      'true && B=feat || git push origin $B',
      'false || false && B=feat; git push origin $B',
      '(B=feat); git push origin $B',
      '(true) && B=feat; git push origin $B',
      '(true) > $(echo out) || B=feat; git push origin $B',
      'B=feat & (git push origin $B)',
      'B=feat | (git push origin $B)',
      'git push origin $B; B=feat',
      'B=feat | true $(date); git push origin $B',
      '[ "$(git rev-parse HEAD)" = x ] || B=feat && git push origin $B',
      'echo "$(B=feat)" && git push origin $B',
    ]) {
      assert.match(pushCommand(line), /~\$/, line);
    }
  });

  it('keeps a nested script apart from the line around it', () => {
    assert.equal(pushCommand("B=feat; bash -c 'git push origin $B'"), 'bash -c git push origin $B');
    assert.match(pushCommand("bash -c 'B=feat'; git push origin $B"), /~\$B/);
  });
});
