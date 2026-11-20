import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { namedOnly } from './named-keys.ts';
import { definitionsOf, settingNodes } from './settings.ts';

const NONE: JsonRecord = {};

describe('namedOnly', () => {
  it('leaves a scalar as it is, whatever the schema says', () => {
    for (const value of ['text', 7, true, null]) {
      assert.equal(namedOnly(value, { type: 'string' }, NONE), value);
      assert.equal(namedOnly(value, { type: 'object', properties: { a: {} } }, NONE), value);
    }
  });

  it('keeps the keys an object schema names and drops every other', () => {
    const node = { type: 'object', properties: { name: { type: 'string' }, size: { type: 'integer' } } };
    assert.deepEqual(namedOnly({ name: 'a', size: 2, note: 'mine', extra: { deep: 1 } }, node, NONE), { name: 'a', size: 2 });
  });

  it('walks into a named key with that key own schema', () => {
    const node = {
      properties: { inner: { type: 'object', properties: { kept: { type: 'string' } } } },
    };
    assert.deepEqual(namedOnly({ inner: { kept: 'a', dropped: 'b' }, dropped: 1 }, node, NONE), { inner: { kept: 'a' } });
  });

  it('keeps every key of a map whose additionalProperties give a schema, each walked by it', () => {
    const node = { type: 'object', additionalProperties: { type: 'object', properties: { model: { type: 'string' } } } };
    assert.deepEqual(namedOnly({ alpha: { model: 'opus', mine: 1 }, bravo: { model: 'sonnet' } }, node, NONE), {
      alpha: { model: 'opus' },
      bravo: { model: 'sonnet' },
    });
  });

  it('takes a named key by its own schema, not by the map schema beside it', () => {
    const node = {
      properties: { fixed: { type: 'object', properties: { a: {} } } },
      additionalProperties: { type: 'object', properties: { b: {} } },
    };
    assert.deepEqual(namedOnly({ fixed: { a: 1, b: 2 }, other: { a: 1, b: 2 } }, node, NONE), { fixed: { a: 1 }, other: { b: 2 } });
  });

  it('drops the keys of an object whose additionalProperties are true, false or not stated', () => {
    for (const node of [{ type: 'object', additionalProperties: true }, { type: 'object', additionalProperties: false }, { type: 'object' }, {}]) {
      assert.deepEqual(namedOnly({ any: 'word', more: { deep: 1 } }, node, NONE), {});
    }
  });

  it('keeps every element of an array, each walked by items', () => {
    const node = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } };
    assert.deepEqual(namedOnly([{ id: 'a', mine: 1 }, 'text', { other: 2 }], node, NONE), [{ id: 'a' }, 'text', {}]);
    assert.deepEqual(namedOnly(['a', 'b'], { type: 'array', items: { type: 'string' } }, NONE), ['a', 'b']);
  });

  it('empties the objects of an array whose schema states no items, and keeps its scalars', () => {
    assert.deepEqual(namedOnly(['a', { any: 1 }, [{ deep: 1 }, 2]], { type: 'array' }, NONE), ['a', {}, [{}, 2]]);
  });

  it('resolves a $ref, at the node and under it', () => {
    const definitions = {
      launch: { type: 'object', properties: { model: { type: 'string' } } },
      launches: { type: 'object', additionalProperties: { $ref: '#/$defs/launch' } },
    };
    assert.deepEqual(namedOnly({ alpha: { model: 'opus', mine: 1 } }, { $ref: '#/$defs/launches' }, definitions), { alpha: { model: 'opus' } });
    assert.deepEqual(namedOnly({ alpha: { model: 'opus' } }, { $ref: '#/$defs/missing' }, definitions), {});
  });

  it('keeps a key any anyOf shape names, walked by every shape that names it', () => {
    const node = {
      anyOf: [
        { enum: ['team'] },
        { type: 'object', properties: { a: { type: 'object', properties: { x: {} } } } },
        { type: 'object', properties: { a: { type: 'object', properties: { y: {} } }, b: {} } },
        { type: 'array', items: { type: 'object', properties: { id: {} } } },
      ],
    };
    assert.equal(namedOnly('team', node, NONE), 'team');
    assert.deepEqual(namedOnly({ a: { x: 1, y: 2, z: 3 }, b: 4, c: 5 }, node, NONE), { a: { x: 1, y: 2 }, b: 4 });
    assert.deepEqual(namedOnly([{ id: 'a', mine: 1 }], node, NONE), [{ id: 'a' }]);
  });

  it('reads an anyOf nested in an anyOf, and one a $ref leads to', () => {
    const definitions = { shapes: { anyOf: [{ properties: { a: {} } }, { anyOf: [{ properties: { b: {} } }] }] } };
    assert.deepEqual(namedOnly({ a: 1, b: 2, c: 3 }, { $ref: '#/$defs/shapes' }, definitions), { a: 1, b: 2 });
  });

  it('ends on a definition whose anyOf leads back to itself', () => {
    const definitions = { loop: { anyOf: [{ $ref: '#/$defs/loop' }, { properties: { a: {} } }] } };
    assert.deepEqual(namedOnly({ a: 1, b: 2 }, { $ref: '#/$defs/loop' }, definitions), { a: 1 });
  });

  it('takes no key for named that only every object carries, and keeps a named __proto__ as data', () => {
    const node = { type: 'object', properties: { name: {} } };
    const value: unknown = JSON.parse('{"name":"a","constructor":{"x":1},"toString":"t","__proto__":{"polluted":true}}');
    const kept = namedOnly(value, node, NONE);
    assert.deepEqual(kept, { name: 'a' });
    assert.equal(Object.getPrototypeOf(kept), Object.prototype);

    const named: unknown = JSON.parse('{"properties":{"__proto__":{"type":"object","properties":{"a":{}}}}}');
    assert.ok(isRecord(named));
    const own = namedOnly(JSON.parse('{"__proto__":{"a":1,"b":2}}'), named, NONE);
    assert.ok(isRecord(own));
    assert.deepEqual(Object.keys(own), ['__proto__']);
    assert.deepEqual(own['__proto__'], { a: 1 });
    assert.equal(Object.getPrototypeOf(own), Object.prototype);
  });

  it('returns a new value and leaves the one given untouched', () => {
    const value = { name: 'a', list: [{ id: 1, mine: 2 }], mine: 3 };
    const node = { properties: { name: {}, list: { type: 'array', items: { properties: { id: {} } } } } };
    assert.deepEqual(namedOnly(value, node, NONE), { name: 'a', list: [{ id: 1 }] });
    assert.deepEqual(value, { name: 'a', list: [{ id: 1, mine: 2 }], mine: 3 });
  });
});

