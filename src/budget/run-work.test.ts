import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkOf, shellLineRunsOf, shellRunsOf, teamrigArgsOf, type RunWork } from './run-work.ts';

/** What each program a Bash line starts does, in order; `-` for a program that does none of it. */
function worksOf(command: string, name = 'Bash'): readonly (RunWork | '-')[] {
  return shellRunsOf({ name, command }).map((run) => runWorkOf(run) ?? '-');
}

describe('shellRunsOf', () => {
  it('reads the programs of a Bash or PowerShell call, and none of any other tool or a call without a command', () => {
    assert.deepEqual(
      shellRunsOf({ name: 'Bash', command: 'cd /repo && git status | grep x' }).map((run) => run.name),
      ['git', 'grep'],
    );
    assert.deepEqual(
      shellRunsOf({ name: 'PowerShell', command: 'Set-Location C:\\repo; npx.cmd tsc' }).map((run) => run.name),
      ['npx'],
    );
    assert.deepEqual(shellRunsOf({ name: 'Read', command: 'git status' }), []);
    assert.deepEqual(shellRunsOf({ name: 'Bash', command: undefined }), []);
  });
});

describe('shellLineRunsOf', () => {
  it('keeps what a call runs that it cannot read beside its programs', () => {
    assert.deepEqual(shellLineRunsOf({ name: 'Bash', command: '$X list' })?.opaque.map((run) => run.program.text), ['$X']);
    assert.deepEqual(shellLineRunsOf({ name: 'Bash', command: 'git status' })?.programs.map((run) => run.name), ['git']);
  });

  it('is undefined for any other tool and a call without a command', () => {
    assert.equal(shellLineRunsOf({ name: 'Read', command: 'git status' }), undefined);
    assert.equal(shellLineRunsOf({ name: 'Bash', command: undefined }), undefined);
  });
});

describe('teamrigArgsOf', () => {
  it("reads a teamrig command's own arguments, through node and teamrig's build too, and none of any other program", () => {
    const argsOf = (command: string) => shellRunsOf({ name: 'Bash', command }).map((run) => teamrigArgsOf(run)?.map((word) => word.text) ?? '-');
    assert.deepEqual(argsOf('teamrig.cmd set T1 --note "a b"; node "C:\\kit\\dist\\cli\\main.js" show T2'), [
      ['set', 'T1', '--note', 'a b'],
      ['show', 'T2'],
    ]);
    assert.deepEqual(argsOf('node cli.js show T3; node "$KIT" show T4; echo teamrig; git log'), ['-', '-', '-', '-']);
  });
});

