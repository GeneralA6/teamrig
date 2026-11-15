import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_TABLE } from '../cli/run.ts';
import { roleCallOf, roleScanTextOf, toolRoleCallOf, type RoleCallContext } from './service-role-call.ts';

const SHIP_TOOL = '/repo/.ship/tools/ship/ship.ts';
const CONTEXT: RoleCallContext = { cli: COMMAND_TABLE, ownClient: async (word) => word === 'teamrig', repos: ['acme/web'], isShipTool: (word) => word === SHIP_TOOL };

describe('service-role call: the mask', () => {
  it('masks a literal double-quoted text and an issue target, and nothing else', () => {
    assert.equal(roleScanTextOf('teamrig issue close acme/web#7 --comment "fixed; see #8 & <this>"'), 'teamrig issue close acme/web_7 --comment "t"');
    assert.equal(roleScanTextOf('echo x#1 a/b#c #9'), 'echo x#1 a/b#c #9');
  });

  it('gives up on a quote or backslash it cannot place, and on a text bash would expand', () => {
    for (const line of [
      "teamrig issue close acme/web#7 --comment 'done'",
      'teamrig issue close acme/web#7 --comment \\"a;b\\"',
      'teamrig issue close acme/web#7 --comment "never closed',
      'teamrig issue close acme/web#7 --comment "$(id)"',
      'teamrig issue close acme/web#7 --comment "a `id` b"',
      'teamrig issue close acme/web#7 --comment "two\nlines"',
    ]) {
      assert.equal(roleScanTextOf(line), undefined, line);
    }
  });
});

describe('service-role call: the shapes', () => {
  it('reads issue close and issue comment on a team repository, with the session the line names', async () => {
    assert.deepEqual(await roleCallOf('teamrig issue close acme/web#7 --session gh', CONTEXT), { command: 'issue close', target: 'acme/web#7', session: 'gh' });
    assert.deepEqual(await roleCallOf('teamrig issue close Acme/Web#7 --comment "Fixed in #8; thanks!" --session gh', CONTEXT), {
      command: 'issue close',
      target: 'acme/web#7',
      session: 'gh',
    });
    assert.deepEqual(await roleCallOf('teamrig issue comment acme/web#12 --session gh --body "Looking at it" 2>&1', CONTEXT), { command: 'issue comment', target: 'acme/web#12', session: 'gh' });
  });

  it('reads no call off the table, off the repositories, through another program or joined to another command', async () => {
    for (const line of [
      'teamrig issue sync --repo acme/web',
      'teamrig issue close other/web#7',
      'teamrig issue close acme/web',
      'teamrig issue close acme/web#7 acme/web#8',
      'teamrig issue comment acme/web#7 --comment "x"',
      'teamrig issue close acme/web#7 --help',
      'teamrig issue close acme/web#7 -- x',
      './teamrig issue close acme/web#7',
      'node main.js issue close acme/web#7',
      'teamrig issue close acme/web#7; rm -rf x',
      'teamrig issue close acme/web#7 --comment "x" && rm -rf x',
      'teamrig issue close acme/web#7 --comment "x" | tee y',
      'teamrig issue close acme/web#7 --comment "x" > y',
      'teamrig issue close acme/web#7 --comment $TEXT',
      'teamrig issue close acme/web#7 --comment "x"y"z" #',
      'X=1 teamrig issue close acme/web#7',
      'teamrig issue close acme/web#7 --comment "a"$(id)',
    ]) {
      assert.equal(await roleCallOf(line, CONTEXT), undefined, line);
    }
  });

  it('reads no call naming no --session, whatever the environment says (T2984)', async () => {
    assert.equal(await roleCallOf('teamrig issue close acme/web#7 --comment "done"', CONTEXT), undefined);
    assert.equal(await roleCallOf('teamrig issue comment acme/web#7 --body "x"', CONTEXT), undefined);
  });

  it('reads no call posting a format or bidi character, a line separator or an @-mention (T2984)', async () => {
    for (const text of ['a\u202Eb', 'zero\u200Bwidth', 'iso\u2066late\u2069', 'line\u2028break', 'cc @bob', '@acme/team look', '(@bob)', 'hi\u00ADdden']) {
      for (const flag of ['--comment', '--body']) {
        const command = flag === '--comment' ? 'close' : 'comment';
        const line = `teamrig issue ${command} acme/web#7 ${flag} "${text}" --session gh`;
        assert.equal(await roleCallOf(line, CONTEXT), undefined, JSON.stringify(line));
      }
    }
    assert.equal(await roleCallOf('teamrig issue close acme/web#7 --comment @bob --session gh', CONTEXT), undefined, 'a bare word');
    for (const text of [`mail ${['ops', 'acme.dev'].join('@')}`, 'see a@b', 'déjà vu, 日本', 'x @ y']) {
      assert.deepEqual(await roleCallOf(`teamrig issue comment acme/web#7 --body "${text}" --session gh`, CONTEXT), { command: 'issue comment', target: 'acme/web#7', session: 'gh' }, text);
    }
  });

  it('reads a Bash call alone, as each text its shell may run', async () => {
    const line = 'teamrig issue close acme/web#7 --comment "done" --session gh';
    assert.deepEqual(await toolRoleCallOf('Bash', line, 'win32', CONTEXT), { command: 'issue close', target: 'acme/web#7', session: 'gh' });
    assert.equal(await toolRoleCallOf('PowerShell', line, 'win32', CONTEXT), undefined);
    assert.equal(await toolRoleCallOf(undefined, line, 'linux', CONTEXT), undefined);
    assert.equal(await toolRoleCallOf('Bash', 'teamrig issue close acme/web#7 --comment "a\\\\b"', 'win32', CONTEXT), undefined, 'a line with two readings');
  });
});

describe('service-role call: a queued ship or merge (T2984)', () => {
  const ship = `teamrig queue --kind ship --what "ship T1: the CLI" --task T1 --detach --max-minutes 45 --session alpha -- node ${SHIP_TOOL} /w/t1-cli /t/T1/plan.json`;

  it('reads a ship and a merge of the team ship tool, with the worktree as its target and the session the line names', async () => {
    assert.deepEqual(await roleCallOf(ship, CONTEXT), {
      command: 'queue ship',
      target: '/w/t1-cli',
      session: 'alpha',
      ship: { tool: SHIP_TOOL, worktree: '/w/t1-cli', files: ['/t/T1/plan.json'], task: 'T1', merges: false },
    });
    const merge = await toolRoleCallOf('Bash', `${ship} --merge --approved 0123abc --note-file /t/T1/pr.md`, 'win32', CONTEXT);
    assert.deepEqual(merge?.command, 'queue merge');
    assert.ok(merge !== undefined && 'ship' in merge && merge.ship.merges);
  });

  it('reads no ship of another tool, joined to another command, or naming no --session (N1)', async () => {
    for (const line of [ship.replace(SHIP_TOOL, '/repo/other.ts'), `${ship}; rm -rf x`, ship.replace('--kind ship', '--kind test'), ship.replace(' --session alpha', '')]) {
      assert.equal(await roleCallOf(line, CONTEXT), undefined, line);
    }
  });
});
