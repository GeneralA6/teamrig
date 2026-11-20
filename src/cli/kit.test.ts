import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Roster } from '../config/roster.ts';
import { bareHost } from '../testing/bare-host.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { pathsIfKnown } from './host.ts';
import { checkedNextConfig, leadOrDeliveryOwnerOnly, openKit, type KitReader } from './kit.ts';
import { RefusedError } from './runtime.ts';

/** The team a new `CliHarness` holds. */
const TEAM = 'app';

describe("openKit: the team's default skills folder", () => {
  it("is the folder the run's host loads a person's skills from", async () => {
    const runtime = new CliHarness().runtime();
    const hostSkills = pathsIfKnown(runtime)?.skills(runtime.userHome);
    assert.notEqual(hostSkills, undefined);
    assert.equal((await openKit(runtime, TEAM)).paths.skills, hostSkills);
  });

  it("is the team's own for a reader that names no host, or a host that tells no folder", async () => {
    const { env, userHome, files, clock, platform } = new CliHarness().runtime();
    const hostless: KitReader = { env, userHome, files, clock };
    const kit = await openKit(hostless, TEAM);
    assert.equal(kit.load.status, 'loaded');
    assert.equal(kit.paths.skills, join(kit.paths.home, 'skills'));
    assert.equal((await openKit({ ...hostless, host: () => bareHost() }, TEAM)).paths.skills, join(kit.paths.home, 'skills'), 'a host with no platform is none');
    assert.equal((await openKit({ ...hostless, host: () => bareHost(), platform }, TEAM)).paths.skills, join(kit.paths.home, 'skills'));
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
