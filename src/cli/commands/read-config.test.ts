import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatConfig } from '../../config/load.ts';
import { CONFIG_VERSION } from '../../config/types.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { cutText, KEPT_NOTE, SETTING_PROBLEM } from '../../interface/index.ts';
import { CliHarness, CONFIG_PATH, TEAM, type CliResult, type RunOptions } from '../../testing/cli-harness.ts';
import { problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { SUB_TEAMS, teamConfigOf, treeHarness } from '../../testing/team-tree.ts';
import { EXIT, type SelfLocation } from '../runtime.ts';
import { configSchemaPathOf } from './config.ts';
import { SCHEMA_PROBLEM } from './read-config.ts';

const READ_CONFIG = ['read', 'config', '--json'] as const;
const SELF: SelfLocation = { node: 'node', script: join('/', 'opt', 'teamrig', 'dist', 'cli', 'main.js'), execArgv: [] };
const SCHEMA_PATH = configSchemaPathOf(SELF.script);
const SCHEMA_TEXT = await readFile(new URL('../../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8');
const CURRENT_TEAM: JsonRecord = { ...TEAM, configVersion: CONFIG_VERSION, messages: { maxLines: 12 } };
/** A text one of teamrig's own secret shapes matches, built from parts so this file holds none. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');
const SHAPE = new SecretScanner().find(SECRET)?.description ?? '';
/** The keys the schema marks as naming where a secret is kept. */
const KEPT_PATHS: readonly string[] = ['secretGuard.paths', 'alerts.pageWebhookFile', 'alerts.pageWebhookKey'];
const FIELDS = ['path', 'group', 'type', 'items', 'enum', 'min', 'max', 'value', 'default', 'isDefault', 'meaning', 'editable', 'gatedBy', 'readOnly', 'problem', 'kept'];

async function withSchema(kit: CliHarness): Promise<CliHarness> {
  await kit.files.write(SCHEMA_PATH, SCHEMA_TEXT);
  return kit;
}

function teamWithSchema(config: JsonRecord = CURRENT_TEAM): Promise<CliHarness> {
  return withSchema(new CliHarness(config));
}

/** A run with the schema's place known, as every run of the installed CLI has it. */
function read(kit: CliHarness, more: readonly string[] = [], options: RunOptions = {}): Promise<CliResult> {
  return kit.run([...READ_CONFIG, ...more], { self: SELF, ...options });
}

function settingsOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'settings');
}

function settingOf(answer: JsonRecord, path: string): JsonRecord {
  const row = settingsOf(answer).find((setting) => setting['path'] === path);
  if (row === undefined) {
    throw new Error(`no setting ${path} is served`);
  }
  return row;
}

/** The rows `config get --json` prints for the same team. */
async function configGetRows(kit: CliHarness): Promise<JsonRecord[]> {
  const parsed: unknown = JSON.parse((await kit.run(['config', 'get', '--json'], { self: SELF })).stdout.join(''));
  const rows = isRecord(parsed) ? parsed['rows'] : undefined;
  if (!Array.isArray(rows)) {
    throw new Error('config get --json printed no rows');
  }
  return rows.filter(isRecord);
}

/** A team with no pointer and no `$TEAMRIG_TEAM`: a run from its project folder finds no team. */
function teamless(config: JsonRecord | null = TEAM): CliHarness {
  return new CliHarness(config, null);
}

