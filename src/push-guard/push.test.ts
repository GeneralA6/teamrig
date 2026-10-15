import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { ConfigValue } from './invocations.ts';
import { decisionReason, doubtReason, evaluatePushes, type PushDecision, type RepoState } from './push.ts';
import type { ShellDialect } from './tokenizer.ts';

/** A resolved start folder, as the hook gives one. */
const CWD = resolve('/work/app');
const HOME = '/u';

interface RepoFake {
  readonly branch?: string;
  readonly pushTarget?: string;
  /** Git config values by key, such as `alias.p` or `push.default`. */
  readonly config?: Readonly<Record<string, string>>;
  /** Keys git fails to read. */
  readonly unreadable?: readonly string[];
}

function fakeRepo({ branch = 'feature', pushTarget, config = {}, unreadable = [] }: RepoFake = {}) {
  return {
    branch: mock.fn((_dir: string): string | undefined => branch),
    pushTarget: mock.fn((_dir: string, _branch?: string): string | undefined => pushTarget),
    config: mock.fn((_dir: string, key: string): ConfigValue => {
      if (unreadable.includes(key)) {
        return { kind: 'unreadable' };
      }
      const value = config[key];
      return value === undefined ? { kind: 'unset' } : { kind: 'set', value };
    }),
  } satisfies RepoState;
}

interface JudgeOptions extends RepoFake {
  readonly dialect?: ShellDialect;
  readonly cwd?: string;
  readonly protectedBranches?: readonly string[];
}

function judge(command: string, { dialect = 'bash', cwd = CWD, protectedBranches = ['main', 'master'], ...state }: JudgeOptions = {}) {
  const repo = fakeRepo(state);
  const verdict = evaluatePushes(command, { cwd, home: HOME, dialect, protectedBranches, repo });
  const decision: PushDecision = verdict.decision;
  return { decision, doubt: verdict.doubt, repo };
}

/** Each row is a command and the decision it must get; a third `doubt` cell marks an ask the guard makes because it cannot read the line. */
type Row = readonly [command: string, decision: PushDecision, doubt?: 'doubt'];

function expectRows(rows: readonly Row[], options: JudgeOptions = {}): void {
  for (const [command, decision, doubt] of rows) {
    const verdict = judge(command, options);
    assert.equal(verdict.decision, decision, command);
    assert.equal(verdict.doubt !== undefined, doubt === 'doubt', `doubt for: ${command}`);
  }
}

/** A push of `branch` after a check that main has not moved, as a ship step writes it. */
function checkedPush(branch: string): string {
  return `W=/w/app; B=${branch}; cd $W && git fetch -q origin && [ "$(git merge-base HEAD origin/main)" = "$(git rev-parse origin/main)" ] && git push -q -u origin $B 2>&1 | grep -E "error|rejected"`;
}

