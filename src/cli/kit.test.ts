import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { Roster } from '../config/roster.ts';
import { parseConfigText } from '../config/text.ts';
import type { JsonRecord } from '../core/guards.ts';
import { teamPaths } from '../core/home.ts';
import { bareHost } from '../testing/bare-host.ts';
import { CliHarness, POINTER, TEAM } from '../testing/cli-harness.ts';
import { pathsIfKnown } from './host.ts';
import { checkedNextConfig, configWarnings, findTeam, foundTeamOf, leadOrDeliveryOwnerOnly, loadedConfig, lookForTeam, openKit, type Kit, type KitReader } from './kit.ts';
import { RefusedError } from './runtime.ts';

/** The team a new `CliHarness` holds. */
const TEAM_ID = 'app';
const CONFIG_FILE = join('/', 'kit', 'teams', TEAM_ID, 'config.json');
const PATHS = teamPaths(join('/', 'kit'), TEAM_ID, join('/', 'claude', 'skills'));

/** The kit of team `app` whose config file holds `json`. */
function kitOf(json: JsonRecord): Kit {
  return { paths: PATHS, load: { ...parseConfigText(formatConfig(json)), path: CONFIG_FILE } };
}

describe('lookForTeam and foundTeamOf', () => {
  const refusal = (message: RegExp) => (error: unknown) => error instanceof RefusedError && message.test(error.message);

  it('give the team its pointer names, as findTeam does', async () => {
    const runtime = new CliHarness().runtime();
    const found = await lookForTeam(runtime);
    assert.deepEqual(found, { kind: 'team', team: 'app', from: POINTER });
    assert.deepEqual(foundTeamOf(found), { team: 'app', from: POINTER });
    assert.deepEqual(await findTeam(runtime), { team: 'app', from: POINTER });
  });

  it('look with no team and refuse nothing; only the found team refuses it', async () => {
    const runtime = new CliHarness(TEAM, null).runtime();
    const found = await lookForTeam(runtime);
    assert.deepEqual(found, { kind: 'none' });
    assert.throws(() => foundTeamOf(found), refusal(/^no team here: /));
    await assert.rejects(findTeam(runtime), refusal(/^no team here: /));
  });

  it('look at a pointer naming no team without refusing; the found team refuses it by its file', async () => {
    const found = await lookForTeam(new CliHarness(TEAM, '{"crew": "app"}').runtime());
    assert.deepEqual(found, { kind: 'broken', from: POINTER, problem: 'has no "team" text; expected {"team": "<id>"}' });
    assert.throws(() => foundTeamOf(found), refusal(/\.teamrig\.json has no "team" text/));
  });
});

describe('loadedConfig', () => {
  it('gives the config that loaded, with its path', () => {
    const load = loadedConfig(kitOf({ sessions: ['lead', 'alpha'], roles: { lead: 'lead' } }));

    assert.deepEqual([load.config.sessions, load.path], [['lead', 'alpha'], CONFIG_FILE]);
  });

  it('refuses a team with no config, naming the command that creates it', () => {
    assert.throws(
      () => loadedConfig({ paths: PATHS, load: { status: 'missing', path: CONFIG_FILE } }),
      (error: unknown) => error instanceof RefusedError && error.message === `no team config at ${CONFIG_FILE}; create it with: teamrig team create app --sessions <id,id>`,
    );
  });

  it('refuses a config that cannot be read at all', () => {
    assert.throws(
      () => loadedConfig(kitOf({ configVersion: 'x', sessions: ['lead'] })),
      (error: unknown) => error instanceof RefusedError && error.message.startsWith(`the team config at ${CONFIG_FILE} cannot be read: configVersion`),
    );
  });
});

