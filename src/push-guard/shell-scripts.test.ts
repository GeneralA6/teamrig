import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findGitInvocations, type FinderContext, type GitInvocations } from './invocations.ts';

// A shell script file a line runs is read as the line's own commands.

const PUSH_SCRIPT = '#!/bin/sh\nset -e\ngit push origin main\n';
const FILES: Readonly<Record<string, string>> = {
  '/work/app/x.sh': PUSH_SCRIPT,
  '/work/app/plain': 'git push origin main\n',
  '/work/app/ok.sh': '#!/usr/bin/env bash\ngit status\n',
  '/work/app/cdsub.sh': 'cd sub\n',
  '/work/app/f.sh': 'echo old\n',
  '/work/app/ship': '#!/usr/bin/env python3\nimport subprocess\nsubprocess.check_call(["git", "push", "origin", "main"])\n',
  '/work/app/tool': '\u007fELF\u0002\u0001\u0001\u0000\u0000git push origin main',
  '/work/app/nested.sh': 'bash x.sh\n',
  '/work/app/loop.sh': 'bash loop.sh\n',
  '/work/app/git-ship.sh': PUSH_SCRIPT,
  '/work/app/git-ship': PUSH_SCRIPT,
  '/work/app/nul.sh': '#!/bin/sh\n# \u0000 data\ngit push origin main\n',
  '/work/app/old.sh': PUSH_SCRIPT,
  '/work/app/old.py': 'import subprocess\nsubprocess.run(["git", "push", "origin", "main"])\n',
};

function find(command: string, files: Readonly<Record<string, string>> = FILES): GitInvocations {
  const context: FinderContext = {
    cwd: '/work/app',
    home: '/u',
    dialect: 'bash',
    git: { config: () => ({ kind: 'unset' }) },
    readScript: (path) => files[path],
  };
  return findGitInvocations(command, context);
}

const pushes = (command: string): string[] =>
  find(command)
    .invocations.filter((found) => found.subcommand === 'push')
    .map((found) => `${found.dir ?? '?'}|${found.args.map((arg) => arg.text).join(' ')}`);
const doubts = (command: string): string[] => find(command).doubts.map((doubt) => `${doubt.gated ? 'g' : '!'}:${doubt.reason}`);

