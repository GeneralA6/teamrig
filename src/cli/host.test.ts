import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSource } from '../composition/host-ports.ts';
import { isUnsupported, type HostPorts } from '../ports/host/index.ts';
import { bareHost } from '../testing/bare-host.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { join } from 'node:path';
import { contextSourceIfTold, hooksOf, hostHomeIfKnown, hostHomeOf, hostOf, pathsIfKnown, transcriptsIfKept, transcriptsOf, usageIfMetered, usageOf } from './host.ts';
import { RefusedError } from './runtime.ts';

/** One bare host, kept so a case can tell the very ports it handed in from a copy. */
const BARE: HostPorts = bareHost();
const bare: HostSource = () => BARE;
const OUTPUT_ONLY = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 2 };
const USER_HOME = join('/', 'people', 'sam');

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

describe('hooksOf', () => {
  it('gives the bridge of the host the run is in', () => {
    const world = quietWorld();
    const hooks = hooksOf({ host: world.host, env: {}, platform: world.platform });
    assert.equal(hooks.parse('{"prompt":"hello"}')?.prompt, 'hello');
  });

  it('refuses with the reason of a host that calls no hook', () => {
    assert.throws(() => hooksOf({ host: bare, env: {}, platform: 'linux' }), (error) => error instanceof RefusedError && error.message === 'no hook is called');
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

describe('pathsIfKnown', () => {
  it('gives the paths of a host that tells them, built from the environment of the run, and nothing for a host that tells none', () => {
    const world = quietWorld();
    const moved = { CLAUDE_CODE_TMPDIR: join('/', 'scratch') };
    assert.equal(pathsIfKnown({ host: world.host, env: moved, platform: world.platform })?.scratchpads(join('/', 'tmp')), join('/', 'scratch', 'claude', '*', '*', 'scratchpad'));
    assert.equal(pathsIfKnown({ host: bare, env: moved, platform: 'linux' }), undefined);
  });
});

describe('hostHomeOf', () => {
  it("gives the host's own folder for the person of the run", () => {
    const world = quietWorld();
    assert.equal(hostHomeOf({ host: world.host, env: {}, platform: world.platform, userHome: USER_HOME }), join(USER_HOME, '.claude'));
    const moved = { CLAUDE_CONFIG_DIR: join('/', 'cfg') };
    assert.equal(hostHomeOf({ host: world.host, env: moved, platform: world.platform, userHome: USER_HOME }), join('/', 'cfg'));
  });

  it('refuses with the reason of a host whose folders are not known', () => {
    assert.throws(
      () => hostHomeOf({ host: bare, env: {}, platform: 'linux', userHome: USER_HOME }),
      (error) => error instanceof RefusedError && error.message === 'no folder of the host is known',
    );
  });
});

describe('hostHomeIfKnown', () => {
  it("gives the host's own folder for the person of the run, and nothing for a host whose folders are not known", () => {
    const world = quietWorld();
    assert.equal(hostHomeIfKnown({ host: world.host, env: {}, platform: world.platform, userHome: USER_HOME }), join(USER_HOME, '.claude'));
    assert.equal(hostHomeIfKnown({ host: bare, env: {}, platform: 'linux', userHome: USER_HOME }), undefined);
  });
});
