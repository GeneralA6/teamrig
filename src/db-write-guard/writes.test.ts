import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { dbWritesOf, describeDbWrite, type DbWriteContext, type DbWriteRules } from './writes.ts';

const APP = resolve('/', 'work', 'app');
const URI = 'docs://127.0.0.1:9000/app';
const DOC_FIX = "const { Client } = require('docstore');\nawait client.db().collection('rows').deleteMany({ stale: true });\n";
const DOC_READ = "const { Client } = require('docstore');\nconsole.log(await client.db().collection('rows').countDocuments());\n";

/** A team that adds a document shell, a key-value client and their Node clients to the built-in SQL clients. */
const RULES: DbWriteRules = {
  entrypoints: [],
  programs: [
    { name: 'docsh', reads: 'document-shell' },
    { name: 'kvcli', reads: 'key-value-cli' },
  ],
  nodeClients: [
    { module: 'docstore', vocabulary: 'document' },
    { module: 'kvstore', vocabulary: 'key-value' },
  ],
  clientReceivers: [],
};

const NO_RULES: DbWriteRules = { entrypoints: [], programs: [], nodeClients: [], clientReceivers: [] };

function context(files: Readonly<Record<string, string>> = {}, rules: Partial<DbWriteRules> = {}): DbWriteContext {
  return { cwd: APP, home: resolve('/', 'u'), dialect: 'bash', files: new MemoryFiles(files), rules: { ...RULES, ...rules } };
}

/** Each write the line makes, as the guard words it. */
async function writes(command: string, ctx: DbWriteContext = context()): Promise<string[]> {
  return (await dbWritesOf(command, ctx)).map(describeDbWrite);
}

