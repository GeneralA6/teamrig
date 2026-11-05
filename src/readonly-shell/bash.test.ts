import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../push-guard/tokenizer.ts';
import { DASH_QUOTES, NOTHING_QUOTES } from '../testing/ansi-c-quotes.ts';
import { argumentOf, bashLineReads, boundArgumentOf } from './bash.ts';
import { prefixWords, type ReadonlyRules } from './rules.ts';

const RULES: ReadonlyRules = {
  prefixes: ['npx tsc --noEmit', 'npx jest'].map(prefixWords),
  exported: new Set(['PATH', 'HOME', 'npm_config_prefix']),
  exportsAll: false,
};

/** Asserts each line reads (`expected` true) or not, naming the line on failure. */
function expectAll(lines: readonly string[], expected: boolean, rules: ReadonlyRules = RULES): void {
  for (const line of lines) {
    assert.equal(bashLineReads(line, rules), expected, line);
  }
}

describe('bashLineReads', () => {
  it('allows reading pipelines, lists and multi-line scripts', () => {
    expectAll(
      [
        'cd C:/repo && grep -n "constructor(" src/a.ts | head -2',
        'grep -rn "DatabaseService" src | head -20',
        "sed -n '1,45p' scripts/a.ts",
        'sed -n "10,+5p" file.ts',
        'cat file.ts | wc -l',
        'grep "=>" src/file.ts',
        'cd /c/x && grep -n "a" f || echo none',
        'head -1 README.md; tail -2 README.md',
        'grep -n "x" f | cut -d: -f1 | tr -d " "',
        "sed -n '/private async load/,/^  }/p' src/a.ts | head -40",
        'cd /c/repo\ngrep -n "load\\|save" src/a.ts | head\nsed -n \'/private async load/,/^  }/p\' src/a.ts | head -40',
        "awk '{print $1, $2}' file.txt",
        "awk -F: '{print $1}' /etc/passwd",
        'test -f file.ts && echo exists',
        '{ grep x f; grep y f; }',
        '! grep -q x f',
        'grep -c x f 2>&1 | tail -5; echo "grep exit ${PIPESTATUS[0]}"',
      ],
      true,
    );
  });

  it("judges an option behind a $'...' string as the option bash gives the program", () => {
    expectAll(NOTHING_QUOTES.flatMap((quote) => [`sort ${quote}-o out in`, `git log ${quote}--output=out`]), false);
    expectAll(DASH_QUOTES.flatMap((dash) => [`sort ${dash}o out in`, `git log ${dash}-output=out`]), false);
    expectAll(NOTHING_QUOTES.flatMap((quote) => [`sort ${quote}in`, `git log ${quote}--oneline`]), true);
  });

  it('allows git and kubectl reads, loops that poll them and the path conversion switches', () => {
    expectAll(
      [
        'cd /c/repo\ngit diff src/a.ts | head -40',
        'git diff --stat\ngit diff src/a.ts | grep -cE "^[+-][^+-]"',
        'git -C "C:/repo" log --oneline -5 | head -3',
        'git --no-pager diff HEAD~1 -- src/file.ts',
        'git show HEAD:src/file.ts | head -20',
        'git grep -n "DatabaseService" -- "*.ts" | wc -l',
        'until kubectl logs -n app sync-worker-abc --since=6m 2>/dev/null | grep -qE "completed: [1-9][0-9]"; do sleep 20; done',
        'kubectl get pods -n app | grep worker',
        "kubectl get pods --no-headers | awk '{print}' | sort -u",
        'kubectl rollout status deploy/worker -n app',
        'while ! grep -q "ready" status.log 2>/dev/null; do sleep 5; done',
        'if grep -q "x" f; then echo found; else echo missing; fi',
        'MSYS_NO_PATHCONV=1 kubectl get pods -n app',
        'kubectl get pods -n app -o custom-columns=NAME:.metadata.name,IMG:.spec.containers[0].image | grep worker',
        'kubectl get pods -o jsonpath={.items[*].metadata.name}',
        'MSYS2_ARG_CONV_EXCL="*" git log -1',
      ],
      true,
    );
  });

  it('allows the line its own lower-case variables, loops over words and substitutions that read', () => {
    expectAll(
      [
        'pod=my-pod-123',
        'x=1; x+=2; echo "$x"',
        "rc=$(kubectl get pod -n app my-pod --no-headers | awk '{print $4}')",
        '[ -z "$rc" ]',
        'for f in a b; do cat $f; done',
        'for f; do cat "$f"; done',
        'grep -f <(echo foo) file',
        // An upper-case name off bash's, MSYS's and the listed programs' families is the line's own too.
        'POD=my-pod-123; S=C:/scratch',
        'for F in a b; do cat $F; done',
      ],
      true,
    );
  });

  it("reads a variable the line sets once, statically and always, as that value from then on", () => {
    expectAll(
      [
        'pod=x; kubectl logs -n app $pod --since=2m',
        'ns=app && kubectl get pods -n "$ns"',
        "s='1,5p'; sed -n \"$s\" a.ts",
        'S=C:/scratch\nsed -n 1p "$S/x.txt" | head -1',
        'out=C:/tmp/x; kubectl get pods -n app > /dev/null; kubectl logs -n app "${out}"',
        's=1p; for f in a b; do sed -n $s a.ts; done',
        's=1p; x=$(sed -n $s f); echo "$x"',
        'if true; then echo; fi; s=1p; sed -n $s f',
        // A quoted use takes the value as it is, blanks and glob characters included.
        "q='a b*'; kubectl get pods -l \"$q\"",
      ],
      true,
    );
  });

  it('leaves a variable dynamic where its value may not hold: used first, set twice, conditionally or in a subshell', () => {
    expectAll(
      [
        'sed -n $s w.txt; s=1p',
        's=1p; s=w.txt; sed -n $s f',
        's=1p; s+=w; sed -n $s f',
        'for s in w; do echo; done; s=1p; sed -n $s f',
        'false && s=1p; sed -n $s w.txt',
        'false || s=1p; sed -n $s w.txt',
        's=1p | cat; sed -n $s w.txt',
        's=1p & sed -n $s w.txt',
        '(s=1p); sed -n $s w.txt',
        '{ s=1p; }; sed -n $s w.txt',
        'if true; then s=1p; fi; sed -n $s w.txt',
        'while false; do s=1p; done; sed -n $s w.txt',
        'echo $(s=1p); sed -n $s w.txt',
        's=1p x=$(sed -n $s w.txt)',
      ],
      false,
    );
  });

  it("leaves a variable dynamic when its value is not plain text: expanded, a flag, an array or a split unquoted use", () => {
    expectAll(
      [
        'pod=$(kubectl get pods -n app -o name | head -1); kubectl logs -n app $pod',
        'p=~x; kubectl logs $p -n app',
        's=-n; sed $s 1p f',
        's=; sed -n "$s" f',
        "s='1p w'; sed -n $s f",
        "g='p*'; kubectl get pods $g",
        'p=cat; $p f',
        'n=app; kubectl get pods -n ${n:-x}',
      ],
      false,
    );
  });

  it('allows redirections that write nothing', () => {
    expectAll(['grep -c "foo" file 2>/dev/null', 'grep foo file 2>&1 | head -5', 'grep x f >&2', 'grep x f >& 2', 'grep x f 2>&-', 'grep x f 2>& -', 'grep x < input.txt'], true);
  });

  it('refuses a descriptor redirection that names a file instead', () => {
    expectAll(['grep x f >& out.txt', 'grep x f >&$fd'], false);
  });

  it('reads expansion-like text in quotes as text', () => {
    expectAll(['grep "<(" file', "grep '\\${ x' file", 'grep "${VAR}" file', 'grep "${VAR:-default value}" file'], true);
  });

  it('allows a configured prefix with whatever arguments follow it', () => {
    expectAll(
      [
        'cd /c/repo && npx tsc --noEmit 2>&1 | head -20',
        'npx jest src/a.spec.ts 2>&1 | tail -5',
        // The team vouches for a prefix's arguments: jest writes this file.
        'npx jest --outputFile=results.json src/x.spec.ts',
      ],
      true,
    );
    expectAll(['npx tsc --noEmit', 'npx jest'], false, { prefixes: [], exported: new Set(), exportsAll: false });
  });

  it('refuses programs off the list and any write or run', () => {
    expectAll(
      [
        'rm -rf /',
        'grep foo file > out.txt',
        'grep foo file >> out.txt',
        'grep x f <> f',
        'grep x f > "$out"',
        "sed -i 's/a/b/' file",
        'cat f && curl http://example.com',
        'grep foo "$(rm -rf /)" file',
        'echo `rm x`',
        'sort -o out.txt in.txt',
        'find . -name "*.ts" -delete',
        'cat <(rm -rf /tmp/x)',
        'cat < <(rm -rf /tmp/x)',
        'cat >(rm -rf /tmp/x)',
        'echo ${ rm -rf /tmp/x; }',
        'echo "${ rm -rf /tmp/x; }"',
        'grep "${| rm -rf /tmp/x; }" file',
        'git push origin main',
        'git -c diff.external="rm -rf /" diff',
        'kubectl delete pod x -n app',
        'kubectl -n app logs pod-x',
        // A bracket glob kubectl may get as another text: a letter (either case under nocaseglob), a wider glob, a variable.
        'kubectl get pods -o custom-columns=IMG:.spec.containers[a].image',
        'kubectl get pods -o jsonpath={.items[*]}*',
        'kubectl get pods "$x"[0]',
        'kubectl get secret[0]',
        "awk '{system(\"rm -rf /\")}' file",
      ],
      false,
    );
  });

  it('refuses here-documents, function definitions and lines it cannot read', () => {
    expectAll(['cat <<EOF\nhello\nEOF', 'cat <<< hello', 'f() { ls; }', '', ';', 'grep "unterminated f', 'echo $((x=1))', 'grep x f {fd}>/dev/null'], false);
  });

  it('refuses a program a variable or a quoted keyword names', () => {
    expectAll(['for p in rm; do $p -rf /tmp/x; done', '"$prog" x', '"if" true'], false);
  });

  it('refuses loops that run, or set a name the line may not', () => {
    expectAll(
      [
        'until rm -rf /tmp/x; do sleep 1; done',
        'while true; do curl http://evil; done',
        'for f in $(rm -rf /tmp/x); do echo $f; done',
        'for ((i=0; i<5; i++)); do echo $i; done',
        'for PATH in /x; do ls; done',
        'for npm_config_prefix in x; do ls; done',
        'for 1x in a; do ls; done',
        'for f of a; do ls; done',
      ],
      false,
    );
  });

  it('refuses assignments bash or a program reads, and subscripts, which bash evaluates', () => {
    expectAll(
      [
        // bash's own names, and the families a listed program reads (names.ts).
        'IFS=x',
        'PATH=/tmp/x; git status',
        'GIT_PAGER=x; git log',
        'S=1; TMPDIR=/tmp/x; sort f',
        // An exported name reaches every program the line runs.
        'npm_config_prefix=/tmp/x',
        'a[i]=1',
        'x=$(rm -rf /tmp/y)',
      ],
      false,
    );
  });

  it('refuses a line that exports, or turns on export of every assignment', () => {
    expectAll(['set -a; S=x; git log', 'set -o allexport; S=x', 'export S=x; git log', 'declare -x S=x', 'typeset -x S=x', 'S=x; export S'], false);
  });

  it("refuses every assignment under the snapshot's set -a", () => {
    expectAll(['pod=x', 'S=x; cat f'], false, { ...RULES, exportsAll: true });
  });

  it('refuses any variable set for a program but the path conversion switches, static and without a subscript', () => {
    expectAll(
      [
        'FOO=bar grep x f',
        'x=1 grep a f',
        'x=1 rm -rf /tmp/y',
        'MSYS_NO_PATHCONV=1 rm -rf /tmp/y',
        'GIT_PAGER="rm -rf /" git diff',
        'MSYS_NO_PATHCONV=$x kubectl get pods',
        "i='a[$(rm -rf /tmp/x)]'; MSYS_NO_PATHCONV[i]=1 kubectl get pods",
      ],
      false,
    );
  });

  it('refuses what the hook it replaces allowed but cannot be proven to read', () => {
    expectAll(
      [
        // A sed script a substitution builds.
        'sed -n "$(grep -n \'constructor(\' src/a.ts | head -1 | cut -d: -f1),+14p" src/a.ts',
        // kubectl given a variable a substitution sets, which could hold --server or --kubeconfig.
        'pod=$(grep -m1 pod f); kubectl logs -n app $pod --since=2m',
        // kubectl exec runs any program in the pod, a database shell's script included.
        "kubectl exec -n app db-0 -- psql app -c 'select count(*) from models'",
        // npx past the configured prefixes.
        'npx tsc -p tsconfig.build.json | head -5',
        'npx prettier --write src/',
        'npx -p evil-pkg jest',
        'npx eslint src/ -o report.txt',
      ],
      false,
    );
  });
});

