import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { CHECK_EVERY_MS, isNewer, noticesOf, parseCheckState, UpdateCheck, type UpdateGit } from './check.ts';

const PLUGINS = '/claude/plugins';
const UPDATES = '/kit/updates';
const CLONE = '/claude/plugins/marketplaces/kit';
const REPO = `${UPDATES}/kit.git`;
const START = Date.parse('2026-11-11T10:00:00Z');

function installed(versions: Readonly<Record<string, string>>): string {
  const plugins = Object.fromEntries(Object.entries(versions).map(([key, version]) => [key, [{ scope: 'user', installPath: `/cache/${version}`, version }]]));
  return JSON.stringify({ version: 2, plugins });
}

const KNOWN = JSON.stringify({
  kit: { source: { source: 'github', repo: 'owner/kit' }, installLocation: CLONE },
  local: { source: { source: 'directory', path: '/work/local' }, installLocation: '/work/local' },
});

const MARKETPLACE = JSON.stringify({ name: 'kit', plugins: [{ name: 'teamrig', source: './plugins/teamrig' }] });
const pluginJson = (version: string): string => JSON.stringify({ name: 'teamrig', version });

/** A git that answers each call from what the remote holds now, and records every call it was asked. */
class FakeGit implements UpdateGit {
  readonly calls: string[] = [];
  sha = 'aaa111';
  version = '0.333.0';
  online = true;
  /** Runs inside `ls-remote`, while the check is asking the network. */
  duringAsk: (() => Promise<void>) | undefined;
  private readonly files: MemoryFiles;

  constructor(files: MemoryFiles) {
    this.files = files;
  }

  async run(cwd: string, args: readonly string[]): Promise<string | undefined> {
    const where = cwd.replace(/\\/g, '/');
    this.calls.push(`${where}: ${args.join(' ')}`);
    const [command] = args;
    if (command === 'remote') {
      return where === CLONE ? 'https://example.test/owner/kit.git\n' : undefined;
    }
    if (command === 'init') {
      await this.files.write(`${where}/HEAD`, 'ref: refs/heads/main\n');
      return '';
    }
    if (command === 'config' || command === 'gc') {
      return '';
    }
    if (command === 'ls-remote') {
      await this.duringAsk?.();
      return this.online ? `${this.sha}\tHEAD\n` : undefined;
    }
    if (command === 'fetch') {
      return this.online ? '' : undefined;
    }
    if (command === 'show') {
      const path = args[1]?.replace(/^FETCH_HEAD:/, '');
      if (path === '.claude-plugin/marketplace.json') {
        return MARKETPLACE;
      }
      return path === 'plugins/teamrig/.claude-plugin/plugin.json' ? pluginJson(this.version) : undefined;
    }
    return undefined;
  }

  /** The calls of one git command, for counting. */
  of(command: string): string[] {
    return this.calls.filter((call) => call.split(': ')[1]?.startsWith(command));
  }
}

function setup(versions: Readonly<Record<string, string>> = { 'teamrig@kit': '0.332.0' }, extra: Readonly<Record<string, string>> = {}) {
  const clock = new FakeClock(START);
  const files = new MemoryFiles({ [`${PLUGINS}/installed_plugins.json`]: installed(versions), [`${PLUGINS}/known_marketplaces.json`]: KNOWN, ...extra }, clock);
  const git = new FakeGit(files);
  const check = (): UpdateCheck => new UpdateCheck({ files, git, paths: { pluginsFolder: PLUGINS, updatesFolder: UPDATES }, now: () => clock.now() });
  return { clock, files, git, check };
}

const NOTICE = { plugin: 'teamrig', marketplace: 'kit', installed: '0.332.0', newest: '0.333.0' };

