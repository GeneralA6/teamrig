import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED, UNSUPPORTED, manifestOf } from '../testing/manifests.ts';
import { isManifest, isOs, isProofRef, isSupport, manifestProblems, provedOn, supportProblem, type ProofRef } from './support.ts';

const PROOF: ProofRef = { os: 'windows', toolVersion: '2.1.0', date: '2026-11-19', evidence: 'docs/proofs/some-cli.md' };
const PROOFS_SHAPE = 'its proofs must be a list of { os, toolVersion, date, evidence }';

describe('a live proof', () => {
  it('names one of the three operating systems', () => {
    assert.equal(isOs('windows'), true);
    assert.equal(isOs('linux'), true);
    assert.equal(isOs('macos'), true);
    assert.equal(isOs('win32'), false);
  });

  it('holds its OS, tool version, day and evidence', () => {
    assert.equal(isProofRef(PROOF), true);
    assert.equal(isProofRef('windows'), false);
    assert.equal(isProofRef({ ...PROOF, os: 'solaris' }), false);
    assert.equal(isProofRef({ ...PROOF, toolVersion: ' ' }), false);
    assert.equal(isProofRef({ ...PROOF, date: 'yesterday' }), false);
    assert.equal(isProofRef({ ...PROOF, date: 20261119 }), false);
    assert.equal(isProofRef({ ...PROOF, evidence: undefined }), false);
  });
});

describe('a manifest row', () => {
  it('is supported with its proofs, none yet included', () => {
    assert.equal(supportProblem({ kind: 'supported', proofs: [] }), undefined);
    assert.equal(supportProblem({ kind: 'supported', proofs: [PROOF] }), undefined);
    assert.equal(supportProblem({ kind: 'supported' }), PROOFS_SHAPE);
    assert.equal(supportProblem({ kind: 'supported', proofs: [{ os: 'windows' }] }), PROOFS_SHAPE);
  });

  it('is partial only with what is missing, a notice and its proofs', () => {
    const partial = { kind: 'partial', missing: 'no hook at a turn end', notice: 'turn-end checks are off', proofs: [PROOF] };
    assert.equal(supportProblem(partial), undefined);
    assert.equal(supportProblem({ ...partial, missing: '' }), 'a partial row says what is missing');
    assert.equal(supportProblem({ ...partial, notice: 7 }), 'a partial row needs a notice');
    assert.equal(supportProblem({ ...partial, proofs: 'none' }), PROOFS_SHAPE);
  });

  it('is unsupported only with a notice', () => {
    assert.equal(supportProblem({ kind: 'unsupported', notice: 'the tool has no labels' }), undefined);
    assert.equal(supportProblem({ kind: 'unsupported' }), 'an unsupported row needs a notice');
  });

  it('is nothing else', () => {
    assert.equal(supportProblem({ kind: 'maybe' }), 'its kind must be supported, partial or unsupported');
    assert.equal(supportProblem(null), 'it is not a support value');
    assert.equal(isSupport(SUPPORTED), true);
    assert.equal(isSupport(true), false);
  });

  it('is proved on the operating systems its proofs were made on, each once', () => {
    const linux: ProofRef = { ...PROOF, os: 'linux' };
    assert.deepEqual(provedOn(SUPPORTED), []);
    assert.deepEqual(provedOn({ kind: 'supported', proofs: [linux, PROOF, linux] }), ['windows', 'linux']);
    assert.deepEqual(provedOn({ kind: 'partial', missing: 'a', notice: 'b', proofs: [{ ...PROOF, os: 'macos' }] }), ['macos']);
    assert.deepEqual(provedOn(UNSUPPORTED), []);
  });
});

describe('a manifest', () => {
  it('answers for every feature of its side', () => {
    assert.deepEqual(manifestProblems('host', manifestOf('host')), []);
    assert.deepEqual(manifestProblems('connector', manifestOf('connector', UNSUPPORTED)), []);
    assert.equal(isManifest('host', manifestOf('host')), true);
  });

  it('is refused when a feature has no row', () => {
    const { 'hooks.pretool-guard': _dropped, ...rest } = manifestOf('host');
    assert.deepEqual(manifestProblems('host', rest), ['its manifest has no row for hooks.pretool-guard']);
    assert.equal(isManifest('host', rest), false);
  });

  it('is refused when a row is no support value, naming the row', () => {
    assert.deepEqual(manifestProblems('connector', manifestOf('connector', SUPPORTED, { 'tracker.comment': { kind: 'unsupported' } })), ['tracker.comment: an unsupported row needs a notice']);
  });

  it('is refused when it names a feature the registry lacks, one of the other side too', () => {
    assert.deepEqual(manifestProblems('host', manifestOf('host', SUPPORTED, { 'hooks.made-up': SUPPORTED, 'tracker.comment': SUPPORTED })), [
      'its manifest names hooks.made-up, which is no host feature',
      'its manifest names tracker.comment, which is no host feature',
    ]);
  });

  it('is refused when it is no object', () => {
    assert.deepEqual(manifestProblems('host', [SUPPORTED]), ['its manifest is not an object']);
    assert.deepEqual(manifestProblems('connector', undefined), ['its manifest is not an object']);
  });
});
