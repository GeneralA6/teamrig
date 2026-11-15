import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findGitInvocations, type GitInvocations } from './invocations.ts';

// The launcher holes a security review found past the first launcher reader.

const FILES: Readonly<Record<string, string>> = {
  '/work/app/x.sh': 'git push origin main\n',
  '/work/app/env.sh': 'git push origin main\n',
  '/work/app/ok.sh': 'echo fine\n',
  '/work/app/q.sh': 'git p\\ush origin main\n',
};

function find(command: string): GitInvocations {
  return findGitInvocations(command, {
    cwd: '/work/app',
    home: '/u',
    dialect: 'bash',
    git: { config: () => ({ kind: 'unset' }) },
    readScript: (path) => FILES[path],
  });
}

/** `PUSH` when a push is found, `DOUBT` when the guard doubts, `pass` otherwise. */
function outcome(command: string): string {
  const found = find(command);
  return found.invocations.some((invocation) => invocation.subcommand === 'push') ? 'PUSH' : found.doubts.length > 0 ? 'DOUBT' : 'pass';
}

const X = "'git push origin main'";

/** Each shape that runs X or x.sh, with what the guard now does; each passed before this change. */
const RUNS_X: readonly (readonly [string, string])[] = [
  // a runner named by its path
  ['/usr/bin/ssh host X', 'PUSH'],
  ['./ssh host X', 'PUSH'],
  ['/usr/bin/tmux new -d X', 'PUSH'],
  ['/usr/bin/watch X', 'PUSH'],
  ['/usr/bin/docker exec c sh -c X', 'DOUBT'],
  // ssh fed a file on stdin
  ['ssh host < x.sh', 'PUSH'], // DOUBT before
  ['ssh host bash < x.sh', 'DOUBT'],
  ['ssh host bash -s < x.sh', 'DOUBT'],
  ['bash < x.sh', 'PUSH'],
  // su and sudo -s / -i start a shell that reads stdin
  ['su root <<< X', 'PUSH'],
  ['su root < x.sh', 'PUSH'],
  ['echo X | su root', 'DOUBT'],
  ['sudo -s <<< X', 'PUSH'],
  ['sudo -i < x.sh', 'PUSH'],
  // a push the remote or watching shell rebuilds
  ["ssh host 'git p\\ush origin main'", 'PUSH'],
  ['ssh host "git pu\'\'sh origin main"', 'PUSH'],
  ["ssh host 'g=pu; git ${g}sh origin main'", 'PUSH'],
  ["ssh -p 22 -o BatchMode=yes host 'git p\\ush origin main'", 'PUSH'],
  ["watch -n 5 'git p\\ush origin main'", 'PUSH'],
  ["tmux new-window 'git p\\ush origin main'", 'PUSH'],
  // BASH_ENV or ENV naming a file
  ['export BASH_ENV=x.sh; bash -c true', 'PUSH'],
  ['BASH_ENV=env.sh bash -c true', 'PUSH'],
  ['ENV=./env.sh sh -c true', 'PUSH'],
];

const UNCHANGED: readonly (readonly [string, string])[] = [
  ['ssh host ls', 'pass'],
  ['ssh -p 22 host uptime', 'pass'],
  ['/usr/bin/ssh host uptime', 'pass'],
  ['watch -n 5 git status', 'pass'],
  ['watch -x git status', 'pass'],
  ['tmux ls', 'pass'],
  ['tmux new -d "make build"', 'pass'],
  ['su -', 'pass'],
  ['sudo -u u whoami', 'pass'],
  ['ssh host < ok.sh', 'pass'],
  ['grep x < notes.txt', 'pass'],
  ['ENV=production npm run build', 'pass'],
  ['export BASH_ENV=ok.sh; bash -c true', 'pass'],
  ['docker push img:1', 'pass'],
];

