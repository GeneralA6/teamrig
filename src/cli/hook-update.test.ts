import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CliHarness, TEAM, USER_HOME, KIT, type CliResult } from '../testing/cli-harness.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { EXIT } from './runtime.ts';

const PLUGINS = join(USER_HOME, '.claude', 'plugins');
const CHECK_FILE = join(KIT, 'updates', 'check.json');
const LOCAL = '/work/local';
const CLONE = '/claude-clones/kit';
const CLAUDE = ['/bin/claude'];

const MARKETPLACE = JSON.stringify({ name: 'local', plugins: [{ name: 'teamrig', source: './plugins/teamrig' }] });

/** A machine with teamrig 0.332.0 installed from `marketplace`, which publishes `published` in place or as a clone. */
async function installed(marketplace: 'local' | 'kit', published = '0.333.0'): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  const plugins = { [`teamrig@${marketplace}`]: [{ scope: 'user', installPath: '/cache/teamrig/0.332.0', version: '0.332.0' }] };
  await kit.files.write(join(PLUGINS, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  await kit.files.write(join(PLUGINS, 'known_marketplaces.json'), JSON.stringify({
    local: { source: { source: 'directory', path: LOCAL }, installLocation: LOCAL },
    kit: { source: { source: 'github', repo: 'owner/kit' }, installLocation: CLONE },
  }));
  await kit.files.write(`${LOCAL}/.claude-plugin/marketplace.json`, MARKETPLACE);
  await kit.files.write(`${LOCAL}/plugins/teamrig/.claude-plugin/plugin.json`, JSON.stringify({ name: 'teamrig', version: published }));
  await kit.files.write('/bin/claude', '');
  return kit;
}

function run(kit: CliHarness, command: string, hooks: FakeHooks, stdin = ''): Promise<CliResult> {
  return kit.run(['hook', command], { stdin, hooks, platform: 'linux', env: { PATH: '/bin' }, probe: new MemoryPathProbe(kit.files) });
}

function answerOf(result: CliResult): unknown {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0] ?? '');
}

const NOTICE = { plugin: 'teamrig', marketplace: 'local', installed: '0.332.0', newest: '0.333.0' };

describe('runCli: hook update-check', () => {
  it('tells of a newer version a directory marketplace publishes, and keeps the answer in the kit home', async () => {
    const kit = await installed('local');
    const hooks = new FakeHooks();
    assert.deepEqual(answerOf(await run(kit, 'update-check', hooks)), { kind: 'notices', notices: [NOTICE] });
    assert.deepEqual(hooks.ran, []);
    assert.match((await kit.files.read(CHECK_FILE)) ?? '', /"teamrig": "0.333.0"/);
  });

  it('asks a cloned marketplace through git, never prompting for a login', async () => {
    const kit = await installed('kit');
    const repo = join(KIT, 'updates', 'kit.git');
    const hooks = new FakeHooks()
      .answer(['git', 'remote', 'get-url', 'origin'], { lines: ['https://example.test/owner/kit.git'] })
      .answer(['git', 'ls-remote', 'origin', 'HEAD'], { lines: ['abc123\tHEAD'] })
      .answer(['git', 'show', 'FETCH_HEAD:.claude-plugin/marketplace.json'], { lines: [MARKETPLACE] })
      .answer(['git', 'show', 'FETCH_HEAD:plugins/teamrig/.claude-plugin/plugin.json'], { lines: ['{"version": "0.340.0"}'] });
    assert.deepEqual(answerOf(await run(kit, 'update-check', hooks)), {
      kind: 'notices',
      notices: [{ plugin: 'teamrig', marketplace: 'kit', installed: '0.332.0', newest: '0.340.0' }],
    });
    assert.equal(hooks.ran[0]?.cwd, CLONE);
    assert.ok(hooks.ran.slice(1).every((request) => request.cwd === repo));
    assert.ok(hooks.ran.every((request) => request.env['GIT_TERMINAL_PROMPT'] === '0'));
  });

  it('tells nothing when the installed version is the newest', async () => {
    const kit = await installed('local', '0.332.0');
    assert.deepEqual(answerOf(await run(kit, 'update-check', new FakeHooks())), { kind: 'notices', notices: [] });
  });
});

describe('runCli: hook update-dismiss', () => {
  it('hides the version dismissed', async () => {
    const kit = await installed('local');
    const hooks = new FakeHooks();
    assert.deepEqual(answerOf(await run(kit, 'update-dismiss', hooks, JSON.stringify({ plugin: 'teamrig', version: '0.333.0' }))), { kind: 'dismissed' });
    assert.deepEqual(answerOf(await run(kit, 'update-check', hooks)), { kind: 'notices', notices: [] });
  });

  it('refuses a request that names no plugin and version', async () => {
    const kit = await installed('local');
    assert.deepEqual(answerOf(await run(kit, 'update-dismiss', new FakeHooks(), '{"plugin": "teamrig"}')), { kind: 'failed', why: 'stdin names no plugin and version' });
  });
});

describe('runCli: hook update-apply', () => {
  it('updates the marketplace and then the plugin through Claude Code', async () => {
    const kit = await installed('local');
    const hooks = new FakeHooks();
    assert.deepEqual(answerOf(await run(kit, 'update-apply', hooks, '{"plugin": "teamrig"}')), { kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
    assert.deepEqual(hooks.commands, [[...CLAUDE, 'plugin', 'marketplace', 'update', 'local'].join(' '), [...CLAUDE, 'plugin', 'update', 'teamrig@local'].join(' ')]);
  });

  it('names the step that failed and what it printed', async () => {
    const kit = await installed('local');
    const hooks = new FakeHooks().answer([...CLAUDE, 'plugin', 'update', 'teamrig@local'], { lines: ['Plugin not found'], end: 1 });
    assert.deepEqual(answerOf(await run(kit, 'update-apply', hooks, '{"plugin": "teamrig"}')), {
      kind: 'failed',
      why: 'claude plugin update teamrig@local failed: Plugin not found',
    });
  });

  it('refuses a plugin it tells of no update for, running nothing', async () => {
    const kit = await installed('local', '0.332.0');
    const hooks = new FakeHooks();
    assert.deepEqual(answerOf(await run(kit, 'update-apply', hooks, '{"plugin": "teamrig"}')), { kind: 'failed', why: 'no newer teamrig is published' });
    assert.deepEqual(answerOf(await run(kit, 'update-apply', hooks, '{"plugin": "other"}')), { kind: 'failed', why: 'no newer other is published' });
    assert.deepEqual(hooks.ran, []);
  });

  it('fails plainly when Claude Code is not on PATH', async () => {
    const kit = await installed('local');
    await kit.files.remove('/bin/claude');
    assert.deepEqual(answerOf(await run(kit, 'update-apply', new FakeHooks(), '{"plugin": "teamrig"}')), { kind: 'failed', why: 'Claude Code is not on PATH' });
  });
});