describe('teamrig read config', () => {
  it('answers one JSON line with the envelope and the body in one order', async () => {
    const answer = served(await read(await teamWithSchema()));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], ['1.4', 'config', [], []]);
    assert.match(String(answer['revision']), /^[0-9a-f]{16}$/);
    assert.deepEqual([answer['team'], answer['teams'], answer['timeZone']], ['app', [], 'UTC']);
    assert.deepEqual(answer['priorities'], ['keep the lights on', 'correctness', 'scale', "this week's owner decisions", 'if budget allows']);
    assert.deepEqual(Object.keys(answer), ['team', 'teams', 'timeZone', 'priorities', 'settings', 'cuts', 'interface', 'document', 'revision', 'problems']);
    assert.deepEqual(Object.keys(settingOf(answer, 'messages.maxLines')), FIELDS);
  });

  it('serves the rows config get --json prints, every field there and null where the key has none', async () => {
    const kit = await teamWithSchema();
    const printed = await configGetRows(kit);
    const expected = printed.map((row) => {
      const kept = KEPT_PATHS.includes(String(row['path']));
      return {
        path: row['path'],
        group: row['group'],
        type: row['type'],
        items: row['items'] ?? null,
        enum: row['enum'] ?? null,
        min: row['min'] ?? null,
        max: row['max'] ?? null,
        value: kept ? null : (row['value'] ?? null),
        default: row['default'] ?? null,
        isDefault: row['isDefault'],
        meaning: row['meaning'],
        editable: row['editable'],
        gatedBy: row['gatedBy'] ?? null,
        readOnly: row['readOnly'] ?? null,
        problem: null,
        kept: kept ? KEPT_NOTE : null,
      };
    });
    assert.ok(printed.length > 100);
    assert.deepEqual(settingsOf(served(await read(kit))), expected);
  });

  it('serves what a pane reads of the config: a changed value beside its default, and the defaults of the rest', async () => {
    const answer = served(await read(await teamWithSchema()));
    const maxLines = settingOf(answer, 'messages.maxLines');
    assert.deepEqual([maxLines['value'], maxLines['default'], maxLines['isDefault'], maxLines['editable']], [12, 10, false, true]);
    assert.deepEqual([settingOf(answer, 'register.ownerSource')['value'], settingOf(answer, 'register.requireDecisionCard')['value']], ['owner', true]);
    const pickedUp = settingOf(answer, 'register.check.notPickedUpAfterHours');
    assert.deepEqual([typeof pickedUp['value'], pickedUp['value'], pickedUp['isDefault']], ['number', pickedUp['default'], true]);
    assert.ok(settingsOf(answer).some((setting) => String(setting['path']).startsWith('focus.')));
  });

  it('serves the config\'s zone, else the machine\'s, a change of either moving the revision', async () => {
    const kit = await teamWithSchema();
    const machine = served(await read(kit));
    const elsewhere = served(await read(kit, [], { timeZone: 'Asia/Tokyo' }));
    assert.deepEqual([machine['timeZone'], elsewhere['timeZone']], ['UTC', 'Asia/Tokyo']);
    assert.notEqual(elsewhere['revision'], machine['revision']);
    const set = served(await read(await teamWithSchema({ ...CURRENT_TEAM, timeZone: 'Europe/Paris' }), [], { timeZone: 'Asia/Tokyo' }));
    assert.equal(set['timeZone'], 'Europe/Paris');
  });

  it('serves the team\'s own priorities by name', async () => {
    const priorities = [
      { id: 1, name: 'now' },
      { id: 2, name: 'later' },
    ];
    const answer = served(await read(await teamWithSchema({ ...CURRENT_TEAM, register: { priorities } })));
    assert.deepEqual(answer['priorities'], ['now', 'later']);
  });

  it('serves a key that names where a secret is kept without its value, its path nowhere in the answer', async () => {
    const file = join('/', 'vault', 'page-hook.txt');
    const result = await read(await teamWithSchema({ ...CURRENT_TEAM, alerts: { pageWebhookFile: file } }));
    const answer = served(result);
    const row = settingOf(answer, 'alerts.pageWebhookFile');
    assert.deepEqual([row['value'], row['isDefault'], row['kept']], [null, false, KEPT_NOTE]);
    assert.ok(!result.stdout.join('\n').includes('page-hook'));
    assert.deepEqual(answer['cuts'], []);
  });

  it('serves a value less every key its schema does not name', async () => {
    const launch = { alpha: { model: 'opus', mine: 'kept to myself' } };
    const result = await read(await teamWithSchema({ ...CURRENT_TEAM, launch }));
    assert.deepEqual(settingOf(served(result), 'launch')['value'], { alpha: { model: 'opus' } });
    assert.ok(!result.stdout.join('\n').includes('kept to myself'));
  });

  it('cuts a secret-shaped element of a list by itself and lists the cut by the key', async () => {
    const result = await read(await teamWithSchema({ ...CURRENT_TEAM, permissions: { keepAllow: ['Bash(ls:*)', SECRET] } }));
    const answer = served(result);
    assert.deepEqual(settingOf(answer, 'permissions.keepAllow')['value'], ['Bash(ls:*)', cutText(SHAPE)]);
    assert.deepEqual(answer['cuts'], [{ id: 'permissions.keepAllow', field: 'value', shape: SHAPE }]);
    assert.ok(!result.stdout.join('\n').includes(SECRET));
  });

  it('leaves out a map entry whose key is secret-shaped and lists the cut under key', async () => {
    const launch = { alpha: { model: 'opus' }, [SECRET]: { model: 'sonnet' } };
    const result = await read(await teamWithSchema({ ...CURRENT_TEAM, launch }));
    const answer = served(result);
    assert.deepEqual(settingOf(answer, 'launch')['value'], { alpha: { model: 'opus' } });
    assert.deepEqual(answer['cuts'], [{ id: 'launch', field: 'key', shape: SHAPE }]);
    assert.ok(!result.stdout.join('\n').includes(SECRET));
  });

  it('says one fixed text of a value the config check finds wrong, never the check\'s own words', async () => {
    const result = await read(await teamWithSchema({ ...CURRENT_TEAM, messages: { maxLines: SECRET } }));
    const answer = served(result);
    assert.equal(settingOf(answer, 'messages.maxLines')['problem'], SETTING_PROBLEM);
    assert.ok(!result.stdout.join('\n').includes(SECRET));
    assert.deepEqual(answer['cuts'], [{ id: 'messages.maxLines', field: 'value', shape: SHAPE }]);
  });

  it('serves no setting and says why when the schema is missing or no JSON object, naming no path', async () => {
    const kit = new CliHarness(CURRENT_TEAM);
    for (const text of [undefined, '[1]', '{ not json']) {
      if (text !== undefined) {
        await kit.files.write(SCHEMA_PATH, text);
      }
      const result = await read(kit);
      const answer = served(result);
      assert.deepEqual([settingsOf(answer), problemsOf(answer), answer['team']], [[], [SCHEMA_PROBLEM], 'app']);
      assert.ok(!result.stdout.join('\n').includes('config.schema.json'));
    }
  });

  it('holds its revision until the config or the schema is written', async () => {
    const kit = await teamWithSchema();
    const revision = async (): Promise<unknown> => served(await read(kit))['revision'];
    const first = await revision();
    assert.equal(await revision(), first);
    await kit.files.write(CONFIG_PATH, formatConfig({ ...CURRENT_TEAM, messages: { maxLines: 14 } }));
    const withConfig = await revision();
    await kit.files.write(SCHEMA_PATH, `${SCHEMA_TEXT}\n`);
    assert.equal(new Set([first, withConfig, await revision()]).size, 3);
  });

  it('writes no file', async () => {
    const kit = await teamWithSchema();
    const before = await kit.files.list(join('/'));
    const config = await kit.files.read(CONFIG_PATH);
    served(await read(kit));
    assert.deepEqual([await kit.files.list(join('/')), await kit.files.read(CONFIG_PATH)], [before, config]);
  });

  it('serves the config of a team above the caller\'s with --team, and refuses one beside it', async () => {
    const kit = await withSchema(await treeHarness());
    const asUi = { env: { TEAMRIG_TEAM: 'ui' } };
    const own = served(await read(kit, [], asUi));
    const above = served(await read(kit, ['--team', 'web'], asUi));
    assert.deepEqual([own['team'], settingOf(own, 'sessions')['value']], ['ui', SUB_TEAMS['ui']?.['sessions']]);
    assert.deepEqual([above['team'], settingOf(above, 'sessions')['value']], ['web', SUB_TEAMS['web']?.['sessions']]);
    assert.notEqual(above['revision'], own['revision']);
    const beside = await read(kit, ['--team', 'ops'], asUi);
    assert.deepEqual([beside.code, beside.stdout], [EXIT.refused, []]);
  });
});