describe('runWorkOf', () => {
  it('reads git: apply patches the files, other writes change the repository, grep over files searches', () => {
    assert.deepEqual(worksOf('git apply fix.patch; git -C /repo -c a=b commit -m x; git --config-env a=B push'), ['gitPatch', 'gitWrite', 'gitWrite']);
    assert.deepEqual(worksOf('git grep -n foo; git log | git grep x; git status; git $SUB'), ['search', '-', '-', '-', '-']);
  });

  it('reads an edit by the program that writes: a cat into a file, sed or perl in place, patch, a PowerShell write', () => {
    assert.deepEqual(worksOf('cat > a.ts <<EOF\nx\nEOF'), ['edit']);
    assert.deepEqual(worksOf('cat a.ts > /dev/null; cat a.ts > NUL; cat a.ts >> "$OUT"'), ['-', '-', 'edit']);
    assert.deepEqual(worksOf("sed -i 's/a/b/' a.ts; sed -n 1,5p a.ts; perl -pi -e 's/a/b/' a.ts; patch -p1 < fix.patch"), ['edit', '-', 'edit', 'edit']);
    assert.deepEqual(worksOf('Set-Content -Path a.txt -Value b; Out-File b.txt; Get-Content a.txt', 'PowerShell'), ['edit', 'edit', '-']);
  });

  it('reads npm: its test command and test scripts run the suite, build scripts build, others neither', () => {
    assert.deepEqual(worksOf('npm test; npm t; npm --prefix app tst'), ['testFull', 'testFull', 'testFull']);
    assert.deepEqual(worksOf('npm run test:unit; npm run-script verify; npm run coverage; npm run check'), ['testFull', 'testFull', 'testFull', 'testFull']);
    assert.deepEqual(worksOf('npm run build; npm run typecheck; npm run lint:fix; npm run build:dist'), ['build', 'build', 'build', 'build']);
    assert.deepEqual(worksOf('npm ci; npm run dev; npm run; npm run $SCRIPT; npm $CMD; npm'), ['-', '-', '-', '-', '-', '-']);
  });

  it('reads an npm test given files, before or after --, as the tests it names, and one given only options as the suite', () => {
    assert.deepEqual(worksOf('npm test -- src/a.spec.ts; npm run test:unit -- --runInBand src/a.spec.ts; npm t src/a.spec.ts'), [
      'testTargeted',
      'testTargeted',
      'testTargeted',
    ]);
    assert.deepEqual(worksOf('npm test -- --runInBand; npm run test:unit --silent; npm test --prefix app; npm test -- -t adds'), [
      'testFull',
      'testFull',
      'testFull',
      'testFull',
    ]);
  });

  it('reads jest, vitest and tsc wherever they start: on the path, through npx, or as the script node runs', () => {
    assert.deepEqual(worksOf('jest; vitest run; tsc -p .'), ['testFull', 'testFull', 'build']);
    assert.deepEqual(worksOf('npx --package typescript tsc --noEmit; npx jest; npx eslint .; npx'), ['build', 'testFull', '-', '-']);
    assert.deepEqual(worksOf('node node_modules/typescript/bin/tsc -p .; node C:/app/node_modules/vitest/vitest.mjs run'), ['build', 'testFull']);
  });

  it('reads jest or vitest given files, a folder or a path filter as the tests it names, and one given only options as the suite', () => {
    assert.deepEqual(worksOf('npx jest src/a.spec.ts; npx --no -- jest src/a src/b; npx jest -c cli/jest.config.ts cli/x.spec.ts; jest --runInBand src/x.spec.ts'), [
      'testTargeted',
      'testTargeted',
      'testTargeted',
      'testTargeted',
    ]);
    assert.deepEqual(worksOf('vitest run src/a.test.ts; npx vitest src/a; npx jest --testPathPattern=spec/a; npx jest $SPECS'), [
      'testTargeted',
      'testTargeted',
      'testTargeted',
      'testTargeted',
    ]);
    assert.deepEqual(worksOf('npx jest --config j.config.ts --maxWorkers 1; npx jest -c jest.config.ts; vitest run; npx vitest --config v.config.ts run; jest -t adds'), [
      'testFull',
      'testFull',
      'testFull',
      'testFull',
      'testFull',
    ]);
    assert.deepEqual(worksOf('node node_modules/jest/bin/jest.js src/a.spec.ts; node C:/app/node_modules/vitest/vitest.mjs run src/a.test.ts'), ['testTargeted', 'testTargeted']);
  });

  it('reads node --test: the full suite with no files or over a whole source folder, else the files it names', () => {
    assert.deepEqual(worksOf('node --test; node --test "src/**/*.test.ts"; node --test ./tools/**/*.test.ts'), ['testFull', 'testFull', 'testFull']);
    assert.deepEqual(worksOf('node --disable-warning=ExperimentalWarning --test src/a.test.ts src/b.test.ts'), ['testTargeted']);
    assert.deepEqual(worksOf('node cli.js --test; node --test-reporter=spec cli.js'), ['-', '-']);
  });

  it('reads a node script given on the line or on stdin that calls writeFileSync as an edit, and a script file by what it is', () => {
    assert.deepEqual(worksOf(`node -e "require('fs').writeFileSync('a', 'b')"; node --print="fs.writeFileSync('a', '')"`), ['edit', 'edit']);
    assert.deepEqual(worksOf(`node -e "console.log(1)"; node -p "readFileSync" a.ts; node -e x b.js`), ['-', '-', '-']);
    assert.deepEqual(worksOf("node - <<'EOF'\nfs.writeFileSync('a', '')\nEOF"), ['edit']);
    assert.deepEqual(worksOf("cat <<'EOF' | node\nfs.writeFileSync('a', '')\nEOF"), ['-', 'edit']);
    assert.deepEqual(worksOf("node - <<'EOF'\nconsole.log(1)\nEOF"), ['-']);
    assert.deepEqual(worksOf("node a.js <<'EOF'\nwriteFileSync\nEOF"), ['-']);
    assert.deepEqual(worksOf('node; node "$SCRIPT"; node dist/cli/main.js list; node "C:\\kit\\dist\\cli\\main.js" show T1'), ['-', '-', 'teamrig', 'teamrig']);
  });

  it('reads a teamrig command on the register, not the words it quotes, nor its other commands', () => {
    assert.deepEqual(worksOf('teamrig add --description "npm ci, jest and build"; teamrig.cmd set T1 --note "git commit"'), ['teamrig', 'teamrig']);
    assert.deepEqual(worksOf('teamrig start --session a; teamrig'), ['-', '-']);
    assert.deepEqual(worksOf('teamrig queue --what t -- teamrig test -- npm test'), ['testFull']);
  });

  it('reads a search over files, but not one that filters a pipe or has nothing to search', () => {
    assert.deepEqual(worksOf('grep -rn foo src; rg foo; find . -name x'), ['search', 'search', 'search']);
    assert.deepEqual(worksOf('ls | grep x; grep'), ['-', '-', '-']);
    assert.deepEqual(worksOf('Select-String -Path a.ts -Pattern x; Get-Content a.log | Select-String x', 'PowerShell'), ['search', '-', '-']);
  });
});
