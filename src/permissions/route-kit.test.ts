import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTER_COMMANDS } from '../automode/lines.ts';
import { COMMAND_TABLE } from '../cli/run.ts';
import { ClientInstalls, type ClientSearch, type WordAt } from '../exec/client-launch.ts';
import { KIT_SHAPES, matchesKit, ownClientOf, type KitContext, type KitShape } from './route-kit.ts';

const CONTEXT: KitContext = { cli: COMMAND_TABLE, ownClient: async (word) => word === 'teamrig' };

const matches = async (shape: KitShape, line: string): Promise<boolean> => matchesKit(shape, line.split(' '), CONTEXT);

describe('matchesKit', () => {
  it('takes each route as the CLI reads it, with the flags and switches it allows', async () => {
    const routes: ReadonlyArray<readonly [KitShape, string]> = [
      [KIT_SHAPES.merge, 'teamrig merge'],
      [KIT_SHAPES.merge, 'teamrig merge --session tr-x --keep-remote --no-delete-local'],
      [KIT_SHAPES.deploy, 'teamrig deploy --session tr-x --repo web'],
      [KIT_SHAPES.execRequest, 'teamrig exec request --session tr-x --file C:/s/req.json'],
      [KIT_SHAPES.worktreeRemove, 'teamrig worktree remove C:/w/t1-x --session tr-x --delete-branch --dry-run'],
      [KIT_SHAPES.register, 'teamrig set T1 --session tr-x --status done --note x'],
      [KIT_SHAPES.register, 'teamrig inbox add --session tr-x --to teamrig --text x'],
      [KIT_SHAPES.register, 'teamrig list'],
    ];
    for (const [shape, line] of routes) {
      assert.equal(await matches(shape, line), true, line);
    }
  });

  it('takes every register command the CLI has', async () => {
    for (const command of REGISTER_COMMANDS) {
      assert.equal(await matches(KIT_SHAPES.register, `teamrig ${command}`), true, command);
    }
  });

  it('takes no flag the route leaves out, though the CLI takes it', async () => {
    for (const [shape, line] of [
      [KIT_SHAPES.deploy, 'teamrig deploy --session tr-x --targets web --what x'],
      [KIT_SHAPES.worktreeRemove, 'teamrig worktree remove C:/w/t1-x --base main'],
    ] as const) {
      assert.equal(await matches(shape, line), false, line);
    }
  });

  it('takes no line the CLI refuses: an unknown flag, a renamed command, a value missing, a flag twice', async () => {
    for (const [shape, line] of [
      [KIT_SHAPES.merge, 'teamrig merge --force'],
      [KIT_SHAPES.merge, 'teamrig integrate --session tr-x'],
      [KIT_SHAPES.merge, 'teamrig merge --session'],
      [KIT_SHAPES.merge, 'teamrig merge --session a --session b'],
      [KIT_SHAPES.register, 'teamrig set T1 --tier p1'],
      [KIT_SHAPES.register, 'teamrig'],
    ] as const) {
      assert.equal(await matches(shape, line), false, line);
    }
  });

  it('takes no other command, a help request, a -- or the wrong positionals', async () => {
    for (const [shape, line] of [
      [KIT_SHAPES.execRequest, 'teamrig exec approve --session tr-x'],
      [KIT_SHAPES.execRequest, 'teamrig exec run --session tr-x'],
      [KIT_SHAPES.execRequest, 'teamrig exec dry-run --session tr-x'],
      [KIT_SHAPES.register, 'teamrig rules forget'],
      [KIT_SHAPES.register, 'teamrig heavy --session tr-x --what x -- git push'],
      [KIT_SHAPES.merge, 'teamrig merge --help'],
      [KIT_SHAPES.merge, 'teamrig merge -h'],
      [KIT_SHAPES.deploy, 'teamrig deploy --session tr-x --'],
      [KIT_SHAPES.deploy, 'teamrig deploy --session tr-x -- npm ci'],
      [KIT_SHAPES.merge, 'teamrig merge web'],
      [KIT_SHAPES.worktreeRemove, 'teamrig worktree remove'],
      [KIT_SHAPES.worktreeRemove, 'teamrig worktree remove a b'],
      [KIT_SHAPES.worktreeRemove, 'teamrig worktree remove -f'],
    ] as const) {
      assert.equal(await matches(shape, line), false, line);
    }
  });

  it('takes no program word but its own client, and asks only once the line is a route', async () => {
    const asked: string[] = [];
    const context: KitContext = { cli: COMMAND_TABLE, ownClient: async (word) => (asked.push(word), false) };
    assert.equal(await matchesKit(KIT_SHAPES.merge, ['./teamrig', 'merge'], context), false);
    assert.equal(await matchesKit(KIT_SHAPES.merge, ['teamrig', 'merge', '--force'], context), false);
    assert.equal(await matchesKit(KIT_SHAPES.merge, [], context), false);
    assert.deepEqual(asked, ['./teamrig']);
  });
});

describe('ownClientOf', () => {
  const INSTALL = 'C:/u/.claude/plugins/cache/teamrig/teamrig/0.215.0';
  const AT: WordAt = { dialect: 'bash', dir: 'C:/w', home: 'C:/u' };
  const installs = new ClientInstalls(INSTALL, 'win32');
  const searchOf = (found: Readonly<Record<string, string>>): ClientSearch => ({ find: async (name) => found[name] });

  it('takes a bare teamrig the hook finds nowhere, which runs the plugin bin Claude Code appends', async () => {
    assert.equal(await ownClientOf(searchOf({}), installs, AT)('teamrig'), true);
  });

  it('takes a bare teamrig or an absolute path that reaches its own launcher', async () => {
    const own = ownClientOf(searchOf({ teamrig: `${INSTALL}/bin/teamrig` }), installs, AT);
    assert.equal(await own('teamrig'), true);
    assert.equal(await own(`${INSTALL}/bin/teamrig`), true);
    assert.equal(await own('/c/u/.claude/plugins/cache/teamrig/teamrig/0.215.0/bin/teamrig'), true);
  });

  it('takes no other client: a shadow on PATH, another version or entry, a relative path, another name', async () => {
    const shadowed = ownClientOf(searchOf({ teamrig: 'C:/u/bin/teamrig' }), installs, AT);
    assert.equal(await shadowed('teamrig'), false);
    const own = ownClientOf(searchOf({}), installs, AT);
    for (const word of [
      'C:/u/.claude/plugins/cache/teamrig/teamrig/0.214.0/bin/teamrig',
      `${INSTALL}/bin/teamrig.cmd`,
      `${INSTALL}/dist/cli/main.js`,
      './teamrig',
      'bin/teamrig',
      'Teamrig',
      'git',
    ]) {
      assert.equal(await own(word), false, word);
    }
    const inPlugin = ownClientOf(searchOf({}), installs, { ...AT, dir: INSTALL });
    assert.equal(await inPlugin('bin/teamrig'), false, 'a relative path, though it reaches the launcher');
  });
});