describe('argumentOf', () => {
  const firstArgument = (line: string) => {
    const word = parseShell(line, 'bash').commands[0]?.words[1];
    assert.ok(word, line);
    return argumentOf(word);
  };

  it('keeps plain and quoted text static and single', () => {
    assert.deepEqual(firstArgument('echo plain'), { text: 'plain', dynamic: false, single: true });
    assert.deepEqual(firstArgument('echo "a b*"'), { text: 'a b*', dynamic: false, single: true });
  });

  it('marks a quoted variable dynamic but single, an unquoted variable or glob neither', () => {
    assert.deepEqual(firstArgument('echo "$x"'), { text: '$x', dynamic: true, single: true });
    assert.equal(firstArgument('echo $x').single, false);
    assert.deepEqual(firstArgument('echo *.ts'), { text: '*.ts', dynamic: true, single: false });
  });

  it('reads the one file a glob of one-digit or * brackets can match, quoted text kept as written', () => {
    assert.deepEqual(firstArgument('echo a[0]b'), { text: 'a[0]b', dynamic: true, single: false, bracketMatch: 'a0b' });
    assert.equal(firstArgument('echo items[*]').bracketMatch, 'items*');
    assert.equal(firstArgument('echo "x[*]"[0]').bracketMatch, 'x[*]0');
  });

  it('reads no match for any other glob, a letter in brackets or a variable', () => {
    for (const line of ['echo a[0]*', 'echo a[x]', 'echo a[01]', 'echo a[[0]]', 'echo "$x"[0]', 'echo plain']) {
      assert.equal(firstArgument(line).bracketMatch, undefined, line);
    }
  });
});

describe('boundArgumentOf', () => {
  const VALUES: Readonly<Record<string, string>> = { out: 'C:/tmp', spaced: 'a b' };
  const bound = (line: string) => {
    const word = parseShell(line, 'bash').commands[0]?.words[1];
    assert.ok(word, line);
    return boundArgumentOf(word, (name) => VALUES[name]);
  };

  it('reads known variables as their values, static and single', () => {
    assert.deepEqual(bound('echo "$out/a.log"'), { text: 'C:/tmp/a.log', dynamic: false, single: true });
    assert.deepEqual(bound('echo ${out}/x'), { text: 'C:/tmp/x', dynamic: false, single: true });
    assert.deepEqual(bound('echo "$spaced"'), { text: 'a b', dynamic: false, single: true });
  });

  it('reads a word as argumentOf does when a variable is unknown, an unquoted value would split or no variable is in it', () => {
    assert.deepEqual(bound('echo "$other/x"'), { text: '$other/x', dynamic: true, single: true });
    assert.equal(bound('echo $spaced').dynamic, true);
    assert.equal(bound('echo "$out"*.ts').dynamic, true);
    assert.deepEqual(bound('echo plain'), { text: 'plain', dynamic: false, single: true });
  });
});
