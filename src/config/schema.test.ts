import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { parseConfig } from './parse.ts';

/** The roster has no default; everything else in the schema must state the code's default. */
const ROSTER = { sessions: ['alpha', 'bravo'], roles: { lead: 'alpha' } };
const ROSTER_KEYS = new Set(['sessions', 'roles']);

/** Sets every optional key, so walking it visits every key the parser reads. */
const EVERY_KEY = {
  ...ROSTER,
  roles: { lead: 'alpha', coordinatorOwner: 'bravo' },
  register: { goalPattern: '^G\\d+$' },
  coordinator: { schedule: { heavyCutoffUtc: '22:30' } },
  paths: { state: '/s', inbox: '/i', skills: '/k' },
};

async function loadSchema(): Promise<JsonRecord> {
  const schema: unknown = JSON.parse(
    await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8'),
  );
  assert.ok(isRecord(schema));
  return schema;
}

/** The parsed config as plain JSON, so it can be walked like the schema. */
function asJson(raw: JsonRecord): JsonRecord {
  const { config, issues } = parseConfig(raw);
  assert.deepEqual(issues, []);
  const json: unknown = JSON.parse(JSON.stringify(config));
  assert.ok(isRecord(json));
  return json;
}

function properties(schema: JsonRecord): JsonRecord {
  const value = schema['properties'];
  return isRecord(value) ? value : {};
}

/** Every key of the parsed config, with its value and its schema node. */
function* walkConfig(config: JsonRecord, schema: JsonRecord, path: string): Generator<[string, unknown, JsonRecord | undefined]> {
  for (const [key, value] of Object.entries(config)) {
    const node = properties(schema)[key];
    const keyPath = path === '' ? key : `${path}.${key}`;
    yield [keyPath, value, isRecord(node) ? node : undefined];
    if (isRecord(value) && isRecord(node)) {
      yield* walkConfig(value, node, keyPath);
    }
  }
}

/** Every schema property that declares a default, with the matching parsed value. */
function* walkDefaults(schema: JsonRecord, config: JsonRecord | undefined, path: string): Generator<[string, unknown, unknown]> {
  for (const [key, node] of Object.entries(properties(schema))) {
    if (!isRecord(node)) {
      continue;
    }
    const keyPath = path === '' ? key : `${path}.${key}`;
    const value = config?.[key];
    if ('default' in node) {
      yield [keyPath, node['default'], value];
    }
    yield* walkDefaults(node, isRecord(value) ? value : undefined, keyPath);
  }
}

describe('config.schema.json', () => {
  it('describes every key the parser produces', async () => {
    const schema = await loadSchema();
    const missing = [...walkConfig(asJson(EVERY_KEY), schema, '')].filter(([, , node]) => node === undefined).map(([path]) => path);
    assert.deepEqual(missing, []);
  });

  it('states the code default for every key outside the roster', async () => {
    const schema = await loadSchema();
    for (const [path, value, node] of walkConfig(asJson(ROSTER), schema, '')) {
      if (ROSTER_KEYS.has(path.split('.')[0] ?? '') || isRecord(value)) {
        continue;
      }
      assert.ok(node !== undefined && 'default' in node, `${path} has no default in the schema`);
      assert.deepEqual(node['default'], value, path);
    }
  });

  it('declares no default the code does not apply', async () => {
    const schema = await loadSchema();
    for (const [path, declared, applied] of walkDefaults(schema, asJson(ROSTER), '')) {
      assert.deepEqual(declared, applied, path);
    }
  });

  it('requires exactly the roster', async () => {
    const schema = await loadSchema();
    assert.deepEqual(schema['required'], ['sessions', 'roles']);
  });
});
