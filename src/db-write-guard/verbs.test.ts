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

/** Every write method of the document shell, each of which a spec must read as a write. */
const SHELL_WRITE_METHODS = [
  'insert', 'insertOne', 'insertMany', 'update', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'remove', 'save', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'findAndModify', 'bulkWrite', 'drop',
  'dropDatabase', 'dropIndexes', 'dropIndex', 'dropSearchIndex', 'renameCollection', 'createIndex', 'createIndexes',
  'createCollection', 'runCommand', 'adminCommand',
];

/** Every write method of a Node document client. */
const CLIENT_WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'save',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'findOneAndRemove', 'findByIdAndUpdate',
  'findByIdAndReplace', 'findByIdAndDelete', 'findByIdAndRemove', 'bulkWrite', 'drop', 'dropDatabase', 'dropIndexes',
  'dropIndex', 'dropSearchIndex', 'dropCollection', 'renameCollection', 'createIndex', 'createIndexes',
  'createCollection',
];

/** Every key-value command that changes stored data. */
const KEY_VALUE_WRITE_COMMANDS = `APPEND BITOP BLMOVE COPY DECR DECRBY DEL EVAL EVALSHA EXPIRE EXPIREAT FCALL FLUSHALL FLUSHDB
  GEOADD GETDEL GETEX GETSET HDEL HINCRBY HINCRBYFLOAT HMSET HSET HSETNX INCR INCRBY INCRBYFLOAT JSON.DEL JSON.SET LINSERT
  LMOVE LPOP LPUSH LPUSHX LREM LSET LTRIM MIGRATE MOVE MSET MSETNX PERSIST PEXPIRE PEXPIREAT PFADD PFMERGE PSETEX RENAME
  RENAMENX RESTORE RPOP RPOPLPUSH RPUSH RPUSHX SADD SDIFFSTORE SET SETBIT SETEX SETNX SETRANGE SINTERSTORE SMOVE SPOP SREM
  SUNIONSTORE SWAPDB UNLINK XACK XADD XAUTOCLAIM XCLAIM XDEL XGROUP XSETID XTRIM ZADD ZDIFFSTORE ZINCRBY ZINTERSTORE
  ZPOPMAX ZPOPMIN ZRANGESTORE ZREM ZREMRANGEBYLEX ZREMRANGEBYRANK ZREMRANGEBYSCORE ZUNIONSTORE`.split(/\s+/);

/** Every SQL statement that writes, with a statement that starts with it. */
const SQL_WRITE_STATEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['INSERT', 'INSERT INTO t VALUES (1)'],
  ['UPDATE', 'UPDATE t SET a = 1'],
  ['DELETE', 'DELETE FROM t'],
  ['DROP', 'DROP TABLE t'],
  ['TRUNCATE', 'TRUNCATE t'],
  ['ALTER', 'ALTER TABLE t ADD COLUMN a int'],
  ['CREATE', 'CREATE TABLE t (a int)'],
  ['GRANT', 'GRANT SELECT ON t TO r'],
  ['REVOKE', 'REVOKE SELECT ON t FROM r'],
  ['REPLACE', 'REPLACE INTO t VALUES (1)'],
  ['MERGE', 'MERGE INTO t USING u ON (1 = 1)'],
];

