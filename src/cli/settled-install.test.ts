import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakePluginStore } from '../testing/fake-plugin-store.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { installStateOf, REOPEN_SETTLE_MS, settleWaitText, type InstallState } from './settled-install.ts';

const HOME = join('/', 'u');
const PLUGINS = join(HOME, '.claude', 'plugins');
const LIST = join(PLUGINS, 'installed_plugins.json');
const KIT = join(PLUGINS, 'cache', 'teamrig', 'teamrig', '0.167.0');
const PANE = join(PLUGINS, 'cache', 'teamrig', 'teamrig-pane', '0.9.0');
const PROJECT = join('/', 'work', 'app');
const HOUR_MS = 3_600_000;

const USER_KIT: JsonRecord = { scope: 'user', installPath: KIT, version: '0.167.0', gitCommitSha: 'abc1234' };
const USER_PANE: JsonRecord = { scope: 'user', installPath: PANE, version: '0.9.0', gitCommitSha: 'def5678' };
const ELSEWHERE_PATH = join(PLUGINS, 'cache', 'teamrig', 'teamrig', '0.160.0');
/** teamrig installed for another project only, its folder missing every file. */
const ELSEWHERE: JsonRecord = { scope: 'project', projectPath: join('/', 'work', 'other'), installPath: ELSEWHERE_PATH, version: '0.160.0' };

function listOf(plugins: Readonly<Record<string, readonly JsonRecord[]>>): string {
  return JSON.stringify({ version: 2, plugins });
}

interface Store {
  readonly files: MemoryFiles;
  readonly pluginStore: FakePluginStore;
  readonly clock: FakeClock;
  env: Env;
}

/**
 * A plugin store holding the plugin list `list` and a whole teamrig install at KIT (its hooks file naming one mod
 * module, the module and the CLI), every part of it last changed an hour ago.
 */
async function storeOf(list: string = listOf({ 'teamrig@teamrig': [USER_KIT], 'teamrig-pane@teamrig': [USER_PANE], 'teamrig@other': [ELSEWHERE] })): Promise<Store> {
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const files = new MemoryFiles();
  await files.write(LIST, list);
  await files.write(join(KIT, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'], hooks: {} }));
  await files.write(join(KIT, 'hooks', 'register.ts'), '');
  await files.write(join(KIT, 'dist', 'cli', 'main.js'), '');
  const hourAgo = clock.now() - HOUR_MS;
  const pluginStore = new FakePluginStore().date(LIST, hourAgo).date(join(PLUGINS, 'cache', 'teamrig', 'teamrig'), hourAgo).date(KIT, hourAgo).date(PANE, hourAgo);
  return { files, pluginStore, clock, env: {} };
}

async function stateOf(store: Store): Promise<InstallState> {
  return installStateOf({ ...store, userHome: HOME }, PROJECT);
}

function unsettled(why: string): InstallState {
  return { kind: 'unsettled', why };
}

describe('installStateOf', () => {
  it('settles a whole teamrig install whose store stood still for 30 s', async () => {
    assert.deepEqual(await stateOf(await storeOf()), { kind: 'settled' });
  });

  it('settles with no plugin list: a plugin run from a folder has no store to wait for', async () => {
    const store = await storeOf();
    await store.files.remove(LIST);
    assert.deepEqual(await stateOf(store), { kind: 'settled' });
  });

  it('holds while any part of the store an install writes changed under 30 s ago, saying how long ago', async () => {
    const store = await storeOf();
    const now = store.clock.now();
    store.pluginStore.date(LIST, now - 10_000);
    assert.deepEqual(await stateOf(store), unsettled('the plugin store changed 10 s ago, under 30 s: an install may still be copying'));
    store.pluginStore.date(LIST, now - REOPEN_SETTLE_MS + 1);
    assert.deepEqual(await stateOf(store), unsettled('the plugin store changed 29 s ago, under 30 s: an install may still be copying'));
    store.pluginStore.date(LIST, now - REOPEN_SETTLE_MS);
    assert.deepEqual(await stateOf(store), { kind: 'settled' }, '30 s still is settled');

    // teamrig-pane's files are not checked, but a copy into its folders holds the reopen as teamrig's does.
    const deep = join(PANE, 'dist', 'mod');
    store.pluginStore.fill(PANE, [join(PANE, 'dist')]).fill(join(PANE, 'dist'), [deep]).date(deep, now - 2_000);
    assert.deepEqual(await stateOf(store), unsettled('the plugin store changed 2 s ago, under 30 s: an install may still be copying'));
  });

  it('holds a teamrig install that lacks its hooks file, a mod module it names or the CLI, naming what it lacks', async () => {
    const lacking = async (change: (store: Store) => Promise<unknown>): Promise<InstallState> => {
      const store = await storeOf();
      await change(store);
      return stateOf(store);
    };
    const hooks = join(KIT, 'hooks', 'hooks.json');
    assert.deepEqual(await lacking((store) => store.files.remove(hooks)), unsettled('teamrig 0.167.0 lacks hooks/hooks.json'));
    const unreadable = unsettled('teamrig 0.167.0 lacks a hooks/hooks.json that reads as a hooks file');
    assert.deepEqual(await lacking((store) => store.files.write(hooks, '{"hooks": ')), unreadable);
    assert.deepEqual(await lacking((store) => store.files.write(hooks, JSON.stringify({ modules: [3] }))), unreadable);
    assert.deepEqual(await lacking((store) => store.files.remove(join(KIT, 'hooks', 'register.ts'))), unsettled('teamrig 0.167.0 lacks hooks/register.ts'));
    assert.deepEqual(await lacking((store) => store.files.remove(join(KIT, 'dist', 'cli', 'main.js'))), unsettled('teamrig 0.167.0 lacks dist/cli/main.js'));
    assert.deepEqual(await lacking((store) => store.files.write(hooks, JSON.stringify({ hooks: {} }))), { kind: 'settled' }, 'a hooks file may name no module');
  });

  it('holds on a plugin list that does not read as Claude Code\'s, and leaves out an install for another project', async () => {
    assert.deepEqual(await stateOf(await storeOf('{"plugins": ')), unsettled("installed_plugins.json does not read as Claude Code's plugin list"));

    const elsewhere = await storeOf();
    elsewhere.pluginStore.date(ELSEWHERE_PATH, elsewhere.clock.now());
    assert.deepEqual(await stateOf(elsewhere), { kind: 'settled' }, 'neither its files nor its folders count');
  });

  it("reads the store in the folder CLAUDE_CONFIG_DIR names", async () => {
    const store = await storeOf();
    store.env = { CLAUDE_CONFIG_DIR: join('/', 'config') };
    await store.files.write(join('/', 'config', 'plugins', 'installed_plugins.json'), '{"plugins": ');
    assert.deepEqual(await stateOf(store), unsettled("installed_plugins.json does not read as Claude Code's plugin list"));
  });

  it('says a held reopen waits for a settled install', () => {
    assert.equal(settleWaitText('teamrig 0.167.0 lacks dist/cli/main.js'), 'teamrig 0.167.0 lacks dist/cli/main.js, so the reopen waits for a settled install');
  });
});