describe('UpdateCheck.notices, a cloned marketplace', () => {
  it('asks the remote through its own bare repository and tells of the newer version', async () => {
    const { git, files, check } = setup();
    assert.deepEqual(await check().notices(), [NOTICE]);
    assert.deepEqual(git.calls, [
      `${CLONE}: remote get-url origin`,
      `${REPO}: init --bare --quiet`,
      `${REPO}: config remote.origin.url https://example.test/owner/kit.git`,
      `${REPO}: config remote.origin.promisor true`,
      `${REPO}: config remote.origin.partialclonefilter blob:none`,
      `${REPO}: ls-remote origin HEAD`,
      `${REPO}: fetch -q --depth 1 --filter=blob:none --no-tags origin HEAD`,
      `${REPO}: show FETCH_HEAD:.claude-plugin/marketplace.json`,
      `${REPO}: show FETCH_HEAD:plugins/teamrig/.claude-plugin/plugin.json`,
      `${REPO}: gc --prune=now --quiet`,
    ]);
    assert.deepEqual(parseCheckState(files.get(`${UPDATES}/check.json`)), {
      checkedAt: START,
      published: { kit: { sha: 'aaa111', versions: { teamrig: '0.333.0' } } },
      dismissed: {},
    });
  });

  it('tells nothing when the published version is the installed one', async () => {
    const { git, check } = setup();
    git.version = '0.332.0';
    assert.deepEqual(await check().notices(), []);
  });

  it('reads the kept answer without asking the network inside CHECK_EVERY_MS', async () => {
    const { git, clock, check } = setup();
    await check().notices();
    const asked = git.calls.length;
    clock.advance(CHECK_EVERY_MS - 1);
    assert.deepEqual(await check().notices(), [NOTICE]);
    assert.equal(git.calls.length, asked);
  });

  it('after CHECK_EVERY_MS asks for the newest commit, and fetches nothing when it is the one seen', async () => {
    const { git, clock, check } = setup();
    await check().notices();
    clock.advance(CHECK_EVERY_MS);
    assert.deepEqual(await check().notices(), [NOTICE]);
    assert.equal(git.of('ls-remote').length, 2);
    assert.equal(git.of('fetch').length, 1);
    assert.equal(git.of('init').length, 1, 'the bare repository is made once');
  });

  it('fetches again when the remote has a new commit', async () => {
    const { git, clock, check } = setup();
    await check().notices();
    git.sha = 'bbb222';
    git.version = '0.334.0';
    clock.advance(CHECK_EVERY_MS);
    assert.deepEqual(await check().notices(), [{ ...NOTICE, newest: '0.334.0' }]);
    assert.equal(git.of('fetch').length, 2);
  });

  it('keeps what was known when the remote cannot be asked, and waits CHECK_EVERY_MS before asking again', async () => {
    const { git, clock, files, check } = setup();
    await check().notices();
    git.online = false;
    clock.advance(CHECK_EVERY_MS);
    assert.deepEqual(await check().notices(), [NOTICE]);
    assert.equal(parseCheckState(files.get(`${UPDATES}/check.json`)).checkedAt, START + CHECK_EVERY_MS);
    const asked = git.calls.length;
    clock.advance(60_000);
    await check().notices();
    assert.equal(git.calls.length, asked);
  });

  it('tells nothing when the first check finds the remote offline', async () => {
    const { git, check } = setup();
    git.online = false;
    assert.deepEqual(await check().notices(), []);
    assert.equal(git.of('fetch').length, 0);
  });

  it('asks again when the kept check is dated ahead of the clock', async () => {
    const { git, clock, check } = setup();
    await check().notices();
    clock.advance(-60_000);
    await check().notices();
    assert.equal(git.of('ls-remote').length, 2);
  });

  it('claims the check before asking, so a tab that looks meanwhile asks nothing', async () => {
    const { git, check } = setup();
    let seenByOther: readonly unknown[] | undefined;
    let callsBefore = 0;
    git.duringAsk = async () => {
      git.duringAsk = undefined;
      callsBefore = git.calls.length;
      seenByOther = await check().notices();
    };
    await check().notices();
    assert.deepEqual(seenByOther, []);
    assert.equal(git.calls.length > callsBefore, true);
    assert.equal(git.of('ls-remote').length, 1);
  });

  it('keeps a dismissal another tab saved while this one asked', async () => {
    const { git, files, check } = setup();
    git.duringAsk = async () => {
      git.duringAsk = undefined;
      await check().dismiss('teamrig-pane', '0.9.0');
    };
    await check().notices();
    assert.deepEqual(parseCheckState(files.get(`${UPDATES}/check.json`)).dismissed, { 'teamrig-pane': '0.9.0' });
  });

  it('asks nothing when no tracked plugin is installed', async () => {
    const { git, check } = setup({ 'other@kit': '1.0.0' });
    assert.deepEqual(await check().notices(), []);
    assert.deepEqual(git.calls, []);
  });

  it('asks nothing for a marketplace the marketplace list does not name', async () => {
    const { git, check } = setup({ 'teamrig@gone': '0.332.0' });
    assert.deepEqual(await check().notices(), []);
    assert.deepEqual(git.calls, []);
  });
});