describe('findGitInvocations on shell script files', () => {
  it('reads the script a shell, source, . or a path runs, and finds its push', () => {
    for (const line of [
      'bash x.sh',
      'sh x.sh',
      'zsh x.sh',
      'bash -e x.sh',
      'sudo bash x.sh',
      'timeout 60 sh x.sh',
      'source x.sh',
      '. x.sh',
      './x.sh',
      '/work/app/x.sh',
      'chmod +x plain && ./plain',
      'bash nested.sh',
    ]) {
      assert.deepEqual(pushes(line), ['/work/app|origin main'], line);
      assert.deepEqual(doubts(line), [], line);
    }
  });

  it('runs a script in the folder of the shell that runs it, not the folder of the file', () => {
    assert.deepEqual(pushes('cd /work && bash app/x.sh'), ['/work|origin main']);
  });

  it('passes a script that does not push, and keeps a cd that source or . runs in the same shell', () => {
    assert.deepEqual(find('bash ok.sh').invocations.map((found) => found.subcommand), ['status']);
    assert.deepEqual(doubts('bash ok.sh'), []);
    assert.deepEqual(pushes('. cdsub.sh && git push origin feat'), ['/work/app/sub|origin feat']);
    assert.deepEqual(pushes('bash cdsub.sh && git push origin feat'), ['/work/app|origin feat']);
  });

  it('reads the text a line writes into a script before it runs it', () => {
    for (const line of [
      "cat <<'E' > f.sh\ngit push origin main\nE\nbash f.sh",
      "cat > f.sh <<'E'\ngit push origin main\nE\nchmod +x f.sh; ./f.sh",
      "cat <<< 'git push origin main' > f.sh; source f.sh",
    ]) {
      assert.deepEqual(pushes(line), ['/work/app|origin main'], line);
    }
    assert.deepEqual(pushes("cat <<'E' > f.sh\necho fine\nE\nbash f.sh"), []);
    // Backticks a quoted heredoc keeps as text run once the written script runs.
    assert.deepEqual(pushes("cat <<'E' > f.sh\necho \"run `git push origin main`\"\nE\nbash f.sh"), ['/work/app|origin main']);
    // A push only named in an issue body stays literal, next to a script that does not push.
    assert.deepEqual(find('gh issue create --title x --body "steps: run \\`git push\\` after review" && ./ok.sh').doubts, []);
  });

  it('doubts a script it cannot read: written with unknown text, unreadable, or named only when it runs', () => {
    const written = 'g:it runs a script file the line writes, whose text the guard cannot read';
    const unreadable = 'g:it runs a shell script file the guard cannot read';
    for (const [line, expected] of [
      ["echo 'git push origin main' > f.sh; bash f.sh", written],
      ['printf "%s\\n" "$CMD" >> f.sh; ./f.sh', written],
      ['echo x | tee f.sh; bash f.sh', written],
      ["cat <<E > f.sh\ngit $SUB\nE\nbash f.sh", written],
      ['bash missing.sh', unreadable],
      ['./missing.sh', unreadable],
      ['source missing.sh', unreadable],
      ['bash "$F"', 'g:it runs a shell script file only known when it runs'],
    ] as const) {
      assert.deepEqual(doubts(line), [expected], line);
    }
    // A program by path that cannot be read and is no shell script name runs nothing the guard can know of.
    assert.deepEqual(doubts('./missing-tool --flag'), []);
  });

  it('judges a script with another language in its #! line by that language, and leaves a binary alone', () => {
    assert.deepEqual(doubts('./ship'), [
      '!:it runs a python script that may run git push, whose push the guard cannot read; run the push as a plain git command on the line instead',
    ]);
    assert.deepEqual(doubts('./tool'), []);
    assert.deepEqual(pushes('./tool'), []);
  });

  it('reads an interpreter script the line writes from what it writes', () => {
    const line = "cat <<'E' > s.py\nimport subprocess\nsubprocess.run(['git', 'push', 'origin', 'main'])\nE\npython3 s.py";
    assert.deepEqual(doubts(line), [
      '!:it runs a python script that may run git push, whose push the guard cannot read; run the push as a plain git command on the line instead',
    ]);
  });

  it('reads a script run by its path whose name starts with git-, unless it names a git command', () => {
    for (const line of ['./git-ship.sh', './git-ship', '/work/app/git-ship']) {
      assert.deepEqual(pushes(line), ['/work/app|origin main'], line);
    }
    // A git command by its path, such as git's own git-push, is git's.
    assert.deepEqual(pushes('/usr/lib/git-core/git-push origin feat'), ['/work/app|origin feat']);
  });

  it('reads a script with a NUL byte after its first line, which bash still runs', () => {
    for (const line of ['bash nul.sh', './nul.sh', 'sh nul.sh']) {
      assert.deepEqual(pushes(line), ['/work/app|origin main'], line);
    }
  });

  it('reads the file on disk too when the line writes it, as the write may not run', () => {
    for (const line of [
      "false && cat <<'E' > old.sh\necho fine\nE\nbash old.sh",
      "if false; then cat <<'E' > old.sh\necho fine\nE\nfi; bash old.sh",
      "cat <<'E' > old.sh\necho fine\nE\n./old.sh",
    ]) {
      assert.deepEqual(pushes(line), ['/work/app|origin main'], line);
    }
    // The text the line writes is read as well.
    assert.deepEqual(pushes("false && cat <<'E' > ok.sh\ngit push origin feat\nE\nbash ok.sh"), ['/work/app|origin feat']);
    assert.deepEqual(doubts("false && cat <<'E' > old.py\nprint('fine')\nE\npython3 old.py"), [
      '!:it runs a python script that may run git push, whose push the guard cannot read; run the push as a plain git command on the line instead',
    ]);
  });

  it('stops at a script that runs itself', () => {
    assert.deepEqual(doubts('bash loop.sh'), ['!:scripts nest too deep to read']);
  });
});
