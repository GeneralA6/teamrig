import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSource } from '../composition/host-ports.ts';
import { isUnsupported, type HostPorts } from '../ports/host/index.ts';
import { bareHost } from '../testing/bare-host.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { contextSourceIfTold, hostOf, transcriptsIfKept, transcriptsOf, usageIfMetered, usageOf } from './host.ts';
import { RefusedError } from './runtime.ts';

/** One bare host, kept so a case can tell the very ports it handed in from a copy. */
const BARE: HostPorts = bareHost();
const bare: HostSource = () => BARE;
const OUTPUT_ONLY = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 2 };

describe('hostOf', () => {
  it('builds the ports from the environment and platform of the run it is asked for', () => {
    const seen: Parameters<HostSource>[0][] = [];
    const host: HostSource = (given) => {
      seen.push(given);
      return BARE;
    };
    assert.equal(hostOf({ host, env: { RUN: 'one' }, platform: 'win32' }), BARE);
    assert.deepEqual(seen, [{ env: { RUN: 'one' }, platform: 'win32' }]);
  });

  it('gives a spec in the quiet world the shipped host, its transcript reader and usage meter filled', () => {
    const world = quietWorld();
    const { transcripts, usage } = hostOf({ host: world.host, env: {}, platform: world.platform });
    assert.equal(isUnsupported(transcripts), false);
    assert.deepEqual(!isUnsupported(transcripts) && transcripts.entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
    assert.equal(isUnsupported(usage), false);
  });
});

describe('transcriptsIfKept', () => {
  it('gives the reader of a host that has one, and nothing for a host that keeps no transcript', () => {
    const world = quietWorld();
    assert.deepEqual(transcriptsIfKept({ host: world.host, env: {}, platform: world.platform })?.entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
    assert.equal(transcriptsIfKept({ host: bare, env: {}, platform: 'linux' }), undefined);
  });
});

describe('transcriptsOf', () => {
  it('gives the reader of a host that has one', () => {
    const world = quietWorld();
    assert.deepEqual(transcriptsOf({ host: world.host, env: {}, platform: world.platform }).entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
  });

  it('refuses with the reason of a host that keeps no transcript', () => {
    assert.throws(
      () => transcriptsOf({ host: bare, env: {}, platform: 'linux' }),
      (error) => error instanceof RefusedError && error.message === 'no transcript is kept',
    );
  });
});

describe('usageIfMetered', () => {
  it('gives the meter of a host that has one, and nothing for a host whose calls cannot be priced', () => {
    const world = quietWorld();
    const meter = usageIfMetered({ host: world.host, env: {}, platform: world.platform });
    assert.equal(meter?.ofCall(OUTPUT_ONLY), 2 * (meter?.weights.output ?? Number.NaN));
    assert.equal(usageIfMetered({ host: bare, env: {}, platform: 'linux' }), undefined);
  });
});

describe('contextSourceIfTold', () => {
  it('gives the reader and the meter of a host that has both', () => {
    const world = quietWorld();
    const source = contextSourceIfTold({ host: world.host, env: {}, platform: world.platform });
    assert.deepEqual(source?.reader.entry('not a transcript line'), { kind: 'unread', reason: 'damaged' });
    assert.equal(source?.usage.contextReading({ ...OUTPUT_ONLY, input: 3, cacheRead: 4 }), 7);
  });

  it('gives nothing for a host lacking the reader or the meter', () => {
    const shipped = hostOf({ host: quietWorld().host, env: {}, platform: 'linux' });
    const noMeter: HostSource = () => ({ ...shipped, usage: BARE.usage });
    const noReader: HostSource = () => ({ ...shipped, transcripts: BARE.transcripts });
    assert.equal(contextSourceIfTold({ host: noMeter, env: {}, platform: 'linux' }), undefined);
    assert.equal(contextSourceIfTold({ host: noReader, env: {}, platform: 'linux' }), undefined);
  });
});

describe('usageOf', () => {
  it('gives the meter of a host that has one', () => {
    const world = quietWorld();
    const meter = usageOf({ host: world.host, env: {}, platform: world.platform });
    assert.equal(meter.ofCall(OUTPUT_ONLY), 2 * meter.weights.output);
  });

  it('refuses with the reason of a host whose calls cannot be priced', () => {
    assert.throws(
      () => usageOf({ host: bare, env: {}, platform: 'linux' }),
      (error) => error instanceof RefusedError && error.message === 'no call is priced',
    );
  });
});
