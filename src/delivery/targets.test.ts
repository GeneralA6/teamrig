import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deployTargetsOf, repoTargetsOf } from './targets.ts';

const DEPLOY = { targets: ['api', 'workers'], checks: [], afterPull: [], command: ['node', 'deploy.js'] };
const SITE = { mainCheckout: '/repo/site', deploysOnPush: ['cloud-web', 'api'], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false };
const PIPELINE = { mainCheckout: '/repo/app', deploysOnPush: ['api'], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false, deploy: DEPLOY };

describe('repoTargetsOf', () => {
  it('names what a repository deploys on push and what its deploy block deploys, once', () => {
    assert.deepEqual(repoTargetsOf(PIPELINE), ['api', 'workers']);
    assert.deepEqual(repoTargetsOf(SITE), ['cloud-web', 'api']);
  });
});

describe('deployTargetsOf', () => {
  it('names each target the repositories deploy on push or by their deploy block, once', () => {
    assert.deepEqual(deployTargetsOf({ site: SITE, pipeline: PIPELINE }), ['cloud-web', 'api', 'workers']);
  });
});
