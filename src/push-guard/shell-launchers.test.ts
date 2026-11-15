import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findGitInvocations } from './invocations.ts';

// Programs that run an argument or stdin as a shell command.

/** `PUSH` when a push is found, `DOUBT` when the guard doubts, `pass` otherwise; no script file is readable. */
function outcome(command: string): string {
  const found = findGitInvocations(command, { cwd: '/work/app', home: '/u', dialect: 'bash', git: { config: () => ({ kind: 'unset' }) }, readScript: () => undefined });
  return found.invocations.some((invocation) => invocation.subcommand === 'push') ? 'PUSH' : found.doubts.length > 0 ? 'DOUBT' : 'pass';
}

const X = "'git push origin main'";

/** Each shape of the launcher matrix that runs X, with what the guard now does; the comment says what it did before. */
const RUNS_X: readonly (readonly [string, string])[] = [
  // launchers whose shell word is known: X is read as commands
  ['su -c X', 'PUSH'], // was pass
  ['su - root -c X', 'PUSH'], // was pass
  ['runuser -u u -- sh -c X', 'PUSH'], // was pass
  ['runuser u -c X', 'PUSH'], // was pass
  ['flock /tmp/l -c X', 'PUSH'], // was pass
  ['flock /tmp/l sh -c X', 'PUSH'], // was pass
  ["find . -exec sh -c X ';'", 'PUSH'], // was pass
  ['find . -exec bash -c X {} +', 'PUSH'], // was pass
  ['script -qc X /dev/null', 'PUSH'], // was pass
  ['script --command X /dev/null', 'PUSH'], // was pass
  ['systemd-run --user sh -c X', 'PUSH'], // was pass
  ['systemd-run --user -p Nice=5 sh -c X', 'PUSH'], // was pass
  ['nsenter -t 1 sh -c X', 'PUSH'], // was pass
  ['chroot / sh -c X', 'PUSH'], // was pass
  ['unshare sh -c X', 'PUSH'], // was pass
  ['setpriv sh -c X', 'PUSH'], // was pass
  ['trap X EXIT', 'PUSH'], // was pass
  ['. /dev/stdin <<< X', 'PUSH'], // was pass
  ['source /dev/stdin <<< X', 'PUSH'], // was pass
  // programs that run X where the guard cannot read it: a doubt when X names a push
  ['ssh host X', 'PUSH'], // was pass; then DOUBT, when the ssh check read the text only
  ['watch -n1 X', 'PUSH'], // was pass; then DOUBT
  ['tmux new-session -d X', 'PUSH'], // was pass; then DOUBT
  ['tmux send-keys X Enter', 'PUSH'], // was pass; then DOUBT
  ['screen -dm sh -c X', 'PUSH'], // was pass; then DOUBT
  ['xterm -e X', 'DOUBT'], // was pass
  ['gnome-terminal -- sh -c X', 'DOUBT'], // was pass
  ['parallel ::: X', 'DOUBT'], // was pass
  ['docker exec c sh -c X', 'DOUBT'], // was pass
  ['kubectl exec p -- sh -c X', 'DOUBT'], // was pass
  ['at now <<< X', 'DOUBT'], // was pass
  ['echo X | at now', 'DOUBT'], // was pass
  ['crontab <<< X', 'DOUBT'], // was pass
  ['make -f /dev/stdin <<< X', 'DOUBT'], // was pass
  ['awk \'BEGIN{system("git push")}\'', 'DOUBT'], // was pass
  ['echo X | xargs -I{} sh -c {}', 'DOUBT'], // was pass
  ['echo X | . /dev/stdin', 'DOUBT'], // was pass
  // code a later shell runs
  ['echo X >> ~/.bashrc', 'DOUBT'], // was pass
  ['PROMPT_COMMAND=X', 'DOUBT'], // was pass
  ['alias g=X', 'DOUBT'], // was pass
  // write, then run
  ['tee f <<< X; sh f', 'DOUBT'], // was pass
  ['echo X > f; bash f', 'DOUBT'], // was pass
  ['source <(echo X)', 'DOUBT'], // was pass
  ['bash <(echo X)', 'DOUBT'], // was pass
];

/** Shapes that must stay as they are: X is data, or the program runs something else. */
const UNCHANGED: readonly (readonly [string, string])[] = [
  ['gh issue create --body X', 'pass'],
  ['git commit -m X', 'pass'],
  ['mapfile a <<< X', 'pass'],
  ['export A=X', 'pass'],
  ['echo X; let n=1', 'pass'],
  ['docker push registry/app:1', 'pass'],
  ['podman push app', 'pass'],
  ['kubectl get pods -o name', 'pass'],
  ["awk '/push/ {print $1}' notes.md", 'pass'],
  ['ssh host uptime', 'pass'],
  ['tmux new-session -d htop', 'pass'],
  ['make push-docs', 'pass'],
  ["find . -name '*.push' -print", 'pass'],
  ["trap 'rm -f /tmp/x' EXIT", 'pass'],
  ['trap - EXIT', 'pass'],
  ['script -q /dev/null', 'pass'],
  ['su -', 'pass'],
  ['flock /tmp/l make build', 'pass'],
  ['echo hi >> ~/.bashrc', 'pass'],
  ['PROMPT_COMMAND="history -a"', 'pass'],
  ["alias ll='ls -l'", 'pass'],
  ['echo a b | xargs -n1 sh -c \'echo "$0"\'', 'pass'],
  ['sudo -u u sh -c X', 'PUSH'],
  ['eval X', 'PUSH'],
];

describe('findGitInvocations: programs that run an argument or stdin as shell', () => {
  it('finds or doubts a push in every launcher shape that runs it', () => {
    for (const [shape, expected] of RUNS_X) {
      assert.equal(outcome(shape.replaceAll('X', X)), expected, shape);
    }
  });

  it('leaves data and other programs as they were', () => {
    for (const [shape, expected] of UNCHANGED) {
      assert.equal(outcome(shape.replaceAll('X', X)), expected, shape);
    }
  });

  it('reads the -c command su, runuser, flock and script run, in their folder', () => {
    const found = findGitInvocations("su -c 'git status' && flock /tmp/l -c 'git log -1'", {
      cwd: '/work/app',
      home: '/u',
      dialect: 'bash',
      git: { config: () => ({ kind: 'unset' }) },
    });
    assert.deepEqual(
      found.invocations.map((invocation) => `${invocation.dir ?? '?'}|${invocation.subcommand}`),
      ['/work/app|status', '/work/app|log'],
    );
    assert.deepEqual(found.doubts, []);
  });

  it('doubts a find that runs more than one command, and a -c command only known when it runs', () => {
    assert.equal(outcome(`find . -exec true ';' -exec sh -c ${X} ';'`), 'DOUBT');
    const found = findGitInvocations('su -c "$CMD"', { cwd: '/work/app', home: '/u', dialect: 'bash', git: { config: () => ({ kind: 'unset' }) } });
    assert.deepEqual(found.doubts, [{ reason: 'the program it runs is only known when it runs', gated: true }]);
  });
});
