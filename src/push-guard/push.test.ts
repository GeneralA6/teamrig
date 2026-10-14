import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decisionReason, evaluateCommand, type PushDecision, type RepoState } from './push.ts';
import { splitCommands, stripHeredocs, type ShellDialect } from './shell.ts';

const CWD = '/work/app';
const HOME = '/u';

interface RepoFake {
  readonly branch?: string;
  readonly pushTarget?: string;
}

function fakeRepo({ branch = 'feature', pushTarget }: RepoFake = {}) {
  return {
    branch: mock.fn((_dir: string): string | undefined => branch),
    pushTarget: mock.fn((_dir: string): string | undefined => pushTarget),
  } satisfies RepoState;
}

interface JudgeOptions extends RepoFake {
  readonly dialect?: ShellDialect;
  readonly cwd?: string;
  readonly protectedBranches?: readonly string[];
}

function judge(command: string, { dialect = 'bash', cwd = CWD, protectedBranches = ['main', 'master'], ...state }: JudgeOptions = {}) {
  const repo = fakeRepo(state);
  const decision: PushDecision = evaluateCommand(command, { cwd, home: HOME, dialect, protectedBranches, repo });
  return { decision, repo };
}

describe('evaluateCommand', () => {
  it('never reads a heredoc note that mentions a push and main as a push', () => {
    const command = [
      "cat >> notes.md <<'EOF'",
      '- At the peak: main heap 477 + ext 86',
      '- So `git push origin <code branch>` skips the build.',
      'EOF',
    ].join('\n');
    assert.equal(judge(command).decision, 'allow');
  });

  it('treats a branch push chained after fetching main as a branch push', () => {
    assert.equal(judge('git fetch origin main && git rebase origin/main && git push -u origin ops/limits').decision, 'allow');
  });

  it('never reads quoted text or comments as commands', () => {
    assert.equal(judge('git commit -m "git push origin main"').decision, 'allow');
    assert.equal(judge("echo 'push to main later' # git push origin main").decision, 'allow');
  });

  it('asks before an explicit push to a protected branch', () => {
    for (const command of [
      'git push origin main',
      'git push origin HEAD:main',
      'git push origin feature:refs/heads/main',
      'git push --force-with-lease origin main',
      'cd api && git push origin master',
      'git push --all origin',
    ]) {
      assert.equal(judge(command).decision, 'ask', command);
    }
  });

  it('denies a force-push, mirror or delete of a protected branch', () => {
    for (const command of [
      'git push -f origin main',
      'git push -uf origin main',
      'git push --force origin main',
      'git push origin +main',
      'git push origin :main',
      'git push --delete origin main',
      'git push --mirror origin',
      'git push --all --force origin',
    ]) {
      assert.equal(judge(command).decision, 'deny', command);
    }
  });

  it('returns the strictest decision of a command line', () => {
    assert.equal(judge('git push origin feature; git push -f origin main').decision, 'deny');
    assert.equal(judge('git push origin feature && git push origin main').decision, 'ask');
  });

  it("resolves a bare push's destination from the repository", () => {
    assert.equal(judge('git push', { branch: 'main' }).decision, 'ask');
    assert.equal(judge('git push -f', { branch: 'main' }).decision, 'deny');
    assert.equal(judge('git push', { branch: 'feature' }).decision, 'allow');
    assert.equal(judge('git push', { branch: 'feature', pushTarget: 'origin/main' }).decision, 'ask');
    assert.equal(judge('git push origin HEAD', { branch: 'main' }).decision, 'ask');
  });

  it('never reads a redirection target as a refspec', () => {
    assert.equal(judge('git push origin 2>&1 | tail -5', { branch: 'main' }).decision, 'ask');
    assert.equal(judge('git push origin feature > push.log 2>&1').decision, 'allow');
  });

  it('follows cd, Set-Location, cd ~ and git -C to the folder a bare push resolves in', () => {
    const viaCd = judge('cd /work/app/api && git push', { branch: 'main', cwd: '/work' });
    assert.equal(viaCd.decision, 'ask');
    assert.equal(viaCd.repo.branch.mock.calls[0]?.arguments[0], resolve('/work', '/work/app/api'));

    const viaDashC = judge('git -C ../site push', { branch: 'main' });
    assert.equal(viaDashC.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, '../site'));

    const viaHome = judge('cd ~/repo; git push', { branch: 'main' });
    assert.equal(viaHome.repo.branch.mock.calls[0]?.arguments[0], resolve(HOME, 'repo'));

    const viaSetLocation = judge('Set-Location -Path ../ops; git push', { branch: 'main', dialect: 'powershell' });
    assert.equal(viaSetLocation.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, '../ops'));
  });

  it('allows a dry run', () => {
    assert.equal(judge('git push --dry-run origin main').decision, 'allow');
    assert.equal(judge('git push -n --force origin main').decision, 'allow');
  });

  it("protects the team's configured branches only", () => {
    assert.equal(judge('git push origin release', { protectedBranches: ['release'] }).decision, 'ask');
    assert.equal(judge('git push origin main', { protectedBranches: ['release'] }).decision, 'allow');
    assert.equal(judge('git push -f origin main', { protectedBranches: [] }).decision, 'allow');
  });

  it('never asks git about a command line without a git push', () => {
    const { decision, repo } = judge('kubectl get pods; echo pushed to main; npm run push');
    assert.equal(decision, 'allow');
    assert.equal(repo.branch.mock.callCount(), 0);
    assert.equal(repo.pushTarget.mock.callCount(), 0);
  });

  it('skips PowerShell here-strings and keeps backslash paths', () => {
    assert.equal(judge("git commit -m @'\ngit push origin main\n'@", { dialect: 'powershell' }).decision, 'allow');
    assert.equal(judge('git push origin main; Write-Host done', { dialect: 'powershell' }).decision, 'ask');
    assert.equal(judge('& C:\\tools\\git.exe push origin main', { dialect: 'powershell' }).decision, 'ask');
  });

  it('keeps an unterminated heredoc, so it cannot hide a push', () => {
    assert.equal(judge('cat <<EOF\ngit push origin main').decision, 'ask');
  });
});