describe('documentShellWritesIn', () => {
  it('names every write method of the shell', () => {
    for (const method of SHELL_WRITE_METHODS) {
      assert.deepEqual(documentShellWritesIn(`db.a.${method}({})`), [method], method);
    }
  });

  it('reads a writing stage only as a whole word, so an operator that starts like one is a read', () => {
    assert.deepEqual(documentShellWritesIn("db.a.aggregate([{ $project: { x: { $mergeObjects: ['$a', '$b'] } } }])"), []);
  });

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
  it('names every write method of a document client', () => {
    for (const method of CLIENT_WRITE_METHODS) {
      assert.deepEqual(clientWritesIn(`import s from 'docstore'; await c.${method}({})`, DOCUMENT), [method], method);
    }
  });

  it("reads Object.create as no model's create", () => {
    assert.deepEqual(clientWritesIn("import s from 'docstore'; const o = Object.create(null)", DOCUMENT), []);
  });

  it('counts a name other objects share on none of their receivers, nor on a call with no named receiver', () => {
    const code = [
      "import Kv from 'kvstore'",
      "params.append('a', '1')",
      'fs.copy(a, b)',
      'sandbox.eval(s)',
      'fs.move(a, b)',
      'backup.restore()',
      'fs.unlink(p)',
      'fs.rename(a, b)',
      'map.set(k, 1)',
      'new Map().set(k, 1)',
    ].join('; ');
    assert.deepEqual(clientWritesIn(code, KEY_VALUE), []);
  });

  it('names a write called on a chained call, which has no named receiver', () => {
    assert.deepEqual(clientWritesIn("import Kv from 'kvstore'; await kv.multi().del(k).exec()", KEY_VALUE), ['del']);
  });

  it("matches a team's receiver word in any case", () => {
    assert.deepEqual(clientWritesIn("import Kv from 'kvstore'; await cache.set(k, 1)", { ...KEY_VALUE, clientReceivers: ['Cache'] }), ['set']);
  });

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

  it('reads a receiver that starts with a $ whole', () => {
    assert.deepEqual(clientWritesIn("import Kv from 'kvstore'; await $client.set(k, 1); a.b$.rename(x, y)", KEY_VALUE), ['set']);
  });

  it('reads past a 64 KiB run of name characters with $ in it, which calls nothing, within two seconds', () => {
    const code = "import Kv from 'kvstore'; " + 'a$'.repeat(32768) + '; await client.del(k)';
    const started = performance.now();
    assert.deepEqual(clientWritesIn(code, KEY_VALUE), ['del']);
    assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
  });
});

describe('keyValueCommandWritesIn', () => {
  it('names the write commands of a command stream, one a line, upper case', () => {
    assert.deepEqual(keyValueCommandWritesIn('GET a\ndel b\r\n  FLUSHDB\nscan 0\nDEL c'), ['DEL', 'FLUSHDB']);
    assert.deepEqual(keyValueCommandWritesIn('GET a\nTTL a\nXLEN s'), []);
  });

  it('names every key-value write command', () => {
    for (const command of KEY_VALUE_WRITE_COMMANDS) {
      assert.deepEqual(keyValueCommandWritesIn(`${command} k`), [command], command);
    }
  });
});

describe('luaWritesIn', () => {
  it("names the writes a Lua script makes through its host's call or pcall", () => {
    assert.deepEqual(luaWritesIn("kv.call('GET', KEYS[1]); kv.pcall(\"del\", KEYS[1])"), ['DEL']);
    assert.deepEqual(luaWritesIn("return kv.call('GET', KEYS[1])"), []);
  });

  it('names a dotted command', () => {
    assert.deepEqual(luaWritesIn("kv.call('JSON.SET', KEYS[1], '$', ARGV[1])"), ['JSON.SET']);
  });
});

describe('sqlWritesIn', () => {
  it('names every writing statement', () => {
    for (const [keyword, statement] of SQL_WRITE_STATEMENTS) {
      assert.deepEqual(sqlWritesIn(statement), [keyword], keyword);
    }
  });

  it('names the writing statements, upper case, and none for a read', () => {
    assert.deepEqual(sqlWritesIn('delete from t where a = 1; DROP TABLE u; insert into v values (1)'), ['DELETE', 'DROP', 'INSERT']);
    assert.deepEqual(sqlWritesIn('REPLACE INTO t VALUES (1); MERGE INTO u USING v ON (1=1)'), ['REPLACE', 'MERGE']);
    assert.deepEqual(sqlWritesIn("SELECT replace(name, 'a', 'b'), created_at, updated FROM t ORDER BY updated_at"), []);
  });
});
