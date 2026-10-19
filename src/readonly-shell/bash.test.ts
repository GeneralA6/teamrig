import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../push-guard/tokenizer.ts';
import { argumentOf, bashLineReads } from './bash.ts';
import { prefixWords, type ReadonlyRules } from './rules.ts';

const RULES: ReadonlyRules = {
  prefixes: ['npx tsc --noEmit', 'npx jest'].map(prefixWords),
  exported: new Set(['PATH', 'HOME', 'npm_config_prefix']),
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
      ],
      true,
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
    expectAll(['npx tsc --noEmit', 'npx jest'], false, { prefixes: [], exported: new Set() });
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
        // Upper-case names are bash's own (PATH, IFS, BASH_ENV...), so the line may set none.
        'POD=my-pod-123',
        'IFS=x',
        // An exported name reaches every program the line runs.
        'npm_config_prefix=/tmp/x',
        'a[i]=1',
        'x=$(rm -rf /tmp/y)',
      ],
      false,
    );
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
        // kubectl given a variable, which could hold --server or --kubeconfig.
        'pod=x; kubectl logs -n app $pod --since=2m',
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
});