describe('findGitInvocations: launcher residuals of a first security review', () => {
  it('finds or doubts a push the launcher runs', () => {
    for (const [shape, expected] of RUNS_X) {
      assert.equal(outcome(shape.replaceAll('X', X)), expected, shape);
    }
  });

  it('leaves data and other programs as they were', () => {
    for (const [shape, expected] of UNCHANGED) {
      assert.equal(outcome(shape), expected, shape);
    }
  });

  it('reads or doubts the launchers the first reader did not list', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['pkexec sh -c X', 'PUSH'],
      ['pkexec --user u sh -c X', 'PUSH'],
      ['firejail --net=none sh -c X', 'PUSH'],
      ['bwrap --ro-bind / / --dev /dev --chdir /work sh -c X', 'PUSH'],
      ['fakeroot -- sh -c X', 'PUSH'],
      ['strace -f -o /tmp/t sh -c X', 'PUSH'],
      ['taskset 0x1 sh -c X', 'PUSH'],
      ['taskset -c 0-3 sh -c X', 'PUSH'],
      ['chrt -f 10 sh -c X', 'PUSH'],
      ['toolbox run sh -c X', 'DOUBT'],
      ['distrobox enter box -- sh -c X', 'DOUBT'],
      ['byobu new-session X', 'DOUBT'],
      ['zellij run -- sh -c X', 'DOUBT'],
      ['nerdctl exec c sh -c X', 'DOUBT'],
      ["expect -c 'spawn git push origin main; interact'", 'DOUBT'],
      ["vim -c '!git push origin main' notes.txt", 'DOUBT'],
      ["vim '+!git push origin main' notes.txt", 'DOUBT'],
      ["gdb -ex '!git push origin main' ./app", 'DOUBT'],
    ];
    for (const [shape, expected] of rows) {
      assert.equal(outcome(shape.replaceAll('X', X)), expected, shape);
    }
    for (const shape of ['vim push.md', 'gdb ./push-tool', 'strace -c ls', 'taskset -p 1234', 'chrt -m', 'nerdctl push img:1', 'firejail --net=none ls', 'bwrap --ro-bind / / ls']) {
      assert.equal(outcome(shape), 'pass', shape);
    }
  });

  it('reads an ssh command in a folder only known on the remote host', () => {
    const found = find("ssh host 'git p\\ush origin main'");
    assert.deepEqual(
      found.invocations.map((invocation) => `${invocation.dir ?? '?'}|${invocation.subcommand}`),
      ['?|push'],
    );
  });

  it('doubts a launcher command it cannot read, when the line names a push', () => {
    assert.deepEqual(
      find('ssh host "$CMD"; echo push').doubts.map((doubt) => doubt.reason),
      ['ssh runs a command line only known when it runs'],
    );
    assert.deepEqual(
      find('ssh host < missing.sh; echo push').doubts.map((doubt) => doubt.reason),
      ['it feeds a program commands from a file the guard cannot read'],
    );
    assert.deepEqual(
      find('export BASH_ENV=missing.sh; bash -c true; echo push').doubts.map((doubt) => doubt.reason),
      ['it runs a shell script file the guard cannot read'],
    );
  });
});

// The residuals of a second security review.
describe('findGitInvocations: launcher residuals of a second security review', () => {
  /** O is a push written so only a shell rebuilds it; each row passed before this change. */
  const O = "'git p\\ush origin main'";
  const ROWS: readonly (readonly [string, string])[] = [
    // gdb's other spellings of a command option
    ["gdb -batch -eval-command '!git push origin main'", 'DOUBT'],
    ["gdb -batch -ex='!git push origin main'", 'DOUBT'],
    // BASH_ENV set by env, a builtin or sudo, and an interactive shell's startup file
    ['env BASH_ENV=x.sh bash -c true', 'PUSH'],
    ['declare -x BASH_ENV=x.sh; bash -c true', 'PUSH'],
    ['typeset -x BASH_ENV=x.sh; bash -c true', 'PUSH'],
    ['sudo BASH_ENV=x.sh bash -c true', 'PUSH'],
    ['bash --rcfile x.sh -ic true', 'PUSH'],
    ['bash --init-file=x.sh -i <<< true', 'PUSH'],
    // stdin from a `<>` file, and more shells that read stdin
    ['ssh host 0<> x.sh', 'PUSH'],
    ['doas -s < x.sh', 'PUSH'],
    ['doas -s <<< X', 'PUSH'],
    ['runuser -l root <<< X', 'PUSH'],
    ['machinectl shell <<< X', 'DOUBT'],
    ["expect <<< 'spawn git push origin main'", 'DOUBT'],
    ['firejail --profile x sh -c X', 'PUSH'],
    // a push only a shell rebuilds
    ['ssh host < q.sh', 'PUSH'],
    ['ssh -o ProxyCommand=O host', 'PUSH'],
    ['ssh -o RemoteCommand=O host', 'PUSH'],
    ['ssh -o PermitLocalCommand=yes -o LocalCommand=O host', 'PUSH'],
    ['tmux -c O', 'PUSH'],
    ['tmux run-shell O', 'PUSH'],
    ['tmux display-popup -E O', 'PUSH'],
    ['tmux pipe-pane -o O', 'PUSH'],
    ['tmux send-keys O Enter', 'PUSH'],
    ['tmux splitw -f O', 'PUSH'],
    ['tmux splitw -p 50 O', 'PUSH'],
    ['screen -dm sh -c O', 'PUSH'],
    // a short option cluster ending in a valued letter
    ['screen -dmS n sh -c O', 'PUSH'],
    ['screen -dmSn sh -c O', 'PUSH'],
    ['screen -dmS n -L sh -c O', 'PUSH'],
  ];

  it('finds or doubts the push', () => {
    for (const [shape, expected] of ROWS) {
      assert.equal(outcome(shape.replaceAll('X', X).replaceAll('O', O)), expected, shape);
    }
  });

  it('leaves data and other programs as they were', () => {
    for (const shape of ['gdb ./a.out', 'gdb -ex=run ./a.out', 'su', 'ssh -o Port=22 host ls', 'tmux send-keys -t 0 C-c', 'screen -ls', 'screen -dm make build', 'screen -dmS n make build', 'screen -dRR n', 'screen -dr n', 'env BASH_ENV=ok.sh bash -c true', 'ENV=production make', 'machinectl list']) {
      assert.equal(outcome(shape), 'pass', shape);
    }
  });
});
