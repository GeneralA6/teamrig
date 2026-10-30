import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_TABLE } from '../cli/run.ts';
import { ClientInstalls, type ClientSearch } from '../exec/client-launch.ts';
import { ownClientOf } from './route-kit.ts';
import { routeOf, SANCTIONED_ROUTES, type RouteContext, type RouteId } from './sanctioned.ts';

const INSTALL = 'C:/u/.claude/plugins/cache/teamrig/teamrig/0.215.0';

/** The hook finds no teamrig on PATH, so a bare one runs the plugin bin Claude Code appends. */
const NOTHING_ON_PATH: ClientSearch = { find: async () => undefined };

const CONTEXT: RouteContext = {
  cli: COMMAND_TABLE,
  ownClient: ownClientOf(NOTHING_ON_PATH, new ClientInstalls(INSTALL, 'win32'), { dialect: 'bash', dir: 'C:/w', home: 'C:/u' }),
  ownsTask: async (task) => task === 'T1',
  isRemote: async (_folders, name) => name === 'origin',
  protectedBranches: ['main', 'master'],
};

const idOf = async (line: string, context: RouteContext = CONTEXT): Promise<RouteId | undefined> => (await routeOf(line, context))?.id;

const assertNoRoute = async (lines: readonly string[]): Promise<void> => {
  for (const line of lines) {
    assert.equal(await idOf(line), undefined, line);
  }
};

describe('SANCTIONED_ROUTES', () => {
  it('matches each canary to its own entry', async () => {
    for (const route of SANCTIONED_ROUTES) {
      assert.equal(await idOf(route.canary), route.id, route.canary);
    }
  });

  it('names each route once, and leaves the register and git push out of the PreToolUse allow (Q7.3)', () => {
    const ids = SANCTIONED_ROUTES.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length);
    const notAtPreToolUse = SANCTIONED_ROUTES.filter((route) => !route.preToolUse).map((route) => route.id);
    assert.deepEqual(notAtPreToolUse, ['register', 'git-push']);
  });
});

