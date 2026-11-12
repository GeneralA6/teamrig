import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scriptMayPush } from './interpreters.ts';
import { findGitInvocations, type FinderContext } from './invocations.ts';

// Interpreter scripts are judged by their text, not read as shell words.

function context(files: Record<string, string> = {}): FinderContext {
  return {
    cwd: '/work/app',
    home: '/u',
    dialect: 'bash',
    git: { config: () => ({ kind: 'unset' }) },
    readScript: (path) => files[path],
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
