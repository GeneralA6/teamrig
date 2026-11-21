import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSource } from '../composition/host-ports.ts';
import { isUnsupported, type HostPorts } from '../ports/host/index.ts';
import type { SecretGuardConfig } from '../config/types.ts';
import { DEFAULT_SECRET_PATHS } from '../secret-guard/paths.ts';
import { secretRulesOf } from '../secret-guard/rules.ts';
import { bareHost } from '../testing/bare-host.ts';
import { HOOKS_ONLY_HOST, NO_PATHS_HOST, SHIPPED_HOST, testPaths } from '../testing/host.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { join } from 'node:path';
import { contextSourceIfTold, hooksOf, hostHomeIfKnown, hostHomeOf, hostOf, pathsIfKnown, pathsOf, secretFilesOf, transcriptsIfKept, transcriptsOf, usageIfMetered, usageOf } from './host.ts';
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

describe('pathsOf', () => {
  it('gives the paths of a host that tells them, built from the environment of the run', () => {
    const world = quietWorld();
    const moved = { CLAUDE_CONFIG_DIR: join('/', 'cfg') };
    assert.equal(pathsOf({ host: world.host, env: moved, platform: world.platform }).userSettings(USER_HOME), join('/', 'cfg', 'settings.json'));
  });

  it('refuses with the reason of a host whose folders are not known', () => {
    assert.throws(
      () => pathsOf({ host: bare, env: {}, platform: 'linux' }),
      (error) => error instanceof RefusedError && error.message === 'no folder of the host is known',
    );
  });
});

/** The secret files the shipped host adapters name: the lines the guard's defaults held before the hosts told their own. */
const SHIPPED_SECRET_FILES = ['~/.claude/.credentials.json', '~/.claude/history.jsonl', '**/.claude/settings.local.json'];

/**
 * The guard's default globs as they stood when it named the hosts' files itself, copied and not computed: under any
 * host the defaults with the hosts' files must still hold every one of them.
 */
const DEFAULTS_BEFORE_THE_PORT = [
  '**/.env',
  '**/.env.*',
  '!**/.env.example',
  '!**/.env.sample',
  '~/.npmrc',
  '~/.ssh/**',
  '!~/.ssh/*.pub',
  '~/.aws/credentials',
  '**/.kube/config',
  '~/.docker/config.json',
  '**/.git-credentials',
  '~/.config/gh/hosts.yml',
  '~/AppData/Roaming/GitHub CLI/hosts.yml',
  '~/.claude/.credentials.json',
  '~/.claude/history.jsonl',
  '**/.claude/settings.local.json',
  '~/.bash_history',
  '~/.zsh_history',
  '**/PSReadLine/*_history.txt',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/*.tfstate',
  '**/*.tfstate.backup',
];

/** A host that names secret files of its own, one of them a shipped host's too. */
const OWN_FILES_HOST: HostSource = () => ({ ...BARE, paths: { ...testPaths(), secretFiles: () => ['~/.agent/login.json', '~/.claude/history.jsonl'] } });

/** The hosts a run may work in: the shipped one, ones telling none of their folders, and one naming files of its own. */
const RUNNING_HOSTS: readonly (readonly [string, HostSource])[] = [
  ['the shipped host', SHIPPED_HOST],
  ['a host with no port filled', bare],
  ['the shipped host telling no folder', NO_PATHS_HOST],
  ['a host with hooks only', HOOKS_ONLY_HOST],
  ['a host naming its own files', OWN_FILES_HOST],
];

describe('secretFilesOf', () => {
  it('gives the secret guard the files of every shipped host, whatever host the run works in', () => {
    const { shippedHosts, platform } = quietWorld();
    for (const [name, host] of RUNNING_HOSTS.slice(0, 4)) {
      assert.deepEqual(secretFilesOf({ host, shippedHosts, env: {}, platform }).secretFiles(), SHIPPED_SECRET_FILES, name);
    }
  });

  it('adds the files the running host names after the shipped ones, each glob once', () => {
    const { shippedHosts, platform } = quietWorld();
    assert.deepEqual(secretFilesOf({ host: OWN_FILES_HOST, shippedHosts, env: {}, platform }).secretFiles(), [...SHIPPED_SECRET_FILES, '~/.agent/login.json']);
    assert.deepEqual(secretFilesOf({ host: OWN_FILES_HOST, shippedHosts: [], env: {}, platform }).secretFiles(), ['~/.agent/login.json', '~/.claude/history.jsonl']);
    assert.deepEqual(secretFilesOf({ host: bare, shippedHosts: [bare, NO_PATHS_HOST], env: {}, platform }).secretFiles(), []);
  });

  it("gives the files a shipped host keeps in a folder the run's environment moves, under a host telling none of its folders too", () => {
    const { shippedHosts } = quietWorld();
    const env = { CLAUDE_CONFIG_DIR: '/cfg' };
    for (const [name, host] of RUNNING_HOSTS.slice(0, 4)) {
      assert.deepEqual(secretFilesOf({ host, shippedHosts, env, platform: 'linux' }).secretFiles(), [...SHIPPED_SECRET_FILES, '/cfg/.credentials.json', '/cfg/history.jsonl'], name);
    }
  });

  it('builds each host from the environment and platform of the run', () => {
    const seen: Parameters<HostSource>[0][] = [];
    const watching: HostSource = (given) => {
      seen.push(given);
      return BARE;
    };
    secretFilesOf({ host: watching, shippedHosts: [watching], env: { RUN: 'one' }, platform: 'darwin' });
    assert.deepEqual(seen, [
      { env: { RUN: 'one' }, platform: 'darwin' },
      { env: { RUN: 'one' }, platform: 'darwin' },
    ]);
  });

  it('keeps every default the guard had before the hosts told their own files, under each host', () => {
    const { shippedHosts, platform } = quietWorld();
    const config: SecretGuardConfig = { secretReads: 'deny', writes: 'deny', paths: [], envNames: [], commands: [], redact: true };
    for (const [name, host] of RUNNING_HOSTS) {
      const files = secretFilesOf({ host, shippedHosts, env: {}, platform });
      const globs = new Set([...DEFAULT_SECRET_PATHS, ...files.secretFiles()]);
      assert.deepEqual(DEFAULTS_BEFORE_THE_PORT.filter((glob) => !globs.has(glob)), [], name);
      const { paths } = secretRulesOf(config, '/u', 'linux', files);
      for (const path of ['/u/.claude/.credentials.json', '/u/.claude/history.jsonl', '/r/.claude/settings.local.json', '/r/.env', '/u/.ssh/id_ed25519']) {
        assert.equal(paths.listed(path), true, `${name}: ${path}`);
      }
    }
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
