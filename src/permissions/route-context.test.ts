import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigValue } from '../push-guard/invocations.ts';
import { gitContextOf, type GitPorts } from './route-context.ts';

const OWNERS: ReadonlyMap<string, string> = new Map([
  ['T1', 'alpha'],
  ['T2', 'bravo'],
]);

/** Ports where `alpha`'s tab sees the register above and `C:\w\app` has the remote `origin`. */
function portsOf(overrides: Partial<GitPorts> = {}): GitPorts {
  return {
    cwd: 'C:/w/app',
    home: 'C:/u',
    git: { config: (dir, key): ConfigValue => (dir === 'C:\\w\\app' && key === 'remote.origin.url' ? { kind: 'set', value: 'https://example.test/app.git' } : { kind: 'unset' }) },
    caller: async () => 'alpha',
    ownerOf: async (task) => OWNERS.get(task),
    protectedBranches: ['main'],
    ...overrides,
  };
}

describe('gitContextOf', () => {
  it("owns only a task the register names the tab's session as owner of", async () => {
    const context = gitContextOf(portsOf());
    assert.equal(await context.ownsTask('T1'), true);
    assert.equal(await context.ownsTask('T2'), false);
    assert.equal(await context.ownsTask('T3'), false);
  });

  it('owns nothing for a tab bound to no session, and then never reads the register', async () => {
    const ownerOf = mock.fn(async (task: string) => OWNERS.get(task));
    const context = gitContextOf(portsOf({ caller: async () => undefined, ownerOf }));
    assert.equal(await context.ownsTask('T1'), false);
    assert.equal(ownerOf.mock.callCount(), 0);
  });

  it('owns nothing when the roster or the register cannot be read', async () => {
    const broken = async (): Promise<never> => {
      throw new Error('locked');
    };
    assert.equal(await gitContextOf(portsOf({ caller: broken })).ownsTask('T1'), false);
    assert.equal(await gitContextOf(portsOf({ ownerOf: broken })).ownsTask('T1'), false);
  });

  it("asks git for the remote's URL in the folder the -C folders lead to, from the call's folder", async () => {
    const config = mock.fn((_dir: string, _key: string): ConfigValue => ({ kind: 'set', value: 'u' }));
    const context = gitContextOf(portsOf({ git: { config } }));
    for (const folders of [[], ['sub'], ['C:/x', '../y'], ['/d/z'], ['~/r']]) {
      assert.equal(await context.isRemote(folders, 'origin'), true);
    }
    assert.deepEqual(
      config.mock.calls.map((call) => call.arguments),
      [
        ['C:\\w\\app', 'remote.origin.url'],
        ['C:\\w\\app\\sub', 'remote.origin.url'],
        ['C:\\y', 'remote.origin.url'],
        ['D:\\z', 'remote.origin.url'],
        ['C:\\u\\r', 'remote.origin.url'],
      ],
    );
  });

  it('takes no remote git does not have set, or cannot read', async () => {
    assert.equal(await gitContextOf(portsOf()).isRemote([], 'origin'), true);
    assert.equal(await gitContextOf(portsOf()).isRemote([], 'upstream'), false);
    assert.equal(await gitContextOf(portsOf()).isRemote(['other'], 'origin'), false);
    assert.equal(await gitContextOf(portsOf({ git: { config: () => ({ kind: 'unreadable' }) } })).isRemote([], 'origin'), false);
  });

  it('keeps the protected branches it is given', () => {
    assert.deepEqual(gitContextOf(portsOf({ protectedBranches: ['main', 'release'] })).protectedBranches, ['main', 'release']);
  });
});
