import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_DELIVERY_WAIT, DEFAULT_FREEZES, DEFAULT_QUEUE, DEFAULT_STABLE_PERIODS } from '../config/defaults.ts';
import type { DeliveryConfig } from '../config/types.ts';
import { teamPaths } from '../core/home.ts';
import { deliveryDirOf, deliveryPlaces, GATE_HOLDS_DIR, HOST_LOCK_FILE, MERGES_FILE, REVIEW_HOLDS_DIR, teamPlace } from './places.ts';

const HOME = resolve('kit', 'teams', 'app');
const STATE = join(HOME, 'state');

describe('teamPlace', () => {
  it("puts a relative path in the team's folder and keeps an absolute one", () => {
    assert.equal(teamPlace({ home: HOME }, 'deploys'), join(HOME, 'deploys'));
    const absolute = resolve('shared', 'deploys');
    assert.equal(teamPlace({ home: HOME }, absolute), absolute);
  });
});

describe('deliveryDirOf', () => {
  it("is <state>/deploys when delivery.dir is unset, and delivery.dir in the team's folder when set", () => {
    assert.equal(deliveryDirOf({}, { home: HOME, state: STATE }), join(STATE, 'deploys'));
    assert.equal(deliveryDirOf({ dir: 'ledger' }, { home: HOME, state: STATE }), join(HOME, 'ledger'));
    const absolute = resolve('shared', 'deploys');
    assert.equal(deliveryDirOf({ dir: absolute }, { home: HOME, state: STATE }), absolute);
  });
});

const KIT = join('/', 'kit');
const PATHS = teamPaths(KIT, 'app', join('/', 'user'));
const CONFIG: DeliveryConfig = {
  schedule: {},
  queue: DEFAULT_QUEUE,
  wait: DEFAULT_DELIVERY_WAIT,
  checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
  freezes: DEFAULT_FREEZES,
  stablePeriods: DEFAULT_STABLE_PERIODS,
  repos: {},
};

describe('deliveryPlaces', () => {
  it("keeps the holds and the merges log beside the ledger in the state's deploys folder, and the host lock in the kit home", () => {
    const places = deliveryPlaces(CONFIG, PATHS);
    const dir = join(PATHS.state, 'deploys');
    assert.equal(places.reviewHolds, join(dir, REVIEW_HOLDS_DIR));
    assert.equal(places.gateHolds, join(dir, GATE_HOLDS_DIR));
    assert.equal(places.merges, join(dir, MERGES_FILE));
    assert.equal(join(places.ledger, '..'), dir);
    assert.equal(places.hostLock, join(KIT, HOST_LOCK_FILE));
  });

  it("moves them with delivery.dir, a relative one in the team's folder", () => {
    const places = deliveryPlaces({ ...CONFIG, dir: 'deploys' }, PATHS);
    assert.equal(places.reviewHolds, join(PATHS.home, 'deploys', REVIEW_HOLDS_DIR));
    assert.equal(places.gateHolds, join(PATHS.home, 'deploys', GATE_HOLDS_DIR));
    assert.equal(places.merges, join(PATHS.home, 'deploys', MERGES_FILE));
  });
});
