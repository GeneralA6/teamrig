import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { SHIPPED_CONFIG_FORMAT } from '../config/migrate.ts';
import { parseConfig } from '../config/parse.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { applyTeamSetup, configRecordOf, planTeamSetup, teamSpecOf, type Checked, type SetupPlan, type TeamSpec } from './team-create.ts';

const CONFIG = resolve('/', 'kit', 'teams', 'shop', 'config.json');
const PROJECT = resolve('/', 'work', 'shop');
const POINTER = join(PROJECT, '.teamrig.json');
const SPEC: TeamSpec = { team: 'shop', lead: 'lead', sessions: ['lead', 'api', 'web'] };

function valueOf<T>(checked: Checked<T>): T {
  assert.ok(checked.ok, checked.ok ? '' : checked.problem);
  return checked.value;
}

function problemOf<T>(checked: Checked<T>): string {
  assert.ok(!checked.ok, 'expected a problem');
  return checked.problem;
}

function plan(files: MemoryFiles, spec: TeamSpec = SPEC): Promise<Checked<SetupPlan>> {
  return planTeamSetup(files, SHIPPED_CONFIG_FORMAT, spec, CONFIG, PROJECT);
}

describe('teamSpecOf', () => {
  it('puts the lead first, once, whether or not --sessions lists it', () => {
    assert.deepEqual(valueOf(teamSpecOf('shop', 'api,web', 'lead')), SPEC);
    assert.deepEqual(valueOf(teamSpecOf('shop', ' api , lead,web', 'lead')), SPEC);
  });

  it('refuses ids it could not use as folder and file names', () => {
    assert.match(problemOf(teamSpecOf('Shop', 'api', 'lead')), /^team "Shop" is not an id/);
    assert.match(problemOf(teamSpecOf('shop', 'api', 'the lead')), /^--lead "the lead" is not a session id/);
    assert.match(problemOf(teamSpecOf('shop', 'api,$(rm -rf ~)', 'lead')), /^--sessions "\$\(rm -rf ~\)" is not a session id/);
    assert.match(problemOf(teamSpecOf('shop', 'api,,web', 'lead')), /^--sessions "" is not a session id/);
  });

  it('refuses a session listed twice, and a team of the lead alone', () => {
    assert.equal(problemOf(teamSpecOf('shop', 'api,web,api', 'lead')), '--sessions lists "api" twice');
    assert.equal(problemOf(teamSpecOf('shop', 'lead', 'lead')), '--sessions needs at least one session besides the lead');
  });
});

describe('configRecordOf', () => {
  it('writes the smallest config, which reads back with no problems', () => {
    const record = configRecordOf(SPEC);
    assert.deepEqual(record, { configVersion: 1, sessions: ['lead', 'api', 'web'], roles: { lead: 'lead' } });
    const parsed = parseConfig(record);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.config.sessions, SPEC.sessions);
  });

  it('throws rather than write a config its own parser would refuse', () => {
    assert.throws(() => configRecordOf({ team: 'shop', lead: 'Lead', sessions: ['Lead', 'api'] }), /breaks its own schema/);
  });
});

describe('planTeamSetup and applyTeamSetup', () => {
  it('writes the config, then the pointer, in an empty kit and project', async () => {
    const files = new MemoryFiles();
    const planned = valueOf(await plan(files));
    assert.deepEqual(files.paths(), [], 'planning writes nothing');
    assert.deepEqual(planned.config, { kind: 'create', path: CONFIG, text: formatConfig(configRecordOf(SPEC)) });
    assert.deepEqual(planned.pointer, { kind: 'create', path: POINTER, text: '{\n  "team": "shop"\n}\n' });
    valueOf(await applyTeamSetup(files, planned));
    assert.equal(files.get(CONFIG), formatConfig(configRecordOf(SPEC)));
    assert.equal(files.get(POINTER), '{\n  "team": "shop"\n}\n');
  });

  it('keeps both on a second run with the same team, in any session order', async () => {
    const files = new MemoryFiles();
    valueOf(await applyTeamSetup(files, valueOf(await plan(files))));
    const again = valueOf(await plan(files, { ...SPEC, sessions: ['lead', 'web', 'api'] }));
    assert.deepEqual(again.config, { kind: 'keep', path: CONFIG, why: 'team shop already has these sessions' });
    assert.deepEqual(again.pointer, { kind: 'keep', path: POINTER, why: 'the project is already tied to team shop' });
    valueOf(await applyTeamSetup(files, again));
  });

  it('keeps a pointer a parent folder already gives this team', async () => {
    const parent = join(resolve('/', 'work'), '.teamrig.json');
    const files = new MemoryFiles({ [parent]: '{"team": "shop"}' });
    const planned = valueOf(await plan(files));
    assert.deepEqual(planned.pointer, { kind: 'keep', path: parent, why: 'the project is already tied to team shop' });
  });

  it('refuses a team that exists with other sessions or another lead', async () => {
    const other = formatConfig({ configVersion: 1, sessions: ['boss', 'api', 'web'], roles: { lead: 'boss' } });
    assert.equal(
      problemOf(await plan(new MemoryFiles({ [CONFIG]: other }))),
      `team shop already exists at ${CONFIG} with sessions boss, api, web (lead boss); choose another team name, or change that config by hand`,
    );
    const fewer = formatConfig({ configVersion: 1, sessions: ['lead', 'api'], roles: { lead: 'lead' } });
    assert.match(problemOf(await plan(new MemoryFiles({ [CONFIG]: fewer }))), /already exists .* with sessions lead, api \(lead lead\)/);
  });

  it('refuses a team whose config cannot be read', async () => {
    assert.match(problemOf(await plan(new MemoryFiles({ [CONFIG]: 'not json' }))), /already has a config at .* and it cannot be read \(.+\); choose another team name$/);
  });

  it('refuses a project tied to another team, or with a broken pointer', async () => {
    assert.equal(
      problemOf(await plan(new MemoryFiles({ [POINTER]: '{"team": "blog"}' }))),
      `${PROJECT} is already tied to team blog by ${POINTER}; give another --project, or remove that pointer first`,
    );
    assert.match(problemOf(await plan(new MemoryFiles({ [POINTER]: '{"tea": 1}' }))), /has no "team" text; .*; fix or remove it, then run this again$/);
  });

  it('stops when a file appears between the check and the write, and a rerun completes', async () => {
    const files = new MemoryFiles();
    const planned = valueOf(await plan(files));
    await files.write(POINTER, '{"team": "shop"}');
    assert.equal(problemOf(await applyTeamSetup(files, planned)), `${POINTER} appeared while the team was being set up; run the command again`);
    assert.equal(files.get(CONFIG), formatConfig(configRecordOf(SPEC)), 'the config was written first');
    const rerun = valueOf(await plan(files));
    assert.equal(rerun.config.kind, 'keep');
    assert.equal(rerun.pointer.kind, 'keep');
  });
});
