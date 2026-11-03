import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';
import { CliHarness, RENAMES_PATH, renameRecordsOf, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const NAMED: JsonRecord = { ...TEAM, names: { lead: 'captain' } };
const INBOX = join(TEAM_HOME, 'state', 'inbox');

describe('runCli: rename', () => {
  it("records a session's own rename, and tells it to update its permission rules itself", async () => {
    const kit = new CliHarness(NAMED);
    const result = await kit.run(['rename', 'alpha', 'scout', '--session', 'alpha']);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        'RENAMED alpha: app-alpha -> scout',
        'NOTE app-alpha still finds alpha in every teamrig command; teamrig never edits permission or auto-mode rules, so update any that name app-alpha yourself',
      ],
      stderr: [],
    });
    assert.deepEqual(await renameRecordsOf(kit), [['alpha', 'app-alpha', 'scout', 'alpha']]);
  });

  it('lets the lead rename any session, by any of their names', async () => {
    const kit = new CliHarness(NAMED);
    assert.equal((await kit.run(['rename', 'app-bravo', 'ranger', '--session', 'captain'])).code, EXIT.ok);
    assert.equal((await kit.run(['rename', 'ranger', 'scout'], { env: { TEAMRIG_SESSION: 'lead' } })).code, EXIT.ok);
    assert.deepEqual(await renameRecordsOf(kit), [
      ['bravo', 'app-bravo', 'ranger', 'lead'],
      ['bravo', 'ranger', 'scout', 'lead'],
    ]);
  });

  it('refuses a rename by another session, and a name another session holds, writing nothing', async () => {
    const kit = new CliHarness(NAMED);
    const other = await kit.run(['rename', 'bravo', 'ranger', '--session', 'alpha']);
    assert.deepEqual([other.code, other.stdout], [EXIT.refused, ['REFUSED only bravo itself or the lead may record its new name']]);
    const taken = await kit.run(['rename', 'alpha', 'captain', '--session', 'alpha']);
    assert.deepEqual([taken.code, taken.stdout], [EXIT.refused, ['REFUSED captain is already the name of lead']]);
    assert.equal(await kit.files.read(RENAMES_PATH), undefined);
  });

  it('says a rename to the current name changes nothing', async () => {
    const kit = new CliHarness(NAMED);
    assert.deepEqual((await kit.run(['rename', 'alpha', 'app-alpha', '--session', 'alpha'])).stdout, ['UNCHANGED alpha is already called app-alpha']);
    assert.equal(await kit.files.read(RENAMES_PATH), undefined);
  });

  it('needs a session and a new name, and nothing more', async () => {
    const kit = new CliHarness(NAMED);
    for (const argv of [['rename', 'alpha'], ['rename', 'alpha', 'scout', 'extra']]) {
      assert.equal((await kit.run([...argv, '--session', 'alpha'])).code, EXIT.usage);
    }
  });

  it('keeps every old name working wherever a session is named, and lists them in who', async () => {
    const kit = new CliHarness(NAMED);
    await kit.run(['rename', 'alpha', 'scout', '--session', 'alpha']);
    await kit.run(['rename', 'scout', 'ranger', '--session', 'scout']);

    const posted = await kit.run(['inbox', 'add', '--to', 'app-alpha', '--text', 'ready', '--session', 'captain']);
    assert.match(posted.stdout[0] ?? '', /^POSTED to alpha; /);
    assert.deepEqual((await kit.run(['inbox', 'read', '--session', 'scout'])).stdout[0], '- 2030-01-08 10:00 UTC lead: ready');
    assert.equal((await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--owner', 'scout', '--session', 'app-alpha'])).code, EXIT.ok);
    const byOldName = await kit.run(['list', '--session', 'app-alpha', '--all']);
    assert.equal(byOldName.stdout.length, 1);
    assert.deepEqual(byOldName.stdout, (await kit.run(['list', '--session', 'ranger', '--all'])).stdout);

    assert.deepEqual((await kit.run(['who', 'scout'])).stdout, ['ranger']);
    assert.deepEqual((await kit.run(['who'])).stdout, ['lead captain (lead)', 'alpha ranger, formerly app-alpha, scout', 'bravo app-bravo']);
  });

  it('filters by a name of a session no longer on the team, but refuses to message it', async () => {
    const kit = new CliHarness(NAMED);
    const record = { v: 1, id: 'zulu', from: 'app-zulu', to: 'ghost', at: '2030-01-01T09:00:00.000Z', by: 'lead' };
    await kit.files.write(RENAMES_PATH, `${JSON.stringify(record)}\n`);
    assert.match((await kit.run(['inbox', 'status', '--session', 'ghost'])).stdout[0] ?? '', /^INBOX no inbox for zulu in /);
    const posted = await kit.run(['inbox', 'add', '--to', 'ghost', '--text', 'hi', '--session', 'lead']);
    assert.equal(posted.code, EXIT.refused);
  });
});

describe('runCli: doctor', () => {
  it('finds a healthy team clean', async () => {
    const kit = new CliHarness(NAMED);
    await kit.holdSecretDeny();
    await kit.run(['rename', 'alpha', 'scout', '--session', 'alpha']);
    assert.deepEqual(await kit.run(['doctor']), { code: EXIT.ok, stdout: ['DOCTOR clean, team app'], stderr: [] });
  });

  it('warns of a damaged rename log, an inbox keyed by a name and rules too long to show, and still exits 0', async () => {
    const kit = new CliHarness(NAMED);
    await kit.holdSecretDeny();
    await kit.run(['rename', 'alpha', 'scout', '--session', 'alpha']);
    await kit.files.append(RENAMES_PATH, 'not json\n');
    await kit.files.write(join(INBOX, 'scout.md'), '- 2030-01-08 09:00 lead: hello\n');
    await kit.files.write(join(TEAM_HOME, 'rules.md'), 'x'.repeat(TEAM_RULES_MAX_CHARS + 1));
    const result = await kit.run(['doctor']);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(
      result.stdout.map((line) => line.split(' ').slice(0, 2).join(' ')),
      ['DOCTOR 3', 'WARN rename-log', 'WARN inbox-orphan', 'WARN rules-long'],
    );
    assert.equal(result.stdout[0], 'DOCTOR 3 finding(s), team app');
    assert.match(result.stdout[2] ?? '', /scout is a name of alpha, whose inbox is keyed by its id/);
  });

  it('refuses without a team config, and takes no arguments', async () => {
    assert.equal((await new CliHarness(null).run(['doctor'])).code, EXIT.refused);
    assert.equal((await new CliHarness(NAMED).run(['doctor', 'extra'])).code, EXIT.usage);
  });
});