describe('evaluatePushes: the decision', () => {
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
      'git push origin feature:heads/main',
      'git push origin main~1:main',
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

  it('reads push.default=matching as a push of every matching branch', () => {
    const config = { 'push.default': ' Matching ' };
    assert.equal(judge('git push', { config }).decision, 'ask');
    assert.equal(judge('git push -f', { config }).decision, 'deny');
  });

  it('never reads a redirection target as a refspec', () => {
    assert.equal(judge('git push origin 2>&1 | tail -5', { branch: 'main' }).decision, 'ask');
    assert.equal(judge('git push origin feature > push.log 2>&1').decision, 'allow');
  });

  it('follows cd, Set-Location, cd ~, git -C, --git-dir and GIT_DIR to the folder a bare push resolves in', () => {
    const viaCd = judge('cd /work/app/api && git push', { branch: 'main', cwd: '/work' });
    assert.equal(viaCd.decision, 'ask');
    assert.equal(viaCd.repo.branch.mock.calls[0]?.arguments[0], resolve('/work', '/work/app/api'));

    const viaDashC = judge('git -C ../site push', { branch: 'main' });
    assert.equal(viaDashC.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, '../site'));

    const viaHome = judge('cd ~/repo; git push', { branch: 'main' });
    assert.equal(viaHome.repo.branch.mock.calls[0]?.arguments[0], resolve(HOME, 'repo'));

    const viaSetLocation = judge('Set-Location -Path ../ops; git push', { branch: 'main', dialect: 'powershell' });
    assert.equal(viaSetLocation.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, '../ops'));

    const viaGitDir = judge('git -C sub --git-dir=../x/.git push', { branch: 'main' });
    assert.equal(viaGitDir.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, 'sub', '../x/.git'));

    const viaEnv = judge('GIT_DIR=../o/.git git -C sub push', { branch: 'main' });
    assert.equal(viaEnv.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, 'sub', '../o/.git'));
  });

  it('keeps a subshell cd inside the subshell', () => {
    const inside = judge('(cd sub && git push)', { branch: 'main' });
    assert.equal(inside.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD, 'sub'));
    const after = judge('(cd sub); git push', { branch: 'main' });
    assert.equal(after.repo.branch.mock.calls[0]?.arguments[0], resolve(CWD));
  });

  it('allows a dry run and a help page', () => {
    expectRows([
      ['git push --dry-run origin main', 'allow'],
      ['git push -n --force origin main', 'allow'],
      ['git push --dry origin main', 'allow'],
      ['git push --help', 'allow'],
      ['git push -h', 'allow'],
    ]);
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
    assert.equal(repo.config.mock.callCount(), 0);
  });

  it('skips PowerShell here-strings and keeps backslash paths', () => {
    assert.equal(judge("git commit -m @'\ngit push origin main\n'@", { dialect: 'powershell' }).decision, 'allow');
    assert.equal(judge('git push origin main; Write-Host done', { dialect: 'powershell' }).decision, 'ask');
    assert.equal(judge('& C:\\tools\\git.exe push origin main', { dialect: 'powershell' }).decision, 'ask');
  });

  it('keeps an unterminated heredoc, so it cannot hide a push', () => {
    assert.equal(judge('cat <<EOF\ngit push origin main').decision, 'ask');
    assert.equal(judge('cat <<EOF\n EOF\ngit push origin main').decision, 'ask');
  });

  it('runs a heredoc or here-string a shell reads, and asks about a push in it', () => {
    expectRows([
      ['cat <<EOF | bash\ngit push origin main\nEOF', 'ask'],
      ["cat <<'EOF' | sh -s\ngit push -f origin main\nEOF", 'deny'],
      ["bash <<'EOF'\ngit push origin main\nEOF", 'ask'],
      ['bash <<< "git push origin main"', 'ask'],
      ["bash -c @'\ngit push origin main\n'@", 'ask'],
      ["pwsh -Command - <<'EOF'\ngit push origin main\nEOF", 'ask'],
      ['cat <<EOF | tee x | bash\ngit push origin main\nEOF', 'ask', 'doubt'],
      ['cat > /dev/stdout <<EOF | bash\ngit push origin main\nEOF', 'ask', 'doubt'],
      ["bash <<'EOF'\ngit push origin feature\nEOF", 'allow'],
    ]);
    assert.equal(judge("@'\ngit push origin main\n'@ | pwsh -Command -", { dialect: 'powershell' }).decision, 'ask');
  });
});

