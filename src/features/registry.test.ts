import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_FEATURES, HOST_FEATURES, featuresOf, isConnectorFeatureId, isConnectorKind, isHostFeatureId, type FeatureSide } from './registry.ts';

const SIDES: readonly FeatureSide[] = ['host', 'connector'];

describe('the feature registry', () => {
  it('holds the rows the host and connector studies seeded', () => {
    assert.equal(featuresOf('host').length, 49);
    assert.equal(featuresOf('connector').length, 25);
  });

  it('names every feature by a dotted lower-case id that no other row has', () => {
    const ids = SIDES.flatMap((side) => featuresOf(side).map((row) => row.id));
    for (const id of ids) {
      assert.match(id, /^[a-z]+\.[a-z]+(-[a-z]+)*$/);
    }
    assert.equal(new Set(ids).size, ids.length);
  });

  it('gives every row a one-line doc a Markdown table cell can hold', () => {
    for (const row of SIDES.flatMap((side) => featuresOf(side))) {
      assert.ok(row.doc.length > 0 && row.doc.length <= 100, row.id);
      assert.doesNotMatch(row.doc, /[|\n]/, row.id);
    }
  });

  it('groups a host row by the part of its id before the dot', () => {
    assert.deepEqual(
      [...new Set(featuresOf('host').map((row) => row.group))],
      ['rules', 'inbox', 'context', 'hooks', 'permissions', 'sessions', 'tabs', 'wake', 'skills', 'helpers', 'plugin', 'budget', 'os'],
    );
    for (const row of featuresOf('host')) {
      assert.ok(row.id.startsWith(`${row.group}.`), row.id);
    }
  });

  it('starts a connector id with the kind of connector it needs', () => {
    assert.deepEqual([...new Set(featuresOf('connector').map((row) => row.group))], ['tracker', 'codehost']);
    for (const row of featuresOf('connector')) {
      assert.ok(row.id.startsWith(`${row.group}.`), row.id);
    }
  });

  it('tells the ids of one side from any other text', () => {
    assert.equal(isHostFeatureId('hooks.pretool-guard'), true);
    assert.equal(isHostFeatureId('tracker.comment'), false);
    assert.equal(isHostFeatureId('toString'), false);
    assert.equal(isConnectorFeatureId('tracker.comment'), true);
    assert.equal(isConnectorFeatureId('hooks.pretool-guard'), false);
    assert.equal(isConnectorFeatureId('constructor'), false);
  });

  it('knows the two kinds of connector', () => {
    assert.equal(isConnectorKind('tracker'), true);
    assert.equal(isConnectorKind('codehost'), true);
    assert.equal(isConnectorKind('host'), false);
    assert.equal(isConnectorKind(undefined), false);
  });

  it('lists the rows in the order the tables hold them', () => {
    assert.deepEqual(featuresOf('host').map((row) => row.id), Object.keys(HOST_FEATURES));
    assert.deepEqual(featuresOf('connector').map((row) => row.id), Object.keys(CONNECTOR_FEATURES));
  });
});
