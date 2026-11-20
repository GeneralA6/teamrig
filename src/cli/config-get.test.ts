import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { CONFIG_MIGRATIONS, type ConfigFormat } from '../config/migrate.ts';
import { CONFIG_VERSION } from '../config/types.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { CliHarness, CONFIG_PATH, TEAM } from '../testing/cli-harness.ts';
import { SUB_TEAMS, teamConfigOf, treeHarness } from '../testing/team-tree.ts';
import { configSchemaPathOf } from './commands/config.ts';
import type { SelfLocation } from './runtime.ts';
import { EXIT } from './runtime.ts';

const SELF: SelfLocation = { node: 'node', script: join('/', 'opt', 'teamrig', 'dist', 'cli', 'main.js'), execArgv: [] };
const SCHEMA_TEXT = await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8');
const CURRENT_TEAM: JsonRecord = { ...TEAM, configVersion: CONFIG_VERSION, messages: { maxLines: 12 } };

async function teamWithSchema(config: JsonRecord | string = CURRENT_TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(configSchemaPathOf(SELF.script), SCHEMA_TEXT);
  return kit;
}

/** The rows of `config get --json` read from `file`, each checked to be an object. */
function rowsOf(stdout: readonly string[], file = CONFIG_PATH): readonly JsonRecord[] {
  assert.equal(stdout.length, 1, stdout.join('\n'));
  const parsed: unknown = JSON.parse(stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  assert.equal(parsed['file'], file);
  const rows = parsed['rows'];
  assert.ok(Array.isArray(rows));
  return rows.filter(isRecord);
}

describe('config get', () => {
  it('finds the schema beside the installed CLI, or in the repository for one run from source', () => {
    assert.equal(configSchemaPathOf(SELF.script), join('/', 'opt', 'teamrig', 'config.schema.json'));
    assert.equal(configSchemaPathOf(join('/', 'repo', 'src', 'cli', 'main.ts')), join('/', 'repo', 'plugins', 'teamrig', 'config.schema.json'));
  });

  it('prints each key with its value, the default beside a changed one, and why a key is read-only', async () => {
    const result = await (await teamWithSchema()).run(['config', 'get'], { self: SELF });
    assert.equal(result.code, EXIT.ok);
    assert.ok(result.stdout.includes('messages.maxLines 12  (default 10)'));
    assert.ok(result.stdout.includes('messages.coldAfterMinutes 60'));
    assert.ok(result.stdout.includes('sessions ["lead","alpha","bravo"]  (read-only: the roster: changed only by teamrig hire, retire, rename, promote and demote)'));
    assert.ok(result.stdout.some((line) => /^budget\.targetPct .*\(.*read-only: owner gate: budget\)$/.test(line)));
  });

  it('gives a settings screen one JSON document of the rows under a key', async () => {
    const result = await (await teamWithSchema()).run(['config', 'get', 'messages', '--json'], { self: SELF });
    assert.equal(result.code, EXIT.ok);
    const rows = rowsOf(result.stdout);
    assert.deepEqual(rows.map((row) => row['path']), ['messages.maxLines', 'messages.coldAfterMinutes']);
    assert.deepEqual([rows[0]?.['value'], rows[0]?.['default'], rows[0]?.['isDefault'], rows[0]?.['editable']], [12, 10, false, true]);
  });

  it('names the problem in a value it reads as its default', async () => {
    const result = await (await teamWithSchema({ ...CURRENT_TEAM, messages: { maxLines: 'many' } })).run(['config', 'get', 'messages.maxLines'], { self: SELF });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout[0] ?? '', /^messages\.maxLines "many" {2}\(default 10; problem: .+, read as its default\)$/);
  });

  it('reads an older config migrated, as every command does', async () => {
    const renamed: ConfigFormat = {
      version: CONFIG_VERSION + 1,
      migrations: [
        ...CONFIG_MIGRATIONS,
        { from: CONFIG_VERSION, firstRelease: '9.0.0', apply: (config) => ({ config: { ...config, messages: { maxLines: 20 } }, changes: ['moved the line limit'] }) },
      ],
    };
    const result = await (await teamWithSchema()).run(['config', 'get', 'messages.maxLines', '--json'], { self: SELF, configFormat: renamed });
    assert.equal(rowsOf(result.stdout)[0]?.['value'], 20);
  });

  it('refuses an unknown key, a second key, a config it cannot read and a missing schema', async () => {
    const unknown = await (await teamWithSchema()).run(['config', 'get', 'message'], { self: SELF });
    assert.equal(unknown.code, EXIT.refused);
    assert.match(unknown.stdout[0] ?? '', /the config has no key message; teamrig config get lists them$/);
    assert.equal((await (await teamWithSchema()).run(['config', 'get', 'messages', 'register'], { self: SELF })).code, EXIT.usage);
    const unreadable = await (await teamWithSchema('{ not json')).run(['config', 'get'], { self: SELF });
    assert.equal(unreadable.code, EXIT.refused);
    assert.match(unreadable.stdout[0] ?? '', /cannot be read: .*teamrig config validate shows it$/);
    assert.equal((await new CliHarness(null).run(['config', 'get'], { self: SELF })).code, EXIT.refused);
    const noSchema = await new CliHarness(CURRENT_TEAM).run(['config', 'get'], { self: SELF });
    assert.equal(noSchema.code, EXIT.refused);
    assert.match(noSchema.stdout[0] ?? '', /no config schema at .*config\.schema\.json; reinstall teamrig$/);
  });

  it("reads another team of the caller's tree with --team, above, below or beside it (#1513)", async () => {
    const kit = await treeHarness({ messages: { maxLines: 30 } });
    await kit.files.write(configSchemaPathOf(SELF.script), SCHEMA_TEXT);
    await kit.files.write(teamConfigOf('ui'), formatConfig({ ...SUB_TEAMS['ui'], messages: { maxLines: 7 } }));
    const asks: [Record<string, string>, string, unknown][] = [
      [{}, 'ui', 7],
      [{}, 'web', 10],
      [{ TEAMRIG_TEAM: 'ui' }, 'app', 30],
      [{ TEAMRIG_TEAM: 'ui' }, 'ops', 10],
      [{ TEAMRIG_TEAM: 'ui' }, 'ui', 7],
    ];
    for (const [env, team, maxLines] of asks) {
      const result = await kit.run(['config', 'get', 'messages.maxLines', '--json', '--team', team], { self: SELF, env });
      assert.equal(result.code, EXIT.ok, `${team}: ${result.stdout.join('\n')}`);
      assert.equal(rowsOf(result.stdout, team === 'app' ? CONFIG_PATH : teamConfigOf(team))[0]?.['value'], maxLines, team);
    }
  });

  it('refuses --team for a team outside the caller\'s tree, or one with no config (#1513)', async () => {
    const kit = await treeHarness();
    await kit.files.write(configSchemaPathOf(SELF.script), SCHEMA_TEXT);
    await kit.files.write(teamConfigOf('other'), formatConfig({ configVersion: 1, team: { id: 'other' }, sessions: ['boss'], roles: { lead: 'boss' } }));
    const outside = await kit.run(['config', 'get', '--json', '--team', 'other'], { self: SELF });
    assert.equal(outside.code, EXIT.refused);
    assert.match(outside.stdout[0] ?? '', /team other is not in team app's tree: --team names a team above, below or beside yours$/);
    const missing = await kit.run(['config', 'get', '--json', '--team', 'nope'], { self: SELF });
    assert.equal(missing.code, EXIT.refused);
    assert.match(missing.stdout[0] ?? '', /no team nope with a config in this kit home$/);
  });

  it('gives the github.watcher row the session teamrig resolves, from the key or the fallback (#1513)', async () => {
    const watcherOf = async (config: JsonRecord): Promise<unknown> => {
      const result = await (await teamWithSchema(config)).run(['config', 'get', 'github.watcher', '--json'], { self: SELF });
      assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
      return rowsOf(result.stdout)[0]?.['resolved'];
    };
    assert.deepEqual(await watcherOf(CURRENT_TEAM), { session: 'lead', from: 'fallback' });
    assert.deepEqual(await watcherOf({ ...CURRENT_TEAM, github: { watcher: 'bravo' } }), { session: 'bravo', from: 'key' });
    const answerer = { ...CURRENT_TEAM, serviceRoles: { intake: { holders: ['alpha'], commands: ['issue comment'] } } };
    assert.deepEqual(await watcherOf(answerer), { session: 'alpha', from: 'fallback' });
    const other = await (await teamWithSchema()).run(['config', 'get', 'messages', '--json'], { self: SELF });
    assert.ok(rowsOf(other.stdout).every((row) => !('resolved' in row)));
  });
});