describe('evaluatePushes: where a push hides', () => {
  it("reads git's global options", () => {
    expectRows([
      ['git -C ../other push origin main', 'ask'],
      ['git --git-dir=../x/.git push -f origin main', 'deny'],
      ['git -c color.ui=never push -f origin main', 'deny'],
      ['git --no-pager push origin main', 'ask'],
      ['git --version push', 'allow'],
      ['git -c push.default=current push', 'ask', 'doubt'],
      ['git -c remote.origin.push=refs/heads/feature:refs/heads/main push origin feature', 'ask', 'doubt'],
      ['git -c remote.origin.push=x push origin feature:feature', 'allow'],
      ['git --git-dir="$G" push', 'ask', 'doubt'],
      ['git --git-dir="$G" push origin main', 'ask'],
      ['git --$OPT push', 'ask', 'doubt'],
    ]);
  });

  it('reads every command of a compound line', () => {
    expectRows([
      ['echo a; git push origin main', 'ask'],
      ['true || git push origin main', 'ask'],
      ['git status | git push origin main', 'ask'],
      ['echo a\ngit push origin main', 'ask'],
      ['(cd sub && git push origin main)', 'ask'],
      ['echo $(git push -f origin main)', 'deny'],
      ['echo `git push origin main`', 'ask'],
      ['x=$(git push origin main)', 'ask'],
      ['{ git push origin main; }', 'ask'],
      ['if true; then git push origin main; fi', 'ask'],
      ['for b in x; do git push origin main; done', 'ask'],
      ['case $x in main) git push origin main;; esac', 'ask'],
      ['f() { git push -f origin main; }; f', 'deny'],
      ['! git push origin main', 'ask'],
    ]);
  });

  it('sees through variable prefixes and wrappers', () => {
    expectRows([
      ['GIT_TRACE=1 git push origin main', 'ask'],
      ['command git push origin main', 'ask'],
      ['command -v git push', 'allow'],
      ['env GIT_TRACE=1 git push -f origin main', 'deny'],
      ['sudo -u me git push origin main', 'ask'],
      ['nohup git push origin main &', 'ask'],
      ['time git push origin main', 'ask'],
      ['timeout 10 git push -f origin main', 'deny'],
      ['nice -n 5 git push origin main', 'ask'],
      ['exec git push -f origin main', 'deny'],
      ['coproc git push origin main', 'ask'],
      ['echo main | xargs git push origin', 'ask', 'doubt'],
    ]);
  });

  it('knows git by any name or path', () => {
    expectRows([
      ['git.exe push origin main', 'ask'],
      ['/usr/bin/git push -f origin main', 'deny'],
      ['"C:\\Program Files\\Git\\cmd\\git.exe" push origin main', 'ask'],
      ['git-push origin main', 'ask'],
    ]);
  });

  it('reads the scripts nested shells, eval and heredocs run', () => {
    expectRows([
      ['bash -c "git push origin main"', 'ask'],
      ["sh -c 'cd sub && git push -f origin main'", 'deny'],
      ["bash -lc 'git push origin main'", 'ask'],
      ['eval "git push origin main"', 'ask'],
      ["echo 'git push origin main' | sh", 'ask', 'doubt'],
      ['bash <<EOF\ngit push origin main\nEOF', 'ask'],
      ['cat <<EOF\ngit push origin main\nEOF', 'allow'],
    ]);
  });

  it('reads PowerShell call operators, launchers and pipelines', () => {
    expectRows(
      [
        ['& git push origin main', 'ask'],
        [". git push origin main", 'ask'],
        ["& 'C:\\Program Files\\Git\\cmd\\git.exe' push -f origin main", 'deny'],
        ['cmd /c git push origin main', 'ask'],
        ['cmd.exe /c "git push --force origin main"', 'deny'],
        ["Start-Process git -ArgumentList 'push','origin','main'", 'ask'],
        ["Start-Process -FilePath git -ArgumentList 'push origin main' -Wait", 'ask'],
        ["Invoke-Expression 'git push origin main'", 'ask'],
        ['iex "git push -f origin main"', 'deny'],
        ['pwsh -Command "git push origin main"', 'ask'],
        ['powershell -c "git push -f origin main"', 'deny'],
        ['powershell git push origin main', 'ask'],
        ['$r = git push origin main', 'ask'],
        ['$r=git push origin main', 'ask'],
        ['[void](git push origin main)', 'ask'],
        ['git push origin main 2>&1 | Out-Null', 'ask'],
        ['if ($true) { git push origin main }', 'ask'],
        ["foreach ($b in @('x')) { git push origin main }", 'ask'],
        ['git --% push origin main', 'ask'],
        ['cd ..\\ops; git push', 'allow'],
      ],
      { dialect: 'powershell' },
    );
  });

  it('reads cmd lines', () => {
    expectRows(
      [
        ['git push origin main', 'ask'],
        ['if exist x (git push origin main) else (echo no)', 'ask'],
        ['start "" git push origin main', 'ask'],
        ['git push %ARGS%', 'ask', 'doubt'],
      ],
      { dialect: 'cmd' },
    );
    const moved = judge('cd /d D:\\x && git push', { dialect: 'cmd', branch: 'main' });
    assert.equal(moved.decision, 'ask');
    assert.equal(moved.repo.branch.mock.calls[0]?.arguments[0], 'D:\\x');
  });

  it('expands git aliases from config, -c options and an earlier git config in the line', () => {
    const config = {
      'alias.p': 'push origin main',
      'alias.pf': 'push -f origin main',
      'alias.sp': '!git push origin main',
      'alias.loop': 'loop',
      'alias.fwd': 'p',
    };
    expectRows(
      [
        ['git p', 'ask'],
        ['git pf', 'deny'],
        ['git sp', 'ask'],
        ['git fwd', 'ask'],
        ['git loop', 'ask', 'doubt'],
        ['git broken', 'ask', 'doubt'],
        ['git foo origin main', 'allow'],
        ["git -c alias.q='push origin main' q", 'ask'],
        ['git -c alias.q="$X" q', 'allow'],
        ['git -c alias.q="$X push" q', 'ask', 'doubt'],
        ["git config alias.ship 'push -f origin main' && git ship", 'deny'],
        ['git -C "$D" foo', 'allow'],
      ],
      { config, unreadable: ['alias.broken'] },
    );
  });

  it('follows branch changes earlier in the line', () => {
    expectRows([
      ['git checkout main && git push', 'ask'],
      ['git switch -c hotfix && git push', 'allow'],
      ['git switch main && git push -f', 'deny'],
      ['git checkout main && git push origin HEAD', 'ask'],
      ['git checkout -- main && git push', 'allow'],
      ['git checkout feature-x && git push', 'ask', 'doubt'],
      ['git -C sub checkout main && git push', 'ask', 'doubt'],
    ]);
  });

  it('reads the commands git itself runs', () => {
    expectRows([
      ["git submodule foreach 'git push origin main'", 'ask'],
      ["git rebase -x 'git push -f origin main' main", 'deny'],
      ['git bisect run git push origin main', 'ask'],
      ["git filter-branch --tree-filter 'git push origin main' HEAD", 'ask'],
    ]);
  });

  it('reads other push commands and refspec forms', () => {
    expectRows([
      ['git send-pack origin', 'ask'],
      ['git send-pack --force origin main', 'deny'],
      ['git subtree push --prefix=dist origin main', 'ask'],
      ['git push origin tag v1', 'allow'],
      ["git push origin 'refs/heads/*:refs/heads/*'", 'ask'],
      ["git push --prune origin 'refs/heads/*:refs/heads/*'", 'deny'],
      ['git push origin feature:ma*', 'ask'],
      ['git push origin :', 'ask'],
      ['git push origin +:', 'deny'],
      ['git push --mirr origin', 'deny'],
      ['git push --force --no-force origin main', 'ask'],
      ['git push -o ci.skip origin main', 'ask'],
      ['git push -oci.skip origin feature', 'allow'],
      ['git push -f origin feature', 'allow'],
      ['git push origin @:main', 'ask'],
      ['git push origin HEAD:refs/heads/main', 'ask'],
      ['git push origin $(git branch --show-current)', 'allow'],
    ]);
  });

  it('reads a variable set to a literal earlier in the line as that literal', () => {
    expectRows([
      ['B=feat; git push -u origin $B', 'allow'],
      ['B=feat && git push origin "$B"', 'allow'],
      ['export B=feat; git push origin ${B}', 'allow'],
      ["B='feat'\ngit push origin $B", 'allow'],
      ['B="feat"; git push origin HEAD:refs/heads/$B', 'allow'],
      ['cd sub && B=feat && git push origin $B', 'allow'],
      ['B=feat; git push origin $B 2>&1 | tail -5', 'allow'],
      ['B=feat; bash -c "git push origin $B"', 'allow'],
      ['(B=feat; git push origin $B)', 'allow'],
      ['B=main; git push origin $B', 'ask'],
      ['B=feat; git push origin $B:main', 'ask'],
      ['B=main; git push -f origin $B', 'deny'],
      ['B=+main; git push origin $B', 'deny'],
      ['D=sub; cd $D && git push', 'allow'],
      [checkedPush('topic'), 'allow'],
      [checkedPush('main'), 'ask'],
    ]);
  });
});