describe('configWarnings', () => {
  it('has nothing to say of a clean config', () => {
    assert.deepEqual(configWarnings(loadedConfig(kitOf({ sessions: ['lead', 'alpha'], roles: { lead: 'lead' } }))), []);
  });

  it('counts the problems and names the first', () => {
    const [warning, ...rest] = configWarnings(loadedConfig(kitOf({ sessions: ['lead', 'alpha'], roles: { lead: 'ghost' }, pushGuard: { protectedBranches: 'main' } })));

    assert.match(warning ?? '', /^config: 2 problem\(s\), defaults used \(first: .+\); run: teamrig config validate$/);
    assert.deepEqual(rest, []);
  });

  it('says a newer teamrig wrote the file, before its problems', () => {
    const warnings = configWarnings(loadedConfig(kitOf({ configVersion: 99, sessions: ['lead', 'alpha'], roles: { lead: 'ghost' } })));

    assert.equal(warnings[0], `${CONFIG_FILE} is config version 99, from a newer teamrig; update teamrig; reading it best-effort`);
    assert.match(warnings[1] ?? '', /^config: 1 problem\(s\), defaults used \(first: roles\.lead/);
    assert.equal(warnings.length, 2);
  });
});

describe("openKit: the team's default skills folder", () => {
  it("is the folder the run's host loads a person's skills from", async () => {
    const runtime = new CliHarness().runtime();
    const hostSkills = pathsIfKnown(runtime)?.skills(runtime.userHome);
    assert.notEqual(hostSkills, undefined);
    assert.equal((await openKit(runtime, TEAM_ID)).paths.skills, hostSkills);
  });

  it("is the team's own for a reader that names no host, or a host that tells no folder", async () => {
    const { env, userHome, files, clock, platform } = new CliHarness().runtime();
    const hostless: KitReader = { env, userHome, files, clock };
    const kit = await openKit(hostless, TEAM_ID);
    assert.equal(kit.load.status, 'loaded');
    assert.equal(kit.paths.skills, join(kit.paths.home, 'skills'));
    assert.equal((await openKit({ ...hostless, host: () => bareHost() }, TEAM_ID)).paths.skills, join(kit.paths.home, 'skills'), 'a host with no platform is none');
    assert.equal((await openKit({ ...hostless, host: () => bareHost(), platform }, TEAM_ID)).paths.skills, join(kit.paths.home, 'skills'));
  });
});

describe('checkedNextConfig', () => {
  it('reads back a config that loads cleanly', () => {
    assert.deepEqual(checkedNextConfig({ sessions: ['lead', 'alpha'], roles: { lead: 'lead' } }).sessions, ['lead', 'alpha']);
  });

  it('refuses a config that would not load, or would load with a problem', () => {
    assert.throws(() => checkedNextConfig({ configVersion: 'x', sessions: ['lead'] }), (error: unknown) => error instanceof RefusedError && /^the new config cannot be read: configVersion/.test(error.message));
    assert.throws(() => checkedNextConfig({ sessions: ['lead', 'alpha'], roles: { lead: 'ghost' } }), (error: unknown) => error instanceof RefusedError && /^nothing written: roles\.lead/.test(error.message));
  });
});

describe('leadOrDeliveryOwnerOnly', () => {
  const roster = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead', deliveryOwner: 'alpha' } }, 'app');

  it('passes the lead and the delivery owner, by id or name', () => {
    assert.deepEqual([leadOrDeliveryOwnerOnly(roster, 'captain', 'x'), leadOrDeliveryOwnerOnly(roster, 'alpha', 'x')], ['lead', 'alpha']);
  });

  it('refuses anyone else, naming both roles’ holders, or the lead alone with no delivery owner', () => {
    const refused = (by: Roster, message: string) => assert.throws(() => leadOrDeliveryOwnerOnly(by, 'bravo', 'freezes the pipeline'), (error: unknown) => error instanceof RefusedError && error.message === message);
    refused(roster, 'only the lead or the delivery owner (captain, app-alpha) freezes the pipeline');
    refused(new Roster({ sessions: ['lead', 'bravo'], names: {}, roles: { lead: 'lead' } }, 'app'), 'only the lead or the delivery owner (app-lead) freezes the pipeline');
  });
});
