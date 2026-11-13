import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_DELIVERY_WAIT, DEFAULT_FREEZES, DEFAULT_QUEUE, DEFAULT_STABLE_PERIODS } from '../config/defaults.ts';
import type { DeliveryConfig } from '../config/types.ts';
import { teamPaths } from '../core/home.ts';
import { PIPELINE_FREEZES_FILE, PIPELINE_FREEZES_LOCK_FILE } from './pipeline-freezes.ts';
import { deliveryDirOf, deliveryPlaces, DETACHED_DIR, detachedLogOf, GATE_HOLDS_DIR, HOST_LOCK_FILE, MERGES_FILE, REVIEW_HOLDS_DIR, teamPlace } from './places.ts';

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

describe('detachedLogOf', () => {
  it('is <id>.log in the detached folder of the delivery folder, which delivery.dir moves (T2227)', () => {
    assert.equal(detachedLogOf({}, { home: HOME, state: STATE }, '20300108-100000-4242'), join(STATE, 'deploys', DETACHED_DIR, '20300108-100000-4242.log'));
    assert.equal(detachedLogOf({ dir: 'ledger' }, { home: HOME, state: STATE }, '20300108-100000-4242'), join(HOME, 'ledger', DETACHED_DIR, '20300108-100000-4242.log'));
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
    assert.equal(places.pipelineFreezes, join(KIT, PIPELINE_FREEZES_FILE));
    assert.equal(places.pipelineFreezesLock, join(KIT, PIPELINE_FREEZES_LOCK_FILE));
  });

  it('keeps the pipeline freezes beside the host lock that delivery.queue.lockPath moves, so every team sharing it reads them', () => {
    const places = deliveryPlaces({ ...CONFIG, queue: { ...DEFAULT_QUEUE, lockPath: 'shared/host.lock' } }, PATHS);
    assert.equal(places.pipelineFreezes, join(PATHS.home, 'shared', PIPELINE_FREEZES_FILE));
    assert.equal(places.pipelineFreezesLock, join(PATHS.home, 'shared', PIPELINE_FREEZES_LOCK_FILE));
  });

  it("moves them with delivery.dir, a relative one in the team's folder", () => {
    const places = deliveryPlaces({ ...CONFIG, dir: 'deploys' }, PATHS);
    assert.equal(places.reviewHolds, join(PATHS.home, 'deploys', REVIEW_HOLDS_DIR));
    assert.equal(places.gateHolds, join(PATHS.home, 'deploys', GATE_HOLDS_DIR));
    assert.equal(places.merges, join(PATHS.home, 'deploys', MERGES_FILE));
  });
});
