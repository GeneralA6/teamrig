import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_EFFECTS } from '../cli/run.ts';
import { runsOf } from '../package-guard/programs.ts';
import { testConfig } from '../testing/config.ts';
import { ghWriteRefusals, githubReposOf, ISSUE_COMMANDS, type GhWriteEnv } from './gh-write-refusals.ts';

/** A team whose one GitHub repository is acme/web, run from its checkout C:/w. */
const TEAM: GhWriteEnv = {
  github: { kind: 'repos', repos: new Set(['acme/web']) },
  remotesOf: (dir) => (dir.replaceAll('\\', '/') === 'C:/w' ? ['acme/web'] : undefined),
  ghRepo: undefined,
};

/** The same team, run from a contributor's fork. */
const FORK: GhWriteEnv = { ...TEAM, remotesOf: () => ['someone/fork'] };

function refusals(line: string, env: GhWriteEnv = TEAM, dialect: 'bash' | 'powershell' = 'bash'): string[] {
  return ghWriteRefusals(runsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect }), env);
}

/** The one refusal a line gets. */
function refusal(line: string, env: GhWriteEnv = TEAM): string {
  const found = refusals(line, env);
  assert.equal(found.length, 1, `${line}: ${found.join(' | ')}`);
  return found[0] ?? '';
}