describe('UpdateCheck.notices, a directory marketplace', () => {
  it('reads the versions in place, with no git', async () => {
    const { git, check } = setup({ 'teamrig@local': '0.332.0' }, {
      '/work/local/.claude-plugin/marketplace.json': MARKETPLACE,
      '/work/local/plugins/teamrig/.claude-plugin/plugin.json': pluginJson('0.340.0'),
    });
    assert.deepEqual(await check().notices(), [{ plugin: 'teamrig', marketplace: 'local', installed: '0.332.0', newest: '0.340.0' }]);
    assert.deepEqual(git.calls, []);
  });

  it('tells nothing when the folder holds no marketplace file', async () => {
    const { check } = setup({ 'teamrig@local': '0.332.0' });
    assert.deepEqual(await check().notices(), []);
  });
});

describe('UpdateCheck.dismiss', () => {
  it('hides the dismissed version until a newer one is published', async () => {
    const { git, clock, check } = setup();
    await check().notices();
    await check().dismiss('teamrig', '0.333.0');
    assert.deepEqual(await check().notices(), []);
    git.sha = 'ccc333';
    git.version = '0.334.0';
    clock.advance(CHECK_EVERY_MS);
    assert.deepEqual(await check().notices(), [{ ...NOTICE, newest: '0.334.0' }]);
  });
});

describe('parseCheckState', () => {
  it('reads a missing file, bad JSON and another shape as nothing known', () => {
    const empty = { checkedAt: undefined, published: {}, dismissed: {} };
    assert.deepEqual(parseCheckState(undefined), empty);
    assert.deepEqual(parseCheckState('not json'), empty);
    assert.deepEqual(parseCheckState('[]'), empty);
  });

  it('drops fields and entries of another shape', () => {
    const text = JSON.stringify({
      checkedAt: 'soon',
      published: { kit: { sha: 'a', versions: { teamrig: '1.0.0', bad: 3 } }, broken: { versions: {} } },
      dismissed: { teamrig: '1.0.0', other: false },
    });
    assert.deepEqual(parseCheckState(text), {
      checkedAt: undefined,
      published: { kit: { sha: 'a', versions: { teamrig: '1.0.0' } } },
      dismissed: { teamrig: '1.0.0' },
    });
  });
});

describe('isNewer and noticesOf', () => {
  it('compares release versions, and calls anything else not newer', () => {
    assert.equal(isNewer('0.333.0', '0.332.9'), true);
    assert.equal(isNewer('0.332.0', '0.332.0'), false);
    assert.equal(isNewer('main', '0.1.0'), false);
  });

  it('leaves out an install whose marketplace published nothing for it', () => {
    const state = { checkedAt: START, published: { kit: { sha: 'a', versions: {} } }, dismissed: {} };
    assert.deepEqual(noticesOf([{ plugin: 'teamrig', marketplace: 'kit', version: '0.1.0' }], state), []);
  });
});