describe('namedOnly over the shipped schema', async () => {
  const schema: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8'));
  assert.ok(isRecord(schema));
  const definitions = definitionsOf(schema);
  const defaults = [...settingNodes(schema)].filter(([, node]) => node['default'] !== undefined);

  it('gives every default back unchanged: the schema names each key its own defaults use', () => {
    assert.ok(defaults.length > 100, `only ${String(defaults.length)} defaults read`);
    for (const [path, node] of defaults) {
      assert.deepEqual(namedOnly(node['default'], node, definitions), node['default'], path);
    }
  });

  it('keeps the two shapes of a role holders list, and a launch entry by its named keys', () => {
    const nodes = settingNodes(schema);
    const launch = nodes.get('launch');
    assert.ok(launch !== undefined);
    assert.deepEqual(namedOnly({ alpha: { model: 'opus', effort: 'high', mine: 'x' } }, launch, definitions), {
      alpha: { model: 'opus', effort: 'high' },
    });
    const roles = nodes.get('serviceRoles');
    assert.ok(roles !== undefined);
    assert.deepEqual(namedOnly({ closer: { holders: 'team', mine: 1 }, merger: { holders: ['alpha'] } }, roles, definitions), {
      closer: { holders: 'team' },
      merger: { holders: ['alpha'] },
    });
  });
});
