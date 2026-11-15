import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_TABLE } from '../cli/run.ts';
import { roleCallOf, roleScanTextOf, toolRoleCallOf, type RoleCallContext } from './service-role-call.ts';

const CONTEXT: RoleCallContext = { cli: COMMAND_TABLE, ownClient: async (word) => word === 'teamrig', repos: ['acme/web'] };

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
    assert.deepEqual(await roleCallOf('teamrig issue close acme/web#7', CONTEXT), { command: 'issue close', target: 'acme/web#7', session: undefined });
    assert.deepEqual(await roleCallOf('teamrig issue close Acme/Web#7 --comment "Fixed in #8; thanks!" --session gh', CONTEXT), {
      command: 'issue close',
      target: 'acme/web#7',
      session: 'gh',
    });
    assert.deepEqual(await roleCallOf('teamrig issue comment acme/web#12 --body "Looking at it" 2>&1', CONTEXT), { command: 'issue comment', target: 'acme/web#12', session: undefined });
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

  it('reads a Bash call alone, as each text its shell may run', async () => {
    const line = 'teamrig issue close acme/web#7 --comment "done"';
    assert.deepEqual(await toolRoleCallOf('Bash', line, 'win32', CONTEXT), { command: 'issue close', target: 'acme/web#7', session: undefined });
    assert.equal(await toolRoleCallOf('PowerShell', line, 'win32', CONTEXT), undefined);
    assert.equal(await toolRoleCallOf(undefined, line, 'linux', CONTEXT), undefined);
    assert.equal(await toolRoleCallOf('Bash', 'teamrig issue close acme/web#7 --comment "a\\\\b"', 'win32', CONTEXT), undefined, 'a line with two readings');
  });
});
