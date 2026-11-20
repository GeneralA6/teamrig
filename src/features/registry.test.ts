import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { isRecord } from '../core/guards.ts';
import { CONNECTOR_FEATURES, HOST_FEATURES, TERMINAL_FEATURES, featuresOf, isConnectorFeatureId, isConnectorKind, isHostFeatureId, isTerminalFeatureId, type FeatureSide } from './registry.ts';

const SIDES: readonly FeatureSide[] = ['host', 'connector', 'terminal'];

interface GroupFile {
  readonly group: string;
  /** The ids of the rows the file exports, in the file's order. */
  readonly ids: readonly string[];
}

/** What each group's file under `<side>/` exports, read from the folder itself, so a file the registry forgot shows. */
async function groupFilesOf(side: FeatureSide): Promise<readonly GroupFile[]> {
  const folder = new URL(`./${side}/`, import.meta.url);
  const names = readdirSync(folder).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  return Promise.all(
    names.map(async (name) => {
      const exported: unknown = await import(new URL(name, folder).href);
      assert.ok(isRecord(exported), name);
      const tables = Object.values(exported);
      assert.equal(tables.length, 1, `${side}/${name} exports its group's rows and nothing else`);
      const [rows] = tables;
      assert.ok(isRecord(rows), name);
      return { group: name.slice(0, -'.ts'.length), ids: Object.keys(rows) };
    }),
  );
}

describe('the feature registry', () => {
  for (const side of SIDES) {
    it(`takes every ${side} row from the file named after its group`, async () => {
      const files = await groupFilesOf(side);
      const groups = [...new Set(featuresOf(side).map((row) => row.group))];
      assert.deepEqual(files.map((file) => file.group).sort(), [...groups].sort());
      for (const file of files) {
        const registered = featuresOf(side).filter((row) => row.group === file.group).map((row) => row.id);
        assert.ok(file.ids.length > 0, file.group);
        assert.deepEqual(file.ids, registered, file.group);
      }
    });
  }

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
      ['rules', 'inbox', 'context', 'hooks', 'permissions', 'sessions', 'tabs', 'wake', 'skills', 'helpers', 'plugin', 'budget', 'errors', 'os'],
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

  it('holds a terminal row for each request of the terminal protocol, one for a named window and one for what a terminal sees of a draft', () => {
    assert.deepEqual(
      featuresOf('terminal').map((row) => row.id),
      ['pane.open', 'pane.window', 'pane.focus', 'pane.close', 'pane.restart', 'pane.rename', 'pane.deliver', 'pane.is-idle', 'pane.list', 'pane.sees-draft'],
    );
    for (const row of featuresOf('terminal')) {
      assert.equal(row.group, 'pane', row.id);
    }
  });

  it('tells the ids of one side from any other text', () => {
    assert.equal(isTerminalFeatureId('pane.deliver'), true);
    assert.equal(isTerminalFeatureId('tabs.title-status'), false);
    assert.equal(isTerminalFeatureId('valueOf'), false);
    assert.equal(isHostFeatureId('pane.deliver'), false);
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
    assert.deepEqual(featuresOf('terminal').map((row) => row.id), Object.keys(TERMINAL_FEATURES));
  });
});