describe('stripHeredocs', () => {
  it('removes heredoc and here-string bodies and keeps unterminated ones', () => {
    assert.equal(stripHeredocs("cat <<'EOF'\ngit push origin main\nEOF\necho done"), "cat <<'EOF'\necho done");
    assert.equal(stripHeredocs("cat <<-END\n\tbody\n\tEND"), 'cat <<-END');
    assert.equal(stripHeredocs("x = @\"\nbody\n\"@; y"), "x = ''; y");
    assert.equal(stripHeredocs('cat <<EOF\ngit push origin main'), 'cat <<EOF\ngit push origin main');
    assert.equal(stripHeredocs('grep x <<< "here string"'), 'grep x <<< "here string"');
  });
});

describe('splitCommands', () => {
  it('splits on separators and drops redirections with their targets', () => {
    assert.deepEqual(splitCommands('a 1 && b "two words" | c > out.log 2>&1; d', 'bash'), [['a', '1'], ['b', 'two words'], ['c'], ['d']]);
  });

  it('applies each dialect escape character', () => {
    assert.deepEqual(splitCommands('echo a\\ b "q\\"uote"', 'bash'), [['echo', 'a b', 'q"uote']]);
    assert.deepEqual(splitCommands('Set-Location D:\\work\\app', 'powershell'), [['Set-Location', 'D:\\work\\app']]);
    assert.deepEqual(splitCommands('echo "a`"b"', 'powershell'), [['echo', 'a"b']]);
  });
});

describe('decisionReason', () => {
  it('names the protected branches', () => {
    assert.match(decisionReason('deny', ['main', 'release']), /^Force-pushing, mirroring or deleting a protected branch \(main, release\) is refused/);
    assert.match(decisionReason('ask', ['main']), /^This push updates a protected branch \(main\)/);
  });
});
