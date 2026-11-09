import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientVocabulariesIn,
  clientWritesIn,
  documentShellWritesIn,
  keyValueCommandWritesIn,
  luaWritesIn,
  sqlWritesIn,
  type ClientRules,
} from './verbs.ts';

const DOCUMENT: ClientRules = { nodeClients: [{ module: 'docstore', vocabulary: 'document' }], clientReceivers: [] };
const KEY_VALUE: ClientRules = { nodeClients: [{ module: 'kvstore', vocabulary: 'key-value' }], clientReceivers: [] };
const NONE: ClientRules = { nodeClients: [], clientReceivers: [] };

describe('documentShellWritesIn', () => {
  it('names each write method and writing stage once', () => {
    assert.deepEqual(documentShellWritesIn('db.a.deleteMany({}); db.b.updateOne({a:1},{$set:{b:2}}); db.a.deleteMany({x:1})'), ['deleteMany', 'updateOne']);
    assert.deepEqual(documentShellWritesIn("db.a.aggregate([{$match:{}},{$out:'x'}]); db.b.aggregate([{ $merge: { into: 'y' } }])"), ['$out', '$merge']);
    assert.deepEqual(documentShellWritesIn('db.a.drop(); db.dropDatabase(); db.a.renameCollection("b"); db.a.createIndex({ a: 1 })'), [
      'drop',
      'dropDatabase',
      'renameCollection',
      'createIndex',
    ]);
    assert.deepEqual(documentShellWritesIn('db.a.update({}, {}); db.a.insert({}); db.a.remove({}); db.runCommand({ compact: "a" })'), ['update', 'insert', 'remove', 'runCommand']);
  });

  it('names none for reads', () => {
    const reads = 'db.orders.countDocuments({}); db.orders.find({ a: 1 }).limit(1); db.a.aggregate([{ $group: { _id: 1 } }]); db.a.getIndexes(); db.a.findOne()';
    assert.deepEqual(documentShellWritesIn(reads), []);
  });
});

describe('clientVocabulariesIn', () => {
  it('names the vocabulary of each team client the code loads, by its module or a path under it', () => {
    const rules: ClientRules = { nodeClients: [...DOCUMENT.nodeClients, ...KEY_VALUE.nodeClients], clientReceivers: [] };
    assert.deepEqual(clientVocabulariesIn("const s = require('docstore'); import k from 'kvstore/promise'", rules), ['document', 'key-value']);
    assert.deepEqual(clientVocabulariesIn("const m = await import('docstore/lib/x'); import 'kvstore'", rules), ['document', 'key-value']);
  });

  it('names none for a module whose name only starts like a client, nor for code that loads none', () => {
    assert.deepEqual(clientVocabulariesIn("import { x } from 'docstore-memory-server'; require('fs')", DOCUMENT), []);
    assert.deepEqual(clientVocabulariesIn("import s from 'docstore'", NONE), []);
  });
});

describe('clientWritesIn', () => {
  it('names no write in code that loads no team client, whatever its calls', () => {
    assert.deepEqual(clientWritesIn("const fs = require('fs'); rows.deleteMany()", DOCUMENT), []);
    assert.deepEqual(clientWritesIn("import { x } from 'docstore-memory-server'; await c.deleteMany({})", DOCUMENT), []);
    assert.deepEqual(clientWritesIn("const s = require('docstore'); await c.deleteMany({}); await client.del(k)", NONE), []);
  });

  it('names the document writes of code that loads a document client', () => {
    assert.deepEqual(clientWritesIn("const { Client } = require('docstore'); await db.collection('a').deleteMany({}); await c.find().toArray()", DOCUMENT), ['deleteMany']);
    assert.deepEqual(clientWritesIn("import store from 'docstore'; await Model.create({}); Object.create(null); await doc.save()", DOCUMENT), ['save', 'create']);
    assert.deepEqual(clientWritesIn("const m = await import('docstore'); await c.aggregate([{ $merge: 'b' }]).toArray()", DOCUMENT), ['$merge']);
  });

  it('reads a document vocabulary only for a document client, and a key-value one only for a key-value client', () => {
    assert.deepEqual(clientWritesIn("import k from 'kvstore'; await c.deleteMany({}); await kv.hset(k, f, v)", KEY_VALUE), ['hset']);
    assert.deepEqual(clientWritesIn("import s from 'docstore'; await c.deleteMany({}); await kv.hset(k, f, v)", DOCUMENT), ['deleteMany']);
  });

  it("names a key-value client's writes, and a name other objects share only on a receiver named like a client", () => {
    const code = "import Kv from 'kvstore'; await this.kv.del(k); await kv.set(k, 1); map.set(k, 1); fs.unlink(p); await cacheClient.unlink(k); await client.json.set(k, '$', {})";
    assert.deepEqual(clientWritesIn(code, KEY_VALUE), ['del', 'unlink', 'json.set']);
    assert.deepEqual(clientWritesIn("const { createClient } = require('kvstore'); await client.hSet(k, f, v); await client.flushAll(); await client.get(k)", KEY_VALUE), ['hSet', 'flushAll']);
  });

  it("counts a shared name on a receiver holding a team's word, in any case", () => {
    const code = "import Kv from 'kvstore'; await this.CacheConn.set(k, 1); await store.rename(a, b); map.set(k, 1)";
    assert.deepEqual(clientWritesIn(code, { ...KEY_VALUE, clientReceivers: ['cache'] }), ['set']);
    assert.deepEqual(clientWritesIn(code, KEY_VALUE), []);
  });

  it('names none for code that only reads through a client', () => {
    assert.deepEqual(clientWritesIn("import Kv from 'kvstore'; await client.get(k); await client.scan(0); await client.ttl(k); await client.xlen(s)", KEY_VALUE), []);
  });
});

describe('keyValueCommandWritesIn', () => {
  it('names the write commands of a command stream, one a line, upper case', () => {
    assert.deepEqual(keyValueCommandWritesIn('GET a\ndel b\r\n  FLUSHDB\nscan 0\nDEL c'), ['DEL', 'FLUSHDB']);
    assert.deepEqual(keyValueCommandWritesIn('GET a\nTTL a\nXLEN s'), []);
  });
});

describe('luaWritesIn', () => {
  it("names the writes a Lua script makes through its host's call or pcall", () => {
    assert.deepEqual(luaWritesIn("kv.call('GET', KEYS[1]); kv.pcall(\"del\", KEYS[1])"), ['DEL']);
    assert.deepEqual(luaWritesIn("return kv.call('GET', KEYS[1])"), []);
  });
});

describe('sqlWritesIn', () => {
  it('names the writing statements, upper case, and none for a read', () => {
    assert.deepEqual(sqlWritesIn('delete from t where a = 1; DROP TABLE u; insert into v values (1)'), ['DELETE', 'DROP', 'INSERT']);
    assert.deepEqual(sqlWritesIn('REPLACE INTO t VALUES (1); MERGE INTO u USING v ON (1=1)'), ['REPLACE', 'MERGE']);
    assert.deepEqual(sqlWritesIn("SELECT replace(name, 'a', 'b'), created_at, updated FROM t ORDER BY updated_at"), []);
  });
});