describe('evaluatePushes: the fail-safe', () => {
  it('asks about a push it cannot read, and says why', () => {
    expectRows([
      ['git push origin "$BRANCH"', 'ask', 'doubt'],
      ['git push $ARGS', 'ask', 'doubt'],
      ["git push origin 'feature", 'ask', 'doubt'],
      ["git push origin 'main", 'ask'],
      ['$GIT push origin main', 'ask', 'doubt'],
      ['cd "$DIR" && git push', 'ask', 'doubt'],
      ['git -C "$D" push', 'ask', 'doubt'],
      ['GIT_CONFIG_GLOBAL=/tmp/x git push', 'ask', 'doubt'],
      ['GIT_COMMON_DIR=x git push', 'ask', 'doubt'],
    ]);
  });

  it('asks about a variable it cannot prove holds one literal when the push runs', () => {
    expectRows([
      ['B=feat git push origin $B', 'ask', 'doubt'],
      ['B=$(git rev-parse --abbrev-ref HEAD); git push origin $B', 'ask', 'doubt'],
      ['B=$OTHER; git push origin $B', 'ask', 'doubt'],
      ['B=feat; B=main; git push origin $B', 'ask', 'doubt'],
      ['B=feat; (B=main); git push origin $B', 'ask', 'doubt'],
      ['(B=feat); git push origin $B', 'ask', 'doubt'],
      ['false && B=feat; git push origin $B', 'ask', 'doubt'],
      ['if true; then B=main; fi; B=feat; git push origin $B', 'ask', 'doubt'],
      ['B=feat; source ./set.sh; git push origin $B', 'ask', 'doubt'],
      ['B=feat; eval "B=main"; git push origin $B', 'ask', 'doubt'],
      ['B=feat; read B; git push origin $B', 'ask', 'doubt'],
      ['B=feat; git push origin ${B:-main}', 'ask', 'doubt'],
      ["B=feat; bash -c 'git push origin $B'", 'ask', 'doubt'],
    ]);
    expectRows([["$B = 'feat'; git push origin $B", 'ask', 'doubt']], { dialect: 'powershell' });
  });

  it('treats GIT_DIR or GIT_CONFIG set earlier in the shell as unknown', () => {
    expectRows([
      ['export GIT_DIR=../o/.git; git push', 'ask', 'doubt'],
      ['GIT_DIR=../o/.git; git push', 'ask', 'doubt'],
      ['declare -x GIT_DIR=x && git push origin main', 'ask'],
      ['export GIT_CONFIG_GLOBAL=/tmp/c; git push', 'ask', 'doubt'],
      ['export FOO=1; git push', 'allow'],
    ]);
    expectRows(
      [
        ["$env:GIT_DIR = 'x'; git push", 'ask', 'doubt'],
        ["$env:GIT_DIR='x'; git push", 'ask', 'doubt'],
        ['Set-Item env:GIT_DIR x; git push', 'ask', 'doubt'],
        ['$env:GIT_DIR; git push', 'allow'],
      ],
      { dialect: 'powershell' },
    );
    expectRows(
      [
        ['set GIT_DIR=x && git push', 'ask', 'doubt'],
        ['set "GIT_DIR=x" && git push', 'ask', 'doubt'],
      ],
      { dialect: 'cmd' },
    );
  });

  it('asks about anything else it cannot read only when the line mentions a push', () => {
    expectRows([
      ['eval "$X"', 'allow'],
      ['bash -c "$CMD"', 'allow'],
      ['eval "$X" && echo push', 'ask', 'doubt'],
    ]);
  });

  it('allows everything when no branch is protected', () => {
    expectRows([['git push $ARGS', 'allow']], { protectedBranches: [] });
  });

  it('prefers a plain ask over a doubt, and sets the doubt only on a doubt-ask', () => {
    const plain = evaluatePushes('git push $ARGS; git push origin main', {
      cwd: CWD,
      home: HOME,
      dialect: 'bash',
      protectedBranches: ['main'],
      repo: fakeRepo(),
    });
    assert.equal(plain.decision, 'ask');
    assert.equal('doubt' in plain, false);
    assert.equal(judge('git push $ARGS').doubt, 'its remote is only known when it runs, and may carry refspecs or flags');
  });
});