describe('ghWriteRefusals: a write on a team repository (T4819)', () => {
  it('refuses a write on a team repository, named or the folder’s, wherever the line runs it, naming the teamrig command', () => {
    for (const [line, what, command] of [
      ['gh issue close 7 -R acme/web', 'gh issue close', 'teamrig issue close'],
      ['git fetch && gh pr merge 3 --rebase', 'gh pr merge', 'teamrig merge'],
      ['gh pr create --fill', 'gh pr create', 'teamrig merge'],
      ['gh issue comment 7 --body hi -R https://github.com/Acme/Web', 'gh issue comment', 'teamrig issue reply'],
      ["bash -c 'gh issue edit 7 --add-label bug'", 'gh issue edit', 'teamrig issue label'],
      ['gh api -X PATCH repos/acme/web/issues/7 -f state=closed', 'gh api PATCH repos/acme/web/issues/7', 'teamrig issue edit'],
    ] as const) {
      const why = refusal(line);
      assert.ok(why.startsWith(`\`${what}\` writes on acme/web, a repository of the team, with this machine's own gh login`), `${line}: ${why}`);
      assert.ok(why.includes("Run teamrig's instead, which writes with the team's saved GitHub key: `teamrig "), `${line}: ${why}`);
      assert.match(why, new RegExp(`\`${command}[\` ]`, 'u'), `${line}: ${why}`);
    }
  });

  it('refuses, from a fork’s folder, a write whose -R/--repo comes before its command (R1)', () => {
    for (const line of ['gh pr --repo=acme/web merge 5', 'gh pr -Racme/web merge 5', 'gh pr -R acme/web merge 5']) {
      assert.match(refusal(line, FORK), /^`gh pr merge` writes on acme\/web, a repository of the team/u, line);
    }
  });

  it('refuses a gh api write through :owner/:repo in a team checkout, and lets it pass in a fork (R2)', () => {
    assert.match(refusal('gh api -X PUT repos/:owner/:repo/pulls/5/merge'), /writes on acme\/web, a repository of the team/u);
    assert.deepEqual(refusals('gh api -X PUT repos/:owner/:repo/pulls/5/merge', FORK), []);
  });

  it('refuses a gh api call or a group with a word only known when it runs, whatever it looks like (R3, R4)', () => {
    for (const line of ['gh api "$M" repos/acme/web/pulls/5/merge', 'gh api $E', 'gh api repos/acme/web/pulls -q $Q', 'gh $G list']) {
      assert.match(refusal(line, FORK), /so the guard cannot tell whether it reaches one of the team's repositories/u, line);
    }
  });

  it('sends a write no teamrig command does to the lead', () => {
    assert.ok(refusal('gh release create v1').endsWith('no teamrig command does this write yet: ask your lead, who has it done with the team\'s saved key.'));
  });

  it('lets every read pass, and every call on a team with no GitHub repository', () => {
    for (const line of ['gh issue view 7', 'gh api repos/acme/web/pulls/3', 'gh pr list --state open', 'gh pr checkout 3', 'gh search prs is:open', 'gh api graphql -f query={viewer{login}}', 'gh']) {
      assert.deepEqual(refusals(line), [], line);
    }
    assert.deepEqual(refusals('gh issue $verb 7', { ...TEAM, github: { kind: 'none' } }), []);
  });
});

describe('ghWriteRefusals: where a write lands (T4819)', () => {
  it('keeps plain gh on a repository that is not the team’s, so a contributor’s own gh flow still works', () => {
    for (const line of ['gh issue close 7 -R someone/fork', 'gh pr create --fill', 'gh repo fork acme/other', 'gh api -X PATCH repos/someone/fork/issues/7 -f state=closed']) {
      assert.deepEqual(refusals(line, FORK), [], line);
    }
    assert.ok(refusal('gh pr create --fill -R acme/web', FORK).startsWith('`gh pr create` writes on acme/web'));
  });

  it('places a write that names no repository by GH_REPO before the folder’s remotes', () => {
    assert.ok(refusal('gh pr create --fill', { ...FORK, ghRepo: 'acme/web' }).startsWith('`gh pr create` writes on acme/web'));
    assert.deepEqual(refusals('gh pr create --fill', { ...TEAM, ghRepo: 'someone/fork' }), []);
  });

  it('cannot place a folder’s write when the line may change which repository it is, or git cannot tell', () => {
    for (const line of [
      'git remote set-url origin https://github.com/someone/fork && gh pr create --fill',
      'GH_REPO=someone/fork gh pr create --fill',
      'export GIT_DIR=/elsewhere; gh pr create --fill',
      'git my-alias && gh pr create --fill',
      'git $SUB && gh pr create --fill',
    ]) {
      assert.ok(refusal(line, FORK).includes('writes on the repository of the folder it runs in (or `GH_REPO`), which the guard cannot read'), line);
    }
    assert.ok(refusal('gh pr create --fill', { ...TEAM, remotesOf: () => undefined }).includes('name the repository with `-R`'));
    assert.deepEqual(refusals('gh pr create --fill -R someone/fork', { ...TEAM, remotesOf: () => undefined }), []);
    assert.deepEqual(refusals('git status && gh pr create --fill', FORK), []);
  });

  it('refuses a write it cannot place at all', () => {
    for (const [line, says] of [
      ['gh issue $verb 7', '`gh issue $verb` writes with this machine\'s own gh login, and its command is only known when it runs'],
      ['gh issue comment 7 --body $MSG', 'a word only known when it runs may name another repository'],
      ['gh gist create f.txt', 'it writes on the GitHub account, outside any one repository'],
      ['gh api graphql -f query=mutation{closeIssue}', 'GraphQL mutation'],
      ['gh mymerge 3', 'gh runs it as an alias or an extension'],
    ] as const) {
      assert.ok(refusal(line, FORK).includes(says), `${line}: ${refusal(line, FORK)}`);
    }
  });

  it('reads a program only known when it runs as gh when its words start a gh call, and not when they start a teamrig issue call', () => {
    assert.ok(refusal('$GH issue edit 7 --title x').includes('writes on the repository of the folder it runs in'));
    assert.ok(refusal('$GH issue close 7 -R acme/web').startsWith('`gh issue close` writes on acme/web'));
    for (const line of ['$T issue reply acme/web#7 --body-file f.md', '$T issue close acme/web#7', '$T issue edit acme/web#7 --body-file f.md', '$T issue label acme/web#7 --add bug', '$T issue similar acme/web#7', '$T list']) {
      assert.deepEqual(refusals(line), [], line);
    }
  });
});

describe('ghWriteRefusals: the team config (T4819)', () => {
  it('refuses every write while the config does not load, and lets reads pass', () => {
    const broken: GhWriteEnv = { ...TEAM, github: { kind: 'unknown', why: 'the team config did not load' } };
    assert.ok(refusal('gh issue close 7 -R someone/fork', broken).startsWith('`gh issue close` writes on GitHub, and the team config did not load, so the guard cannot tell'));
    assert.deepEqual(refusals('gh issue view 7', broken), []);
  });

  it('reads the team repositories from the config load, failing closed when it did not load', () => {
    assert.deepEqual(githubReposOf(undefined), { kind: 'unknown', why: 'the team config did not load' });
    assert.deepEqual(githubReposOf({ status: 'missing', path: 'c.json' }), { kind: 'unknown', why: 'the team config is missing' });
    assert.deepEqual(githubReposOf({ status: 'loaded', path: 'c.json', config: testConfig(), issues: [], warnings: [] }), { kind: 'none' });
    const loaded = githubReposOf({ status: 'loaded', path: 'c.json', config: testConfig({ github: { repos: ['Acme/Web'] } }), issues: [], warnings: [] });
    assert.deepEqual(loaded, { kind: 'repos', repos: new Set(['acme/web']) });
  });

  it('knows every teamrig issue command the CLI has, so a call through an unknown program reads as teamrig’s, not gh’s', () => {
    const commands = Object.keys(COMMAND_EFFECTS).filter((name) => name.startsWith('issue ')).map((name) => name.slice('issue '.length));
    assert.deepEqual([...ISSUE_COMMANDS].sort(), commands.sort());
  });
});
