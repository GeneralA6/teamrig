import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { PushToProtected } from '../config/types.ts';
import type { ConfigValue } from './invocations.ts';
import {
  decisionReason,
  doubtReason,
  evaluatePushes,
  leasedReason,
  type GuardContext,
  type ProtectedPush,
  type PushDecision,
  type RepoState,
} from './push.ts';
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
    head: mock.fn((_dir: string): string | undefined => undefined),
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
  readonly pushToProtected?: PushToProtected;
}

function judge(
  command: string,
  { dialect = 'bash', cwd = CWD, protectedBranches = ['main', 'master'], pushToProtected = 'ask', ...state }: JudgeOptions = {},
) {
  const repo = fakeRepo(state);
  const verdict = evaluatePushes(command, { cwd, home: HOME, dialect, protectedBranches, pushToProtected, repo });
  const decision: PushDecision = verdict.decision;
  const protectedPush: ProtectedPush | undefined = verdict.protectedPush;
  return { decision, doubt: verdict.doubt, protectedPush, updates: verdict.updates, repo };
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

  it('stays quiet on a worktree clean-up whose only push is inside file names or a stored note', () => {
    const link = 'cmd //c mklink //J "$(cygpath -w $W/node_modules)" "$(cygpath -w /w/main/node_modules)"';
    const unlink = 'cmd //c rmdir "$(cygpath -w $W/node_modules)"';
    const note = "cat >> notes.md <<'EOF'\n\nMerged as version 0.7.1 (main was 0.7.0 at push; the branch moved onto it).\nA spec closed meter.ts's gap.\nEOF\necho ok";
    expectRows([
      [`B=topic; W=/w/$B; git -C /w/main worktree add -b $B $W origin/main && ${link} && cd $W && wc -l src/push-guard/*.ts && ls src/push-guard`, 'allow'],
      [`S=/tmp/s; grep -n "local checks" $S/x-local-push.log; W=/w/topic; ${unlink}; ls -la $W | grep node_modules || echo "link gone"`, 'allow'],
      [`W=/w/topic; ${unlink}; test -e $W/node_modules && echo "LINK STILL THERE" || (git -C /w/main worktree remove $W && echo removed); ${note}`, 'allow'],
    ]);
  });

  it('still asks when such a line pushes main, or says push beside what it cannot read', () => {
    const unlink = 'cmd //c rmdir "$(cygpath -w $W/node_modules)"';
    expectRows([
      [`W=/w/topic; ${unlink}; git push origin main`, 'ask'],
      [`W=/w/topic; ${unlink}; echo push`, 'ask', 'doubt'],
      [`W=/w/topic; ${unlink}; cat >> notes.md <<EOF\n$(git push origin main)\nEOF`, 'ask'],
    ]);
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
  it('asks about a push held in quoted text, which bash runs if an expansion reads the text again', () => {
    expectRows([
      ["x='$(git push origin main)'; echo ${x@P}", 'ask', 'doubt'],
      ["x='a[$(git push -f origin main)]'; echo $((x))", 'ask', 'doubt'],
      ["x='$(git push origin main) $('; echo ${x@P}", 'ask', 'doubt'],
      [`x='${'$('.repeat(20)}git push origin main${')'.repeat(20)}'; echo \${x@P}`, 'ask', 'doubt'],
      ["git commit -m 'run $(git log -1) first'", 'allow'],
      ["bash -c 'echo $(git push origin feature)'", 'allow'],
      [`grep -n "^##\\|push(\\\`##\\|'## " src/push-guard/push.ts`, 'allow'],
    ]);
  });

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

  it('reads the substitutions inside ${...} and arithmetic', () => {
    expectRows([
      ['echo $(( $(git push origin main) ))', 'ask'],
      ['echo "$[ `git push -f origin main` ]"', 'deny'],
      ['echo ${B:-$(git push origin main)}', 'ask'],
      ['echo "${B:-$(git push -f origin main)}"', 'deny'],
      ['echo ${A[$(git push origin main)]}', 'ask'],
      ['cat <<EOF\n${B:-`git push origin main`}\nEOF', 'ask'],
      [`echo "\${B:-'}"'$(git push origin main)''}"`, 'ask'],
      ["echo ${B:-'$(git push origin main)'}", 'allow'],
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

  it('reads the command teamrig queue and teamrig test run after their --, but not a teamrig note', () => {
    expectRows([
      ['teamrig queue --session po --what "ship it" -- git push origin main', 'ask'],
      ['teamrig test --session po -- git push -f origin main', 'deny'],
      ['teamrig.cmd queue --what x -- teamrig test -- git push origin main', 'ask'],
      ['teamrig queue --what x -- "git push origin main"', 'ask'],
      ['teamrig queue --what x -- git push origin feature', 'allow'],
      ['teamrig add --description "it ran teamrig queue -- git push -f origin main"', 'allow'],
      ['teamrig $SUB -- git push origin main', 'ask', 'doubt'],
    ]);
  });

  it('still reads the command under teamrig heavy, the old name of queue, which an older teamrig runs', () => {
    expectRows([
      ['teamrig heavy --session po --what "ship it" -- git push origin main', 'ask'],
      ['teamrig heavy --what x -- git push -f origin main', 'deny'],
      ['teamrig heavy --what x -- git push origin feature', 'allow'],
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

  it("reads $HOME and a value's leading ~ as the home folder in the line's own shell, not in a script it starts", () => {
    expectRows([
      ['TR=~/x/bin/teamrig; $TR set T1 --note "push later"', 'allow'],
      ['G=~/bin/git; $G push origin feat', 'allow'],
      ['G=~/bin/git; $G push origin main', 'ask'],
      ['$HOME/bin/git push -f origin main', 'deny'],
      ['HOME=/h; $HOME/bin/git push origin main', 'ask'],
      ["bash -c '$HOME/bin/git push origin feat'", 'ask', 'doubt'],
      ["HOME=/h bash -c 'G=~/git; $G push origin feat'", 'ask', 'doubt'],
    ]);
  });

  it('keeps quoted text and heredoc bodies from hiding a binding', () => {
    expectRows([
      ["B=feat; echo '((x<<2))' \"<<EOF\"; git push origin $B", 'allow'],
      ['B=feat; cat <<EOF\nnote\nEOF\ngit push origin $B', 'allow'],
      ["B=main; echo '((x<<2))' \"<<EOF\"; git push origin $B", 'ask'],
      ['B=main; cat <<EOF\nnote\nEOF\ngit push origin $B', 'ask'],
      ['cat <<$D\nB=feat\n$D\ngit push origin $B', 'ask', 'doubt'],
    ]);
  });

  it('reads a program and arguments a variable holds as the words bash splits them into', () => {
    expectRows([
      ['G="git -C /w"; $G push origin main', 'ask'],
      ['X="git push"; $X origin main', 'ask'],
      ['X="git push -f"; $X origin main', 'deny'],
      ['A="origin main"; git push $A', 'ask'],
      ['P=git; $P push origin main', 'ask'],
      ['X="git push"; $X origin topic', 'allow'],
      ['A="origin topic"; git push $A', 'allow'],
      ['P="node probe.ts"; $P "$l"', 'allow'],
      [
        'S=/tmp/s; C=~/tools/cli.ts; W=/work/t; H="node --disable-warning=ExperimentalWarning $C queue --session s"\n' +
          '$H --what "push topic" --max-minutes 20 -- git -C $W push -u origin topic > $S/x.log 2>&1; echo push=$?; grep -E "error" $S/x.log',
        'allow',
      ],
      ['H="$G push"; $H origin main', 'ask', 'doubt'],
      ['X="git push"; $X origin $B', 'ask', 'doubt'],
      ['P="export B=main"; B=topic; $P; git push origin $B', 'ask', 'doubt'],
    ]);
  });

  it('runs a probe loop through a program variable quietly, unless the binding may not have run', () => {
    const loop = `for l in 'a > out' $'cat <<EOF\\ngit push origin main\\nEOF' $'((x<<2))\\ngit push'; do echo "== $l"; $P "$l"; done; $P $'x' powershell`;
    expectRows([
      [`P="node probe.ts"\n${loop}`, 'allow'],
      [`cd /work || exit; P="node probe.ts"\n${loop}`, 'allow'],
      [`cd /work\nP="node probe.ts"; ${loop}`, 'allow'],
      [`cd /work && P="node probe.ts"\n${loop}`, 'ask', 'doubt'],
      ['P="git push"; for b in x; do $P origin main; done', 'ask'],
      ['for b in main; do git push origin $b; done', 'ask', 'doubt'],
      ['B=main; for x in a; do git push origin $B; done', 'ask'],
    ]);
  });

  it('reads past a ${...} that only reads, on one line or across several', () => {
    const script = [
      'cd /w; T="node main.js"',
      `$T set x1 --session a --status in-progress --note "reopened: false ask; for x in 'a|push'; do \\$T set ...; done asks"`,
      'for r in "a|b"; do R=/p/${r%%|*}; git -C $R fetch -q origin; done',
    ].join('\n');
    expectRows([
      ['T="node main.js"; for x in "a|no false push prompt"; do $T set ${x%%|*} --evidence "${x#*|}"; done', 'allow'],
      [script, 'allow'],
      ['T="node main.js"\nfor x in "a|b"; do\n  $T set ${x%%|*} --note "${x#*|} push"\ndone', 'allow'],
      ['T=git; for x in a; do $T push origin main; done', 'ask'],
      ['T=git; B=main; echo ${B%%|*} ${#B}; $T push origin $B', 'ask'],
      ['T=git; for x in "a|b"; do $T push origin ${x%%|*}; done', 'ask', 'doubt'],
      ['T="node main.js"; : ${T:=git}; $T push origin main', 'ask', 'doubt'],
    ]);
  });

  it('follows the line bindings into a loop, an if and a { } group, and never one made inside them', () => {
    expectRows([
      ['T="node main.js"; if true; then $T set x1 --evidence push; fi', 'allow'],
      ['T="node main.js"; if ! a; then :; elif b; then $T set push; else { $T set push; }; fi', 'allow'],
      ['T="node main.js"; while false; do $T set push; done; until true; do $T set push; done', 'allow'],
      ['T=git; if c; then $T push origin main; fi', 'ask'],
      ['T=git; while c; do { $T push origin main; }; done', 'ask'],
      ['T=echo; if c; then T=git; fi; $T push origin main', 'ask', 'doubt'],
      ['T=echo; while c; do $T push origin main; T=git; done', 'ask', 'doubt'],
      ['for p in git; do $p push origin main; done', 'ask', 'doubt'],
      ['T=echo; "if" c; then T=git; fi; $T push origin main', 'ask', 'doubt'],
    ]);
  });

  it('follows the line bindings into the subshells started after them, and never one made inside them', () => {
    expectRows([
      ['T="node main.js"; (cd sub && $T set x1 --evidence push)', 'allow'],
      ['T="node main.js"; (cd sub); $T set x1 --evidence push', 'allow'],
      ['T="node main.js"; echo "$($T set x1 --evidence push)"', 'allow'],
      ['T=git; (cd sub && $T push origin main)', 'ask'],
      ['T=git; echo "$($T push origin main)"', 'ask'],
      ['T=echo; (T=git; $T push origin main)', 'ask', 'doubt'],
      ['T=echo; (T=git); $T push origin main', 'ask', 'doubt'],
      ['T=git & ($T push origin main)', 'ask', 'doubt'],
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

  it('allows everything when no branch is protected, mirrors, matching pushes and doubts included', () => {
    const rows: readonly Row[] = [
      ['git push $ARGS', 'allow'],
      ['git push origin $B', 'allow'],
      ['eval "$X" && echo push', 'allow'],
      ['git push "origin main', 'allow'],
      ['git push --mirror origin', 'allow'],
      ['git push --all -f origin', 'allow'],
      ['git push --all origin', 'allow'],
      ['git push origin :', 'allow'],
      ['git push -f origin main', 'allow'],
      ['git push origin --delete main', 'allow'],
      ['git push origin main', 'allow'],
    ];
    expectRows(rows, { protectedBranches: [] });
    expectRows([['git push', 'allow']], { protectedBranches: [], config: { 'push.default': 'matching' } });
    expectRows([['git push --mirror origin', 'deny'], ['git push --all origin', 'ask'], ['eval "$X" && echo push', 'ask', 'doubt']], { protectedBranches: ['release'] });
  });

  it('prefers a plain ask over a doubt, and sets the doubt only on a doubt-ask', () => {
    const plain = evaluatePushes('git push $ARGS; git push origin main', {
      cwd: CWD,
      home: HOME,
      dialect: 'bash',
      protectedBranches: ['main'],
      pushToProtected: 'ask',
      repo: fakeRepo(),
    });
    assert.equal(plain.decision, 'ask');
    assert.equal('doubt' in plain, false);
    assert.equal(judge('git push $ARGS').doubt, 'its remote is only known when it runs, and may carry refspecs or flags');
  });
});

describe('evaluatePushes: the protected updates', () => {
  const context = (repo: RepoFake = {}): GuardContext => ({
    cwd: CWD,
    home: HOME,
    dialect: 'bash',
    protectedBranches: ['main'],
    pushToProtected: 'ask',
    repo: fakeRepo(repo),
  });

  it('names each protected branch an asked push updates, and the ref it sends', () => {
    assert.deepEqual(evaluatePushes('git push origin feature:main x:dev', context()), {
      decision: 'ask',
      updates: [{ dir: CWD, base: 'origin/main', source: 'feature' }],
      protectedPush: 'normal',
    });
    assert.deepEqual(evaluatePushes('git push upstream HEAD refs/heads/main && git push', context({ branch: 'main' })), {
      decision: 'ask',
      updates: [
        { dir: CWD, base: 'upstream/main', source: 'HEAD' },
        { dir: CWD, base: 'upstream/main', source: 'refs/heads/main' },
        { dir: CWD, base: 'origin/main', source: 'HEAD' },
      ],
      protectedPush: 'normal',
    });
  });

  it('lists the same updates when pushToProtected allows the push', () => {
    assert.deepEqual(evaluatePushes('git push origin feature:main', { ...context(), pushToProtected: 'allow' }), {
      decision: 'allow',
      updates: [{ dir: CWD, base: 'origin/main', source: 'feature' }],
      protectedPush: 'normal',
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
    assert.deepEqual(evaluatePushes('git push --all origin', context()), { decision: 'ask', updates: [], protectedPush: 'normal' });
    assert.deepEqual(evaluatePushes('git push origin main && git push -f origin main', context()), { decision: 'deny', updates: [] });
    assert.deepEqual(evaluatePushes('git push origin feature', context()), { decision: 'allow', updates: [] });
    assert.deepEqual(evaluatePushes('git status', context()), { decision: 'allow', updates: [] });
  });
});

describe('evaluatePushes: pushToProtected', () => {
  const CHOICES: readonly PushToProtected[] = ['ask', 'allow'];

  it('asks about a normal push to a protected branch under ask, and allows it under allow, marking it either way', () => {
    const commands = [
      'git push origin main',
      'git push origin HEAD:main',
      'git push --all origin',
      'git push origin :',
      'cd api && git push origin master',
      'git send-pack origin',
      'git subtree push --prefix=dist origin main',
      'git push --force-with-lease --no-force-with-lease origin main',
      'git push --force-with-lease origin feature && git push origin main',
    ];
    for (const command of commands) {
      for (const choice of CHOICES) {
        const verdict = judge(command, { pushToProtected: choice });
        assert.deepEqual([verdict.decision, verdict.protectedPush, verdict.doubt], [choice, 'normal', undefined], `${choice}: ${command}`);
      }
    }
    for (const choice of CHOICES) {
      assert.equal(judge('git push', { branch: 'main', pushToProtected: choice }).decision, choice);
      assert.equal(judge('git push', { branch: 'main', config: { 'push.default': 'matching' }, pushToProtected: choice }).decision, choice);
    }
  });

  it('keeps refusing a force-push, mirror or delete of a protected branch under either choice', () => {
    const commands = [
      'git push -f origin main',
      'git push origin +main',
      'git push --mirror origin',
      'git push --all -f origin',
      'git push origin --delete main',
      'git push origin :main',
      'git push --force-with-lease origin +main',
      'git push origin main && git push -f origin main',
    ];
    for (const command of commands) {
      for (const choice of CHOICES) {
        const verdict = judge(command, { pushToProtected: choice });
        assert.deepEqual([verdict.decision, verdict.protectedPush], ['deny', undefined], `${choice}: ${command}`);
      }
    }
  });

  it('asks about a --force-with-lease push to a protected branch under either choice', () => {
    const commands = [
      'git push --force-with-lease origin main',
      'git push --force-with-lease=main:abc123 origin main',
      'git push --force-with-lease --all origin',
      'git push origin main && git push --force-with-lease origin master',
      'git push --force-with-lease origin master && git push origin main',
      'git send-pack --force-with-lease origin main',
      'git send-pack --force-with-lease=main origin main',
    ];
    for (const command of commands) {
      for (const choice of CHOICES) {
        const verdict = judge(command, { pushToProtected: choice });
        assert.deepEqual([verdict.decision, verdict.protectedPush, verdict.doubt], ['ask', 'leased', undefined], `${choice}: ${command}`);
      }
    }
    assert.equal(judge('git push --force-with-lease origin feature', { pushToProtected: 'allow' }).decision, 'allow');
  });

  it('still asks in doubt under allow, keeping the updates it can read', () => {
    const doubtful = judge('git push $ARGS', { pushToProtected: 'allow' });
    assert.deepEqual([doubtful.decision, doubtful.protectedPush], ['ask', undefined]);
    assert.ok(doubtful.doubt !== undefined);
    const mixed = judge('git push origin feature:main; git push $ARGS', { pushToProtected: 'allow' });
    assert.deepEqual([mixed.decision, mixed.protectedPush, mixed.updates], ['ask', undefined, [{ dir: CWD, base: 'origin/main', source: 'feature' }]]);
    assert.ok(mixed.doubt !== undefined);
    const asked = judge('git push origin feature:main; git push $ARGS', { pushToProtected: 'ask' });
    assert.deepEqual([asked.decision, asked.protectedPush, asked.doubt], ['ask', 'normal', undefined]);
  });

  it('allows a push to an unprotected branch without marking it', () => {
    for (const choice of CHOICES) {
      const verdict = judge('git push origin feature && git status', { pushToProtected: choice });
      assert.deepEqual([verdict.decision, verdict.protectedPush, verdict.updates], ['allow', undefined, []]);
    }
  });
});

describe('decisionReason, leasedReason and doubtReason', () => {
  it('names the protected branches', () => {
    assert.match(decisionReason('deny', ['main', 'release']), /^Force-pushing, mirroring or deleting a protected branch \(main, release\) is refused/);
    assert.match(decisionReason('ask', ['main']), /^This push updates a protected branch \(main\)/);
    assert.equal(
      leasedReason(['main', 'master']),
      'This --force-with-lease push may rewrite the history of a protected branch (main, master) while other sessions may be working. Confirm, or push your own branch instead.',
    );
    assert.equal(
      doubtReason('its folder is only known when it runs', ['main', 'master']),
      'The guard cannot tell whether this command pushes to a protected branch (main, master): its folder is only known when it runs. Confirm, or write the push out plainly.',
    );
  });
});
