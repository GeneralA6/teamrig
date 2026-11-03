import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigValue, GitConfigReader } from './invocations.ts';
import { namedPushTarget, type MapChange, type NamedPushTarget } from './named-push.ts';

const DIR = '/work/app';

/** A config reader over `values`; keys in `unreadable` fail to read. */
function reader(values: Readonly<Record<string, string>>, unreadable: readonly string[] = []) {
  return {
    config: mock.fn((_dir: string, key: string): ConfigValue => {
      if (unreadable.includes(key)) {
        return { kind: 'unreadable' };
      }
      const value = values[key];
      return value === undefined ? { kind: 'unset' } : { kind: 'set', value };
    }),
  } satisfies GitConfigReader;
}

function target(values: Readonly<Record<string, string>>, { unreadable = [], change = 'none', remote = 'origin' }: { readonly unreadable?: readonly string[]; readonly change?: MapChange; readonly remote?: string } = {}): NamedPushTarget {
  return namedPushTarget(reader(values, unreadable), DIR, remote, 't1-x', change);
}

const to = (ref: string): NamedPushTarget => ({ kind: 'to', ref });
const UPSTREAM_MAIN = { 'push.default': 'upstream', 'branch.t1-x.merge': 'refs/heads/main' };

describe('namedPushTarget', () => {
  it('sends the branch to its own name under the default push.default and every same-name one', () => {
    assert.deepEqual(target({}), to('t1-x'));
    for (const value of ['simple', 'current', 'nothing', 'matching']) {
      assert.deepEqual(target({ 'push.default': value, 'branch.t1-x.merge': 'refs/heads/main' }), to('t1-x'), value);
    }
  });

  it("sends the branch to its upstream under push.default upstream, or its old name tracking, in any case", () => {
    assert.deepEqual(target(UPSTREAM_MAIN), to('refs/heads/main'));
    assert.deepEqual(target({ 'push.default': 'tracking', 'branch.t1-x.merge': 'main' }), to('main'));
    assert.deepEqual(target({ 'push.default': ' Upstream ', 'branch.t1-x.merge': 'refs/heads/main' }), to('refs/heads/main'));
    assert.deepEqual(target({ 'push.default': 'upstream' }), to('t1-x'));
  });

  it('reads the config of the push folder and remote', () => {
    const repo = reader({ 'remote.up.push': 'refs/heads/*:refs/heads/main' });
    const found = namedPushTarget(repo, '/work/other', 'up', 't1-x', 'none');
    assert.equal(found.kind, 'doubt');
    assert.deepEqual(repo.config.mock.calls.map((call) => call.arguments), [['/work/other', 'remote.up.push']]);
    assert.deepEqual(target({ 'remote.fork.push': 'refs/heads/t1-x:refs/heads/main' }), to('t1-x'));
  });

  it('doubts a remote.<remote>.push mapping, set or unreadable', () => {
    assert.equal(target({ 'remote.origin.push': 'refs/heads/t1-x:refs/heads/main' }).kind, 'doubt');
    assert.deepEqual(target({}, { unreadable: ['remote.origin.push'] }), {
      kind: 'doubt',
      doubt: 'git cannot read remote.origin.push, which can send a branch named alone to another branch',
    });
  });

  it('doubts a push.default or upstream it cannot read', () => {
    assert.equal(target({}, { unreadable: ['push.default'] }).kind, 'doubt');
    assert.equal(target({ 'push.default': 'upstream' }, { unreadable: ['branch.t1-x.merge'] }).kind, 'doubt');
    assert.deepEqual(target({ 'push.default': 'simple' }, { unreadable: ['branch.t1-x.merge'] }), to('t1-x'));
  });

  it('doubts once an earlier command changed the config, and an upstream only where push.default upstream reads it', () => {
    assert.equal(target({}, { change: 'config' }).kind, 'doubt');
    assert.equal(target(UPSTREAM_MAIN, { change: 'upstream' }).kind, 'doubt');
    assert.deepEqual(target({ 'push.default': 'simple' }, { change: 'upstream' }), to('t1-x'));
  });
});
