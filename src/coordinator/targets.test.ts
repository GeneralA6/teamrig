import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deployTargetsOf, repoTargetsOf } from './targets.ts';

const DEPLOY = { targets: ['api', 'workers'], checks: [], afterPull: [], command: ['node', 'deploy.js'] };
const SITE = { mainCheckout: '/repo/site', deploysOnPush: ['cloud-web', 'api'], dependencyGate: false, followMainCheckout: false };
const PIPELINE = { mainCheckout: '/repo/app', deploysOnPush: ['api'], dependencyGate: false, followMainCheckout: false, deploy: DEPLOY };

describe('repoTargetsOf', () => {
  it('names what a repository deploys on push and what its roll rolls, once', () => {
    assert.deepEqual(repoTargetsOf(PIPELINE), ['api', 'workers']);
    assert.deepEqual(repoTargetsOf(SITE), ['cloud-web', 'api']);
  });
});

describe('deployTargetsOf', () => {
  it('names each target the repositories deploy on push or roll, once', () => {
    assert.deepEqual(deployTargetsOf({ site: SITE, pipeline: PIPELINE }), ['cloud-web', 'api', 'workers']);
  });
});
