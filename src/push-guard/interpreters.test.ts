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

  // The arguments after the script are its data, not program text.
  const TRANSCRIPT = '{"type":"tool_use","input":{"command":"git push origin main"}}\n{"text":"import subprocess"}\n';
  const OCR = 'import sys, json\nfor path in sys.argv[1:]:\n    print(len(open(path).read()))\n';
  const SHIP = 'import subprocess\nsubprocess.check_call(["git", "push", "origin", "HEAD:main"])\n';

  it('passes a script that never pushes, whose data files talk about pushes, behind a variable and interpreter flags', () => {
    const files = { '/s/tools/ocr.py': OCR, '/s/transcript.jsonl': TRANSCRIPT, '/s/a.env': 'GIT_PUSH=1 subprocess' };
    const command = 'S=/s; cd $S/tools && python3 -E -P $S/tools/ocr.py $S/transcript.jsonl $S/a.env 2>&1 | grep -E "token|push" | tail -40';
    assert.deepEqual(findGitInvocations(command, context(files)).doubts, []);
    assert.deepEqual(findGitInvocations('python3 -u /s/tools/ocr.py /s/transcript.jsonl', context(files)).doubts, []);
    assert.deepEqual(findGitInvocations("python3 -c 'print(1)' /s/transcript.jsonl", context(files)).doubts, []);
    assert.deepEqual(findGitInvocations('python3 -m json.tool /s/transcript.jsonl', context(files)).doubts, []);
    assert.deepEqual(findGitInvocations('node -r ./hook.js /s/tools/ocr.js /s/transcript.jsonl', context({ ...files, '/s/tools/ocr.js': 'console.log(process.argv)' })).doubts, []);
  });

  it('still doubts a script that pushes, run the same way: behind a variable, after flags, or through a subcommand', () => {
    const files = { '/s/tools/run': 'require("child_process").execSync("git push origin main")', '/s/tools/ship.py': SHIP, '/s/ship.ts': 'Deno.run({cmd:["git","push","origin","main"]})', '/s/ship.php': '<?php shell_exec("git push origin main");' };
    for (const command of [
      'S=/s; cd $S/tools && python3 -E -P $S/tools/ship.py /s/data.txt 2>&1 | tail -40',
      'python3 -W ignore -X dev /s/tools/ship.py',
      'python3 -EP /s/tools/ship.py',
      'deno run --allow-run /s/ship.ts',
      'php -d x=1 -f /s/ship.php',
      'cd /s/tools && node run /s/data.txt',
    ]) {
      const found = findGitInvocations(command, context(files));
      assert.ok(
        found.doubts.some((doubt) => !doubt.gated && /script that may run git push/.test(doubt.reason)),
        `${command}: ${JSON.stringify(found.doubts)}`,
      );
    }
  });

  // `python3 -I - "$FILE" <<'EOF'` reads its program from the heredoc; the file is data, even when it quotes a push.
  const HANDOVER = '# handover\n- PR #4 pushed; never `git push` to main, the subprocess hook refuses it\n';

  it('passes an inline python heredoc that writes a handover or reads a transcript, whose file argument quotes git push', () => {
    const files = { '/t/handover.md': HANDOVER, '/t/x.jsonl': TRANSCRIPT };
    for (const command of [
      "H=/t/handover.md\npython3 -I - \"$H\" <<'EOF'\nimport sys\np=sys.argv[1]; L=open(p).read().split('\\n')\nopen(p,'w').write('\\n'.join(['# new']+L))\nEOF",
      "T=/t/x.jsonl; python3 -I - \"$T\" toolu_01 toolu_02 <<'EOF'\nimport json,sys\np,*ids=sys.argv[1:]\nfor l in open(p):\n  try: c=json.loads(l).get('message',{}).get('content')\n  except Exception: continue\n  print(c)\nEOF",
    ]) {
      assert.deepEqual(findGitInvocations(command, context(files)).doubts, [], command);
    }
  });

  it('still doubts an inline heredoc run the same way that pushes through subprocess or os.system', () => {
    const files = { '/t/handover.md': HANDOVER };
    for (const command of [
      "H=/t/handover.md; python3 -I - \"$H\" <<'EOF'\nimport subprocess\nsubprocess.run([\"git\", \"push\"])\nEOF",
      "H=/t/handover.md; python3 -I - \"$H\" <<'EOF'\nimport os\nos.system(\"git push\")\nEOF",
    ]) {
      const found = findGitInvocations(command, context(files));
      assert.ok(
        found.doubts.some((doubt) => !doubt.gated && /script that may run git push/.test(doubt.reason)),
        `${command}: ${JSON.stringify(found.doubts)}`,
      );
    }
  });

  // A value option the guard did not know, or a preload, hid the script that pushes.
  const PUSH_PY = 'import subprocess\nsubprocess.run(["git", "push", "origin", "main"])\n';
  const PUSH_JS = 'require("child_process").execSync("git push origin main")\n';
  const PUSH_RB = 'system("git push origin main")\n';
  const PUSH_PHP = '<?php shell_exec("git push origin main");\n';
  const QUIET = { '/w/deno.json': '{"tasks":{}}', '/w/app.js': 'console.log(1)\n', '/w/app.rb': 'puts 1\n' };
  const inWork = (files: Record<string, string>): FinderContext => ({ ...context(files), cwd: '/w' });

  it('doubts a script that pushes behind an option it takes a value for, a preload, or python -m runpy', () => {
    const files = { ...QUIET, '/w/push.ts': 'Deno.run({cmd:["git","push","origin","main"]})\n', '/w/push.js': PUSH_JS, '/w/push.mjs': PUSH_JS, '/w/push.rb': PUSH_RB, '/w/push.py': PUSH_PY, '/w/push.php': PUSH_PHP };
    for (const command of [
      'deno run -c deno.json push.ts',
      'deno run --config deno.json push.ts',
      'node --disable-warning ExperimentalWarning push.js',
      'php -S localhost:8000 push.php',
      'node -r ./push.js app.js',
      'node --require ./push.js app.js',
      'node --require=./push.js app.js',
      'node --import ./push.mjs app.js',
      'node --loader ./push.mjs app.js',
      'node -r ./push.js -e "console.log(1)"',
      'ruby -r ./push.rb app.rb',
      'python3 -m runpy push.py',
      'python3 -I -m pdb push.py',
      'node --some-new-flag value push.js',
    ]) {
      const found = findGitInvocations(command, inWork(files));
      assert.ok(
        found.doubts.some((doubt) => !doubt.gated && /script that may run git push/.test(doubt.reason)),
        `${command}: ${JSON.stringify(found.doubts)}`,
      );
    }
  });

  it('still passes those shapes when nothing they load pushes, and keeps the data after a readable script unread', () => {
    const files = { ...QUIET, '/w/ok.ts': 'console.log(1)\n', '/w/ok.js': 'console.log(1)\n', '/w/ok.py': 'print(1)\n', '/w/transcript.jsonl': TRANSCRIPT };
    for (const command of [
      'deno run -c deno.json ok.ts transcript.jsonl',
      'node --disable-warning ExperimentalWarning ok.js transcript.jsonl',
      'node -r ./ok.js app.js transcript.jsonl',
      'ruby -r ./app.rb app.rb transcript.jsonl',
      'python3 -m runpy ok.py transcript.jsonl',
      'python3 -m json.tool transcript.jsonl',
      'python3 missing.py',
      'python3 "$S" transcript.jsonl',
    ]) {
      assert.deepEqual(findGitInvocations(command, inWork(files)).doubts, [], command);
    }
  });

  it('falls back to reading every readable argument when the script it names is not a readable file', () => {
    const files = { '/w/transcript.jsonl': TRANSCRIPT };
    const found = findGitInvocations('python3 missing.py transcript.jsonl', inWork(files));
    assert.ok(found.doubts.some((doubt) => !doubt.gated), JSON.stringify(found.doubts));
  });

  // `perl -0pi -e '<code>' <file>` edits the file in place; the file is data, the -e code is the program.
  const NOTES = '# notes\n- never `git push` to main; run `make check` first\n';

  it('passes a perl in-place edit whose -e code cannot push, although its file quotes git push in backticks', () => {
    const files = { '/t/notes.md': NOTES };
    const command = "T=/opt/bin/tool; perl -0pi -e 's/old step \\(\\+ x\\n\\s*y\\)/new step (z)/' /t/notes.md; grep -n z /t/notes.md; $T add --title x 2>&1 | tail -1";
    assert.deepEqual(findGitInvocations(command, context(files)).doubts, []);
    assert.deepEqual(findGitInvocations("perl -0pi -e 's/a/b/' /t/notes.md", context(files)).doubts, []);
  });

  it('still doubts perl -e code that pushes through system, a backtick /e substitution or qx', () => {
    const files = { '/t/notes.md': NOTES };
    for (const command of [
      "perl -e 'system(\"git push\")'",
      "perl -0pi -e 's/a/`git push`/e' /t/notes.md",
      "perl -e 'my $o = qx(git push)'",
    ]) {
      const found = findGitInvocations(command, context(files));
      assert.ok(
        found.doubts.some((doubt) => !doubt.gated && /perl script that may run git push/.test(doubt.reason)),
        `${command}: ${JSON.stringify(found.doubts)}`,
      );
    }
  });

  it('still reads a shell fed a heredoc, and a program only known when it runs', () => {
    assert.ok(findGitInvocations("bash <<'X'\ngit push origin main\nX", context()).invocations.some((i) => i.subcommand === 'push'));
    const dynamic = findGitInvocations("\"$PY\" - <<'PY'\nprint('push')\nPY", context());
    assert.equal(dynamic.mentionsPush, true);
    assert.ok(dynamic.doubts.some((doubt) => doubt.gated));
  });
});
