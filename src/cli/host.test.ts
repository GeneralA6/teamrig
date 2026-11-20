import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSource } from '../composition/host-ports.ts';
import { isUnsupported, unsupported, type HostPorts } from '../ports/host/index.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { hostOf, transcriptsIfKept, transcriptsOf } from './host.ts';
import { RefusedError } from './runtime.ts';

describe('hostOf', () => {
  it('builds the ports from the environment and platform of the run it is asked for', () => {
    const seen: Parameters<HostSource>[0][] = [];
    const ports: HostPorts = { transcripts: unsupported('no transcript is kept') };
    const host: HostSource = (given) => {
      seen.push(given);
      return ports;
    };
    assert.equal(hostOf({ host, env: { RUN: 'one' }, platform: 'win32' }), ports);
    assert.deepEqual(seen, [{ env: { RUN: 'one' }, platform: 'win32' }]);
  });

  it('gives a spec in the quiet world the shipped host, its transcript reader filled', () => {
    const world = quietWorld();
    const { transcripts } = hostOf({ host: world.host, env: {}, platform: world.platform });
    assert.equal(isUnsupported(transcripts), false);
    assert.deepEqual(!isUnsupported(transcripts) && transcripts.entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
  });
});

describe('transcriptsIfKept', () => {
  it('gives the reader of a host that has one, and nothing for a host that keeps no transcript', () => {
    const world = quietWorld();
    assert.deepEqual(transcriptsIfKept({ host: world.host, env: {}, platform: world.platform })?.entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
    const host: HostSource = () => ({ transcripts: unsupported('no transcript is kept') });
    assert.equal(transcriptsIfKept({ host, env: {}, platform: 'linux' }), undefined);
  });
});

describe('transcriptsOf', () => {
  it('gives the reader of a host that has one', () => {
    const world = quietWorld();
    assert.deepEqual(transcriptsOf({ host: world.host, env: {}, platform: world.platform }).entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
  });

  it('refuses with the reason of a host that keeps no transcript', () => {
    const host: HostSource = () => ({ transcripts: unsupported('no transcript is kept') });
    assert.throws(
      () => transcriptsOf({ host, env: {}, platform: 'linux' }),
      (error) => error instanceof RefusedError && error.message === 'no transcript is kept',
    );
  });
});