describe('teamrig read config with no team', () => {
  it('answers team null and the teams of this machine to join, with no setting', async () => {
    const answer = served(await read(await withSchema(teamless())));
    assert.deepEqual([answer['document'], answer['problems'], answer['cuts']], ['config', [], []]);
    assert.deepEqual(
      { team: answer['team'], teams: answer['teams'], timeZone: answer['timeZone'], priorities: answer['priorities'], settings: answer['settings'] },
      { team: null, teams: ['app'], timeZone: 'UTC', priorities: [], settings: [] },
    );
  });

  it('lists every team folder whose config can be read, by id, and none for a home holding no team', async () => {
    const kit = teamless({ ...TEAM, team: { id: 'app' } });
    for (const [team, config] of Object.entries(SUB_TEAMS)) {
      await kit.files.write(teamConfigOf(team), formatConfig(config));
    }
    await kit.files.write(teamConfigOf('torn'), '{ not json');
    assert.deepEqual(served(await read(kit))['teams'], ['app', 'ops', 'ui', 'web']);
    assert.deepEqual(served(await read(teamless(null)))['teams'], []);
  });

  it('serves the machine\'s zone, there being no team to name one', async () => {
    assert.equal(served(await read(teamless(), [], { timeZone: 'Asia/Tokyo' }))['timeZone'], 'Asia/Tokyo');
  });

  it('moves its revision when a team folder is added, and holds it otherwise', async () => {
    const kit = teamless();
    const revision = async (): Promise<unknown> => served(await read(kit))['revision'];
    const first = await revision();
    assert.equal(await revision(), first);
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: CONFIG_VERSION, team: { id: 'web' }, sessions: ['lead'], roles: { lead: 'lead' } }));
    assert.notEqual(await revision(), first);
  });

  it('refuses, on stderr and with no document, a document only a team has, a --team, and a pointer naming no team', async () => {
    const refusals: readonly (readonly [CliHarness, readonly string[], RegExp])[] = [
      [teamless(), ['read', 'tasks', 'config', '--json'], /^REFUSED no team here: /],
      [teamless(), [...READ_CONFIG, '--team', 'app'], /^REFUSED no team here: /],
      [new CliHarness(TEAM, '{"crew": "app"}'), READ_CONFIG, /\.teamrig\.json has no "team" text/],
    ];
    for (const [kit, argv, message] of refusals) {
      const result = await kit.run(argv, { self: SELF });
      assert.deepEqual([result.code, result.stdout], [EXIT.refused, []]);
      assert.match(result.stderr.join('\n'), message);
    }
  });
});
