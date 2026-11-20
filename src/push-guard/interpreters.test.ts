import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpreterText, isDevicePath, isTestPath, MAX_LINE_SCRIPT_BYTES, readScriptFile, scriptMayPush, trustedScriptMatcher } from './interpreters.ts';
import type { ProgramLaunch } from './launchers.ts';
import { findGitInvocations, type FinderContext } from './invocations.ts';

// Interpreter scripts are judged by their text, not read as shell words.

function context(files: Record<string, string> = {}): FinderContext {
  return {
    cwd: '/work/app',
    home: '/u',
    dialect: 'bash',
    git: { config: () => ({ kind: 'unset' }) },
    // On Windows the guard joins the folder as C:\work\app\...; the files here are keyed by their POSIX form.
    readScript: (path) => files[path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')],
  };
}

const PY_POST = [
  "python3 - <<'PY'",
  'import json,urllib.request',
  "c=json.load(open('settings.json'))",
  'body="Verified; pushed as PR 61. Do not git push to main, push your branch."',
  "r=urllib.request.Request(f\"http://localhost:{c['port']}/notes/n/messages\",method=\"POST\",data=json.dumps({'body':body}).encode())",
  'print(urllib.request.urlopen(r,timeout=15).read())',
  'PY',
].join('\n');

describe('scriptMayPush', () => {
  it('passes a script that only talks about pushes, or reaches git without pushing', () => {
    assert.equal(scriptMayPush('print("please git push your branch")', 'python'), false);
    assert.equal(scriptMayPush('import subprocess\nsubprocess.run(["git", "status"])', 'python'), false);
    assert.equal(scriptMayPush('const a = []; a.push(1); require("child_process").execSync("ls")', 'JavaScript'), false);
    assert.equal(scriptMayPush('const s = `push ${x}`; console.log(s)', 'JavaScript'), false);
  });

  it('flags a push word with a process primitive, a git library, or a backtick in perl, ruby or php', () => {
    assert.equal(scriptMayPush('import subprocess\nsubprocess.run(["git", "push", "origin", "main"])', 'python'), true);
    assert.equal(scriptMayPush('import os; os.system("git push origin main")', 'python'), true);
    assert.equal(scriptMayPush('import git\ngit.Repo(".").remotes.origin.push()', 'python'), true);
    assert.equal(scriptMayPush('from dulwich import porcelain\nporcelain.push(".", "origin", "main")', 'python'), true);
    assert.equal(scriptMayPush('require("child_process").execSync("git push origin main")', 'JavaScript'), true);
    assert.equal(scriptMayPush("import simpleGit from 'simple-git'; await simpleGit().push('origin', 'main')", 'JavaScript'), true);
    assert.equal(scriptMayPush('system("git push origin main")', 'perl'), true);
    assert.equal(scriptMayPush('`git push origin main`', 'ruby'), true);
  });
});

describe('findGitInvocations on interpreter scripts', () => {
  it('raises no doubt and no push mention for a python heredoc that posts a message saying push', () => {
    const found = findGitInvocations(PY_POST, context());
    assert.deepEqual(found.doubts, []);
    assert.equal(found.mentionsPush, false);
  });

  it('keeps prose fed to python from arming a doubt elsewhere: an unquoted heredoc whose backticks run a variable', () => {
    const found = findGitInvocations('python3 - <<EOF\nbody="run `$X` then push"\nEOF', context());
    assert.equal(found.mentionsPush, false);
    assert.ok(found.doubts.every((doubt) => doubt.gated), JSON.stringify(found.doubts));
  });

  it('doubts, ungated, a heredoc, -c, -e or script file that may push', () => {
    const doubting = [
      "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git', 'push', 'origin', 'main'])\nPY",
      'python3 -c \'import os; os.system("git push origin main")\'',
      'node -e \'require("child_process").execSync("git push origin main")\'',
      "perl -e 'system(\"git push origin main\")'",
      'python3 tools/ship.py',
      'cd tools && python3 ship.py',
    ];
    const files = { '/work/app/tools/ship.py': 'import subprocess\nsubprocess.check_call(["git", "push", "origin", "HEAD:main"])\n' };
    for (const command of doubting) {
      const found = findGitInvocations(command, context(files));
      assert.ok(
        found.doubts.some((doubt) => !doubt.gated && /script that may run git push/.test(doubt.reason)),
        `${command}: ${JSON.stringify(found.doubts)}`,
      );
    }
  });

  it('passes a script file it cannot read, and one that does not push', () => {
    assert.deepEqual(findGitInvocations('python3 missing.py', context()).doubts, []);
    const files = { '/work/app/ok.py': 'import subprocess\nsubprocess.run(["git", "status"])\n' };
    assert.deepEqual(findGitInvocations('python3 ok.py', context(files)).doubts, []);
  });

  it('still reads a shell fed a heredoc, and a program only known when it runs', () => {
    assert.ok(findGitInvocations("bash <<'X'\ngit push origin main\nX", context()).invocations.some((i) => i.subcommand === 'push'));
    const dynamic = findGitInvocations("\"$PY\" - <<'PY'\nprint('push')\nPY", context());
    assert.equal(dynamic.mentionsPush, true);
    assert.ok(dynamic.doubts.some((doubt) => doubt.gated));
  });
});

describe('readScriptFile', () => {
  it('reads a regular file, up to the bytes it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamrig-script-'));
    try {
      const file = join(dir, 'ship.py');
      writeFileSync(file, 'import subprocess\n');
      assert.equal(readScriptFile(file), 'import subprocess\n');
      assert.equal(readScriptFile(file, 6), 'import');
      assert.equal(readScriptFile(file, 0), undefined);
      assert.equal(readScriptFile(dir), undefined, 'a folder');
      assert.equal(readScriptFile(join(dir, 'missing.py')), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined at once for a FIFO, which an open would block on with no writer', { skip: process.platform === 'win32' ? 'no FIFO on Windows' : false }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamrig-fifo-'));
    try {
      const fifo = join(dir, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const started = Date.now();
      assert.equal(readScriptFile(fifo), undefined);
      assert.ok(Date.now() - started < 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reads a UNC, device or kernel path', () => {
    for (const path of ['\\\\server\\share\\x.py', '//server/share/x.py', '\\\\.\\pipe\\x', '\\\\?\\C:\\x.py', '/dev/stdin', '/dev/tcp/host/80', '/proc/self/environ', '/sys/x', 'C:\\work\\NUL', 'nul.txt', 'COM1', 'lpt3.py']) {
      assert.equal(isDevicePath(path), true, path);
    }
    for (const path of ['/work/app/ship.py', 'C:\\work\\ship.py', 'tools/null.py', 'console.py', '/devices/x.py']) {
      assert.equal(isDevicePath(path), false, path);
    }
    assert.equal(readScriptFile('/dev/zero'), undefined);
  });
});

describe('interpreterText: the read budget of a line', () => {
  it('reads the files of a line together up to the budget, then no more', () => {
    const read: string[] = [];
    const big = 'x'.repeat(600 * 1024);
    const files: Record<string, string> = { '/w/a.py': big, '/w/b.py': big, '/w/c.py': 'import subprocess' };
    const readScript = (path: string, maxBytes: number): string | undefined => {
      read.push(path);
      const body = files[path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')];
      return body?.slice(0, maxBytes);
    };
    const budget = { left: MAX_LINE_SCRIPT_BYTES };
    const launched = (script: string) => ({ kind: 'program', program: { text: 'python3', dynamic: false }, args: [{ text: script, dynamic: false }], env: [], chdirs: [], stdinArgs: false }) as unknown as ProgramLaunch;
    interpreterText(launched('/w/a.py'), undefined, '/w', readScript, budget);
    interpreterText(launched('/w/b.py'), undefined, '/w', readScript, budget);
    interpreterText(launched('/w/c.py'), undefined, '/w', readScript, budget);
    assert.equal(budget.left, 0);
    assert.deepEqual(read.length, 2, 'the third file is past the budget');
  });
});

describe('pushGuard.trustedScripts', () => {
  it('matches a name at any depth, a slashed glob from the session folder, and an absolute glob from the root', () => {
    const trusted = trustedScriptMatcher(['*.test.ts', 'tools/ship/*.ts', '/opt/tools/**'], '/work/app');
    assert.equal(trusted('/work/app/src/cli/main.test.ts'), true);
    assert.equal(trusted('/elsewhere/a.test.ts'), true, 'a name matches anywhere');
    assert.equal(trusted('/work/app/tools/ship/ship.ts'), true);
    assert.equal(trusted('/work/app/TOOLS/ship/Ship.ts'), true, 'case is ignored');
    assert.equal(trusted('/other/tools/ship/ship.ts'), false, 'a slashed glob reads only the session folder');
    assert.equal(trusted('/work/app/src/tools/ship/ship.ts'), false, 'and from its top');
    assert.equal(trusted('/opt/tools/bin/x.py'), true);
    assert.equal(trusted('/work/app/src/cli/main.ts'), false);
  });

  it('reads no push in a trusted script, and still reads an untrusted one', () => {
    const files = { '/work/app/tools/ship/ship.ts': 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["push", "origin", "HEAD"]);\n' };
    const asks = (trustedScripts: readonly string[]): boolean =>
      findGitInvocations('node tools/ship/ship.ts', { ...context(files), trustedScript: trustedScriptMatcher(trustedScripts, '/work/app') }).doubts.some((doubt) => /script that may run git push/.test(doubt.reason));
    assert.equal(asks([]), true);
    assert.equal(asks(['tools/ship/*.ts']), false);
    assert.equal(asks(['tools/other/*.ts']), true);
  });
});

describe('scriptMayPush: the process forms a review listed', () => {
  it("flags python's asyncio subprocesses, perl's piped open and ruby's open of a pipe", () => {
    for (const [text, language] of [
      ["import asyncio\nasyncio.run(asyncio.create_subprocess_exec('git', 'push', 'origin', 'main'))", 'python'],
      ["import asyncio\nawait asyncio.create_subprocess_shell('git push origin main')", 'python'],
      ['open(FH, "git push origin main |") or die;', 'perl'],
      ["open(my $fh, '-|', 'git', 'push', 'origin', 'main');", 'perl'],
      ["open my $fh, '|-', 'git push origin main';", 'perl'],
      ['open("|git push origin main")', 'ruby'],
    ] as const) {
      assert.equal(scriptMayPush(text, language), true, text);
    }
  });

  it('leaves a plain file open alone', () => {
    assert.equal(scriptMayPush("open(my $fh, '<', 'notes.txt'); print 'git push origin main';", 'perl'), false);
    assert.equal(scriptMayPush("open('notes.txt', 'w').write('git push origin main')", 'python'), false);
  });

  it("reads Windows' py launcher as python", () => {
    const found = findGitInvocations('py -3 -c \'import os; os.system("git push origin main")\'', context());
    assert.ok(found.doubts.some((doubt) => /python script that may run git push/.test(doubt.reason)), JSON.stringify(found.doubts));
  });
});

describe('test runs', () => {
  // A test file runs git in the repositories it makes: its text names a push and a process primitive.
  const TEST_JS = 'const { execFileSync } = require("node:child_process");\nexecFileSync("git", ["push", "origin", "main"], { cwd: tmp });\n';
  const PUSH_JS = 'require("child_process").execSync("git push origin main")\n';
  const files = {
    '/w/tools/ship/ship-commits.test.ts': TEST_JS,
    '/w/tools/ci/local-checks.test.ts': TEST_JS,
    '/w/src/a.spec.mjs': TEST_JS,
    '/w/test/helpers.js': TEST_JS,
    '/w/push.js': PUSH_JS,
    '/w/push.mjs': PUSH_JS,
  };
  const ctx = (): FinderContext => ({ ...context(files), cwd: '/w' });
  const doubted = (command: string): boolean => findGitInvocations(command, ctx()).doubts.some((doubt) => /script that may run git push/.test(doubt.reason));

  it('reads no test file a test run names, however the line reaches it', () => {
    for (const command of [
      'node --test tools/ship/ship-commits.test.ts tools/ci/local-checks.test.ts',
      'cd /w && node --test tools/ship/ship-commits.test.ts tools/ci/local-checks.test.ts | tail',
      'env -C /w node --test tools/ship/ship-commits.test.ts tools/ci/local-checks.test.ts',
      'cd tools && node --test ship/ship-commits.test.ts',
      'node --test --test-name-pattern ship tools/ship/ship-commits.test.ts',
      'node --experimental-strip-types --test --test-only tools/ship/ship-commits.test.ts 2>&1 | tail -20',
      'node --test src/a.spec.mjs test/helpers.js',
      'node --test "tools/**/*.test.ts"',
      'deno test tools/ship/ship-commits.test.ts',
      'bun test tools/ship/ship-commits.test.ts',
      'node --test',
    ]) {
      assert.equal(doubted(command), false, command);
    }
  });

  it('still reads a script that pushes: run plainly, as a preload, or named as no test under --test', () => {
    for (const command of [
      'node push.js',
      'node tools/ship/ship-commits.test.ts',
      'node --test push.js',
      'node --test tools/ship/ship-commits.test.ts push.js',
      'node --test --import ./push.mjs tools/ship/ship-commits.test.ts',
      'node --import ./push.mjs --test tools/ship/ship-commits.test.ts',
      'node --test-only push.js',
      'node --test test/../push.js',
      'node --test tests/../push.js',
      'node --test __tests__/../push.js',
      'node --test ./test/../push.js tools/ship/ship-commits.test.ts',
      'deno run push.js',
      'bun test push.js',
      '"$NODE" --test tools/ship/ship-commits.test.ts',
    ]) {
      assert.ok(findGitInvocations(command, ctx()).doubts.length > 0, command);
    }
  });

  it('still judges a push the line itself runs after a test run', () => {
    const found = findGitInvocations('node --test tools/ship/ship-commits.test.ts && git push origin main', ctx());
    assert.ok(found.invocations.some((invocation) => invocation.subcommand === 'push'));
  });

  it("names test files by node's default patterns, .spec and a tests folder, in JavaScript or TypeScript", () => {
    for (const path of ['a.test.ts', 'a-test.js', 'a_test.mjs', 'test-a.cjs', 'test.js', 'x/a.spec.tsx', 'test/a.js', 'x/__tests__/a.ts', 'a/../b.test.js', './test/a.js', '../test/a.js', 'test/x/../a.js', 'x\\tests\\a.mts', '**/*.test.ts']) {
      assert.equal(isTestPath(path), true, path);
    }
    for (const path of ['push.js', 'latest.js', 'contest.ts', 'a.test.py', 'test/a.json', 'a.test', 'tests.js/push.sh', 'test/../push.js', './test/../x.js', 'test/./../push.js', 'x/test/../../push.mjs', 'test\\..\\push.js', 'a.test.js/../push.js', 'tests/../push.js', '__tests__/../push.js']) {
      assert.equal(isTestPath(path), false, path);
    }
  });
});