describe('evaluatePushes: the protected updates', () => {
  const context = (repo: RepoFake = {}) => ({ cwd: CWD, home: HOME, dialect: 'bash' as const, protectedBranches: ['main'], repo: fakeRepo(repo) });

  it('names each protected branch an asked push updates, and the ref it sends', () => {
    assert.deepEqual(evaluatePushes('git push origin feature:main x:dev', context()), {
      decision: 'ask',
      updates: [{ dir: CWD, base: 'origin/main', source: 'feature' }],
    });
    assert.deepEqual(evaluatePushes('git push upstream HEAD refs/heads/main && git push', context({ branch: 'main' })), {
      decision: 'ask',
      updates: [
        { dir: CWD, base: 'upstream/main', source: 'HEAD' },
        { dir: CWD, base: 'upstream/main', source: 'refs/heads/main' },
        { dir: CWD, base: 'origin/main', source: 'HEAD' },
      ],
    });
  });

  it('reads a bare push through its push target, whose remote it keeps', () => {
    const verdict = evaluatePushes('git push', context({ branch: 'feature', pushTarget: 'fork/main' }));
    assert.deepEqual(verdict.updates, [{ dir: CWD, base: 'fork/main', source: 'HEAD' }]);
    assert.deepEqual(evaluatePushes('git push origin', context({ branch: 'feature', pushTarget: 'fork/main' })).updates, [
      { dir: CWD, base: 'origin/main', source: 'HEAD' },
    ]);
  });

  it('sends the branch a checkout earlier in the line moved to', () => {
    assert.deepEqual(evaluatePushes('git checkout main && git push', context()).updates, [{ dir: CWD, base: 'origin/main', source: 'main' }]);
  });

  it('lists nothing for --all, a refusal or a push it allows', () => {
    assert.deepEqual(evaluatePushes('git push --all origin', context()), { decision: 'ask', updates: [] });
    assert.deepEqual(evaluatePushes('git push origin main && git push -f origin main', context()), { decision: 'deny', updates: [] });
    assert.deepEqual(evaluatePushes('git push origin feature', context()), { decision: 'allow', updates: [] });
    assert.deepEqual(evaluatePushes('git status', context()), { decision: 'allow', updates: [] });
  });
});

describe('decisionReason and doubtReason', () => {
  it('names the protected branches', () => {
    assert.match(decisionReason('deny', ['main', 'release']), /^Force-pushing, mirroring or deleting a protected branch \(main, release\) is refused/);
    assert.match(decisionReason('ask', ['main']), /^This push updates a protected branch \(main\)/);
    assert.equal(
      doubtReason('its folder is only known when it runs', ['main', 'master']),
      'The guard cannot tell whether this command pushes to a protected branch (main, master): its folder is only known when it runs. Confirm, or write the push out plainly.',
    );
  });
});