describe('dbWritesOf', () => {
  it('finds the SQL writes of the built-in clients with no team rules, and nothing a team has not named', async () => {
    const ctx = context({ [join(APP, 'fix.cjs')]: DOC_FIX }, NO_RULES);
    assert.deepEqual(await writes('psql -c "DELETE FROM rows"; sqlite3 app.db "DROP TABLE rows"', ctx), ['psql runs DELETE', 'sqlite3 runs DROP']);
    assert.deepEqual(await writes('docsh --eval "db.orders.deleteMany({})"; kvcli FLUSHALL; node fix.cjs', ctx), []);
  });

  it("reads a team's program before a built-in of the same name, by the name a line runs", async () => {
    const ctx = context({}, { programs: [{ name: 'psql', reads: 'sql-execute' }, { name: 'Docsh.EXE', reads: 'document-shell' }] });
    assert.deepEqual(await writes("psql -c 'DROP TABLE rows'; psql -e 'DROP TABLE rows'", ctx), ['psql runs DROP']);
    assert.deepEqual(await writes('docsh --eval "db.a.drop()"', ctx), ['docsh runs drop']);
  });

  it('finds the writes a document shell evaluates, and none for a read', async () => {
    assert.deepEqual(await writes(`docsh ${URI} --quiet --eval "db.orders.countDocuments({})"`), []);
    assert.deepEqual(await writes(`docsh ${URI} --quiet --eval "db.orders.deleteMany({})"`), ['docsh runs deleteMany']);
    assert.deepEqual(await writes(`docsh ${URI} --quiet --eval "db.orders.updateOne({a:1},{$set:{b:2}})"`), ['docsh runs updateOne']);
    assert.deepEqual(await writes(`docsh ${URI} --quiet --eval "db.orders.aggregate([{$out:'x'}])"`), ['docsh runs $out']);
    assert.deepEqual(await writes(`docsh ${URI} --quiet --eval="db.orders.drop()"; docsh --eval 'db.a.find()'`), ['docsh runs drop']);
  });

  it('finds the writes of a command a container or a remote host runs', async () => {
    const exec = `kubectl exec -n ns deploy/api -- docsh ${URI} --quiet --eval`;
    assert.deepEqual(await writes(`${exec} "db.orders.find().limit(1)"`), []);
    assert.deepEqual(await writes(`${exec} "db.orders.deleteOne({})"`), ['docsh runs deleteOne in a container or on a remote host']);
    assert.deepEqual(await writes('kubectl exec -n ns deploy/kv -- kvcli FLUSHALL'), ['kvcli runs FLUSHALL in a container or on a remote host']);
    assert.deepEqual(await writes("docker exec -i db psql -U app -c 'TRUNCATE rows'; ssh host 'kvcli -n 2 DEL k'"), [
      'psql runs TRUNCATE in a container or on a remote host',
      'kvcli runs DEL in a container or on a remote host',
    ]);
    assert.deepEqual(await writes("kubectl exec -n ns deploy/api -- sh -c 'docsh --eval \"db.a.drop()\"'"), ['docsh runs drop in a container or on a remote host']);
  });

  it('reads the code a host hands a remote command on stdin, but not a file on the remote side', async () => {
    const ctx = context({ [join(APP, 'fix.js')]: 'db.rows.deleteMany({})' });
    assert.deepEqual(await writes('kubectl exec -i -n ns deploy/api -- docsh < fix.js', ctx), ['docsh runs deleteMany in a container or on a remote host']);
    assert.deepEqual(await writes('kubectl exec -n ns deploy/api -- docsh fix.js', ctx), []);
  });

  it('reads document-shell code from a file it runs, a redirect, a here-document or a pipe', async () => {
    const ctx = context({ [join(APP, 'fix.js')]: 'db.rows.deleteMany({})', [join(APP, 'read.js')]: 'db.rows.find()' });
    assert.deepEqual(await writes(`docsh ${URI} fix.js; docsh --file fix.js; docsh ${URI} read.js; docsh missing.js`, ctx), [
      'docsh runs deleteMany',
      'docsh runs deleteMany',
    ]);
    assert.deepEqual(await writes(`docsh ${URI} < fix.js; cat fix.js | docsh ${URI}; cat read.js | docsh`, ctx), ['docsh runs deleteMany', 'docsh runs deleteMany']);
    assert.deepEqual(await writes(`docsh ${URI} <<'EOF'\ndb.rows.insertOne({})\nEOF`), ['docsh runs insertOne']);
    assert.deepEqual(await writes(`echo 'db.rows.drop()' | docsh ${URI}; echo 'db.rows.find()' | docsh`), ['docsh runs drop']);
  });

  it('finds the command a key-value client runs, a Lua script it evaluates, and the commands piped to it', async () => {
    assert.deepEqual(await writes('kvcli -h 127.0.0.1 DEL queue:x; kvcli -h 127.0.0.1 -p 7000 GET k; kvcli SCAN 0; kvcli TTL k; kvcli XLEN s'), ['kvcli runs DEL']);
    assert.deepEqual(await writes(`kvcli EVAL "return kv.call('GET', KEYS[1])" 1 k; kvcli EVAL "kv.call('DEL', KEYS[1])" 1 k`), ['kvcli runs DEL']);
    const ctx = context({ [join(APP, 'cmds.txt')]: 'GET a\nUNLINK b\n', [join(APP, 'trim.lua')]: "kv.call('XTRIM', KEYS[1], 'MAXLEN', 10)" });
    assert.deepEqual(await writes("printf 'GET a\\nSET b 1\\n' | kvcli; cat cmds.txt | kvcli --pipe; kvcli --eval trim.lua del , 1", ctx), [
      'kvcli runs SET',
      'kvcli runs UNLINK',
      'kvcli runs XTRIM',
    ]);
  });

  it('finds the SQL writes psql, mysql and sqlite3 run, and none for a read', async () => {
    const ctx = context({ [join(APP, 'fix.sql')]: 'UPDATE rows SET a = 1;' });
    assert.deepEqual(await writes("psql -c 'DROP TABLE rows'; psql --command='SELECT 1'; psql -f fix.sql; psql -c \"SELECT count(*) FROM rows\"", ctx), [
      'psql runs DROP',
      'psql runs UPDATE',
    ]);
    assert.deepEqual(await writes("mysql -e'DELETE FROM rows'; mysql --execute='SELECT 1'; mysql app < fix.sql", ctx), ['mysql runs DELETE', 'mysql runs UPDATE']);
    assert.deepEqual(await writes("sqlite3 -cmd '.mode csv' app.db 'ALTER TABLE rows ADD a'; sqlite3 app.db 'SELECT 1'"), ['sqlite3 runs ALTER']);
  });

  it('finds the client writes of code node, tsx or ts-node evaluates or runs', async () => {
    const ctx = context({ [join(APP, 'scratchpad', 'fix-rows.cjs')]: DOC_FIX, [join(APP, 'read.cjs')]: DOC_READ, [join(APP, 'plain.js')]: 'rows.deleteMany()' });
    assert.deepEqual(await writes(`node -e "require('docstore')"`), []);
    assert.deepEqual(await writes(`node -e "const r = new (require('kvstore'))(); r.flushall()"`), ['node -e runs flushall']);
    assert.deepEqual(await writes('node scratchpad/fix-rows.cjs; node read.cjs; node plain.js; node missing.cjs', ctx), ['node scratchpad/fix-rows.cjs runs deleteMany']);
    assert.deepEqual(await writes('npx -y tsx scratchpad/fix-rows.cjs; ts-node -P tsconfig.json scratchpad/fix-rows.cjs', ctx), [
      'tsx scratchpad/fix-rows.cjs runs deleteMany',
      'ts-node scratchpad/fix-rows.cjs runs deleteMany',
    ]);
    assert.deepEqual(await writes(`node - <<'EOF'\nimport('docstore').then(() => Model.create({}))\nEOF`), ['node runs create']);
  });

  it('reads no script under a test run or a syntax check, and none whose path is only known when it runs', async () => {
    const ctx = context({ [join(APP, 'scratchpad', 'fix-rows.cjs')]: DOC_FIX });
    assert.deepEqual(await writes('node --test scratchpad/fix-rows.cjs; node --check scratchpad/fix-rows.cjs; node "$SCRIPT"', ctx), []);
  });

  it('lets an entrypoint run without its apply flag, and finds it with one, whatever its code holds', async () => {
    const ctx = context({ [join(APP, 'scripts', 'backfill.ts')]: DOC_FIX }, { entrypoints: [{ path: 'scripts/backfill.ts', applyFlags: ['--apply'] }] });
    assert.deepEqual(await writes('tsx scripts/backfill.ts --dry-run; node ./scripts/backfill.ts', ctx), []);
    assert.deepEqual(await writes(`tsx scripts/backfill.ts --apply; node '${join(APP, 'scripts', 'backfill.ts')}' --apply=yes`, ctx), [
      'tsx scripts/backfill.ts runs with --apply',
      `node ${join(APP, 'scripts', 'backfill.ts')} runs with --apply`,
    ]);
  });

  it('reads a PowerShell line', async () => {
    assert.deepEqual(await writes("docsh --eval 'db.a.drop()'; kvcli GET k", { ...context(), dialect: 'powershell' }), ['docsh runs drop']);
  });
});
