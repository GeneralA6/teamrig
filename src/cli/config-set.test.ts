import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_MIGRATIONS, type ConfigFormat } from '../config/migrate.ts';
import { CONFIG_VERSION } from '../config/types.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { CliHarness, CONFIG_PATH, TEAM } from '../testing/cli-harness.ts';
import { configSchemaPathOf } from './commands/config.ts';
import type { SelfLocation } from './runtime.ts';
import { EXIT } from './runtime.ts';

const SELF: SelfLocation = { node: 'node', script: join('/', 'opt', 'teamrig', 'dist', 'cli', 'main.js'), execArgv: [] };
const SCHEMA_TEXT = await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8');
const CURRENT_TEAM: JsonRecord = { ...TEAM, configVersion: CONFIG_VERSION, messages: { maxLines: 12 } };
const AS_LEAD = { self: SELF, env: { TEAMRIG_SESSION: 'lead' } };

async function teamWithSchema(config: JsonRecord = CURRENT_TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(configSchemaPathOf(SELF.script), SCHEMA_TEXT);
  return kit;
}

async function fileOf(kit: CliHarness): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse((await kit.files.read(CONFIG_PATH)) ?? '');
  assert.ok(isRecord(parsed));
  return parsed;
}

describe('config set', () => {
  it('shows the change without --yes and writes nothing', async () => {
    const kit = await teamWithSchema();
    const result = await kit.run(['config', 'set', 'messages.maxLines', '20'], AS_LEAD);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, ['PREVIEW set messages.maxLines 12 -> 20; nothing written (add --yes to write)']);
    assert.deepEqual((await fileOf(kit))['messages'], { maxLines: 12 });
  });

  it('writes the value by the key type with --yes, keeping every other key and the old file', async () => {
    const kit = await teamWithSchema();
    const result = await kit.run(['config', 'set', 'register.verifyGate', 'warn', '--yes'], AS_LEAD);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout[0] ?? '', /^SET register\.verifyGate \(unset: default "refuse"\) -> "warn"; the old config is at .*config\.set\.json$/);
    const file = await fileOf(kit);
    assert.deepEqual([file['register'], file['messages'], file['sessions']], [{ verifyGate: 'warn' }, { maxLines: 12 }, TEAM['sessions']]);
    const typed = await kit.run(['config', 'set', 'messages.coldAfterMinutes', '0', '--yes'], AS_LEAD);
    assert.equal(typed.code, EXIT.ok);
    assert.deepEqual((await fileOf(kit))['messages'], { maxLines: 12, coldAfterMinutes: 0 });
  });

  it('removes a key with --unset, so it reads its default', async () => {
    const kit = await teamWithSchema();
    const result = await kit.run(['config', 'set', 'messages.maxLines', '--unset', '--yes'], AS_LEAD);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout[0] ?? '', /^SET messages\.maxLines 12 -> \(unset: default 10\); the old config is at /);
    assert.equal((await fileOf(kit))['messages'], undefined);
  });

  it('writes nothing when the key already holds the value', async () => {
    const kit = await teamWithSchema();
    const before = await kit.files.read(CONFIG_PATH);
    const result = await kit.run(['config', 'set', 'messages.maxLines', '12', '--yes'], AS_LEAD);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['UNCHANGED messages.maxLines 12']]);
    assert.equal(await kit.files.read(CONFIG_PATH), before);
  });

  it('lets a set fix the only problem in the config, and refuses one that leaves another', async () => {
    const broken = { ...CURRENT_TEAM, messages: { maxLines: 'many' } };
    const fixed = await (await teamWithSchema(broken)).run(['config', 'set', 'messages.maxLines', '15', '--yes'], AS_LEAD);
    assert.equal(fixed.code, EXIT.ok);
    const elsewhere = await (await teamWithSchema(broken)).run(['config', 'set', 'messages.coldAfterMinutes', '5', '--yes'], AS_LEAD);
    assert.equal(elsewhere.code, EXIT.refused);
    assert.match(elsewhere.stdout[0] ?? '', /nothing written: messages\.maxLines: /);
  });

  it('refuses anyone but the lead', async () => {
    const result = await (await teamWithSchema()).run(['config', 'set', 'messages.maxLines', '20', '--yes'], { self: SELF, env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /only the lead \(.*\) changes the team config$/);
  });

  it('refuses an owner-gated key, a roster key, a group and an unknown key', async () => {
    const kit = await teamWithSchema();
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['budget.targetPct', '90'], /budget\.targetPct is read-only: owner gate: budget$/],
      [['dbWriteGuard.writes', 'allow'], /dbWriteGuard\.writes is read-only: owner gate: permissions$/],
      [['sessions', 'lead,alpha'], /sessions is read-only: the roster: /],
      [['messages', '3'], /messages holds 2 keys; set one: messages\.maxLines, messages\.coldAfterMinutes$/],
      [['message', '3'], /the config has no key message; teamrig config get lists them$/],
    ];
    for (const [words, refusal] of cases) {
      const result = await kit.run(['config', 'set', ...words, '--yes'], AS_LEAD);
      assert.equal(result.code, EXIT.refused, words.join(' '));
      assert.match(result.stdout[0] ?? '', refusal);
    }
  });

  it('lets the lead name the GitHub watcher, one of the sessions, and refuses a name not on the roster', async () => {
    const kit = await teamWithSchema();
    const named = await kit.run(['config', 'set', 'github.watcher', 'bravo', '--yes'], AS_LEAD);
    assert.equal(named.code, EXIT.ok, named.stdout.join('\n'));
    const github = (await fileOf(kit))['github'];
    assert.equal(isRecord(github) ? github['watcher'] : undefined, 'bravo');
    const before = await kit.files.read(CONFIG_PATH);
    const stranger = await kit.run(['config', 'set', 'github.watcher', 'zulu', '--yes'], AS_LEAD);
    assert.notEqual(stranger.code, EXIT.ok);
    assert.match(stranger.stdout.join('\n'), /github\.watcher.*"zulu" is not one of the sessions/);
    assert.equal(await kit.files.read(CONFIG_PATH), before);
  });

  it('refuses a value the key does not take, naming what it takes', async () => {
    const kit = await teamWithSchema();
    const result = await kit.run(['config', 'set', 'messages.maxLines', '99', '--yes'], AS_LEAD);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /messages\.maxLines takes 3 to 50, not 99$/);
  });

  it('refuses an older config until it is migrated', async () => {
    const renamed: ConfigFormat = {
      version: CONFIG_VERSION + 1,
      migrations: [...CONFIG_MIGRATIONS, { from: CONFIG_VERSION, firstRelease: '9.0.0', apply: (config) => ({ config, changes: ['nothing'] }) }],
    };
    const result = await (await teamWithSchema()).run(['config', 'set', 'messages.maxLines', '20', '--yes'], { ...AS_LEAD, configFormat: renamed });
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /write the current format first: teamrig config migrate$/);
  });

  it('needs a key and a value, or --unset alone', async () => {
    const kit = await teamWithSchema();
    for (const words of [[], ['messages.maxLines'], ['messages.maxLines', '3', '--unset'], ['messages.maxLines', '3', '4']]) {
      assert.equal((await kit.run(['config', 'set', ...words], AS_LEAD)).code, EXIT.usage, words.join(' '));
    }
  });
});
