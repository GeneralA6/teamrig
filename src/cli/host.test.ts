import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSource } from '../composition/host-ports.ts';
import { isUnsupported, unsupported, type HostPorts } from '../ports/host/index.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { hostOf } from './host.ts';

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
