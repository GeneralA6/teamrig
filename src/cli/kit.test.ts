import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { Roster } from '../config/roster.ts';
import { parseConfigText } from '../config/text.ts';
import type { JsonRecord } from '../core/guards.ts';
import { teamPaths } from '../core/home.ts';
import { checkedNextConfig, configWarnings, leadOrDeliveryOwnerOnly, loadedConfig, type Kit } from './kit.ts';
import { RefusedError } from './runtime.ts';

const CONFIG_FILE = join('/', 'kit', 'teams', 'app', 'config.json');
const PATHS = teamPaths(join('/', 'kit'), 'app', join('/', 'claude'));

/** The kit of team `app` whose config file holds `json`. */
function kitOf(json: JsonRecord): Kit {
  return { paths: PATHS, load: { ...parseConfigText(formatConfig(json)), path: CONFIG_FILE } };
}

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