describe('routeOf', () => {
  it('finds the route a plain line runs', async () => {
    const routes: ReadonlyArray<readonly [string, RouteId]> = [
      ['teamrig merge --session tr-canary --keep-remote', 'merge'],
      [`${INSTALL}/bin/teamrig merge`, 'merge'],
      ['teamrig deploy --repo web 2>&1', 'deploy'],
      ['teamrig worktree remove "C:/w/t1 canary" --delete-branch', 'worktree-remove'],
      ['teamrig set T1 --session tr-canary --status done --note "a note, quoted"', 'register'],
      ['teamrig inbox add --to teamrig --text x', 'register'],
      ['git commit -s -m "fix: the route (T1)"', 'git-commit'],
      ['git -C C:/w push origin t1-canary', 'git-push'],
    ];
    for (const [line, id] of routes) {
      assert.equal(await idOf(line), id, line);
    }
  });

  it('C1: finds none in a line that joins, feeds, redirects, substitutes or sets a variable', async () => {
    await assertNoRoute([
      'teamrig merge; rm -rf x',
      'teamrig merge && git push origin main',
      'teamrig merge || true',
      'teamrig list | sh',
      'teamrig merge &',
      'teamrig merge\nrm x',
      'teamrig merge\r',
      'teamrig merge $(echo --force)',
      'teamrig merge `id`',
      'teamrig merge ${FLAGS}',
      'teamrig merge --session $SESSION',
      'git commit -F <(echo x)',
      'git commit -F - <<EOF',
      'teamrig list > out.txt',
      'teamrig list 2> err.txt',
      'teamrig list >&2',
      'teamrig list < in.txt',
      'HUSKY=0 git commit -m msg',
      'GIT_CONFIG_COUNT=1 git commit -m msg',
      '(teamrig merge)',
      '{ teamrig merge; }',
      'git commit -m "a;b"',
      'teamrig worktree remove C:/w/t1-* --session tr-canary',
      'teamrig worktree remove ~/w --session tr-canary',
      '',
    ]);
  });

  it('C2: finds none for a program word that is not its own launcher', async () => {
    await assertNoRoute([
      './teamrig merge',
      'bin/teamrig merge',
      'C:/elsewhere/teamrig merge',
      `${INSTALL}/bin/teamrig.cmd merge`,
      `${INSTALL}/dist/cli/main.js merge`,
      'C:/u/.claude/plugins/cache/teamrig/teamrig/0.214.0/bin/teamrig merge',
      'teamrig.cmd merge',
      'Teamrig merge',
    ]);
    const shadowed: RouteContext = {
      ...CONTEXT,
      ownClient: ownClientOf({ find: async () => 'C:/u/bin/teamrig' }, new ClientInstalls(INSTALL, 'win32'), { dialect: 'bash', dir: 'C:/w', home: 'C:/u' }),
    };
    assert.equal(await idOf('teamrig merge', shadowed), undefined, 'a teamrig on PATH before the plugin bin');
  });

  it('C3: finds none for a flag the route leaves out, a help request or a --', async () => {
    await assertNoRoute([
      'teamrig merge --force',
      'teamrig merge --help',
      'teamrig worktree remove C:/w/t1-x --base main',
      'teamrig deploy --targets web --what x -- npm ci',
      'teamrig deploy --session tr-canary --',
      'teamrig list --session tr-canary --',
    ]);
  });

  it('C4: finds none for a commit that skips or moves its hooks', async () => {
    await assertNoRoute([
      'git commit -n -m msg',
      'git commit -an -m msg',
      'git commit -nm msg',
      'git commit --no-verify -m msg',
      'git commit --no-veri -m msg',
      'git commit --amend --no-edit',
      'git -c core.hooksPath=/x commit -m msg',
      'git --config-env=core.hooksPath=X commit -m msg',
      'git --exec-path=/x commit -m msg',
      'git --git-dir=/x commit -m msg',
      'git --work-tree /x commit -m msg',
      'git -C C:/w -c x=y commit -m msg',
    ]);
  });

  it('C5: finds none for a push that is not a task branch of the caller to a configured remote', async () => {
    await assertNoRoute([
      'git push',
      'git push origin',
      'git push origin main',
      'git push origin MAIN',
      'git push origin t2-other',
      'git push origin t9-nobody',
      'git push origin feature',
      'git push upstream t1-canary',
      'git push https://example.invalid/x.git t1-canary',
      'git push ext::sh t1-canary',
      'git push C:/w t1-canary',
      'git push origin +t1-canary',
      'git push origin t1-canary:main',
      'git push origin refs/heads/t1-canary',
      'git push origin HEAD',
      'git push origin t1-canary..main',
      'git push origin t1-canary t1-more',
      'git push -f origin t1-canary',
      'git push --force origin t1-canary',
      'git push --force-with-lease origin t1-canary',
      'git push --force-if-includes origin t1-canary',
      'git push --mirror origin',
      'git push --all origin',
      'git push -d origin t1-canary',
      'git push --delete origin t1-canary',
      'git push --prune origin t1-canary',
      'git push --no-verify origin t1-canary',
      'git push --receive-pack=x origin t1-canary',
      'git push --exec=x origin t1-canary',
      'git push --repo=origin t1-canary',
      'git push -o ci.skip origin t1-canary',
    ]);
  });

  it('C8: finds none for exec approve, run or dry-run', async () => {
    await assertNoRoute(['teamrig exec approve R1 --session tr-canary', 'teamrig exec run R1', 'teamrig exec dry-run R1']);
  });

  it('finds none for a route run through a wrapper, which would run what it names', async () => {
    await assertNoRoute([
      'env teamrig merge',
      'env -u X teamrig merge',
      'sudo teamrig merge',
      'command teamrig merge',
      'builtin teamrig merge',
      'exec teamrig merge',
      'nohup teamrig merge',
      'time teamrig merge',
      'nice git commit -m msg',
      'timeout 5 git commit -m msg',
      'xargs teamrig merge',
      'npx teamrig merge',
      'node teamrig merge',
      'bash -c "teamrig merge"',
      "sh -c 'git commit -m msg'",
      'teamrig heavy --session tr-canary --what x -- git push origin t1-canary',
      'teamrig test --session tr-canary -- git commit -m msg',
    ]);
  });
});
