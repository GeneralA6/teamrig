import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
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

  it("reads a named file's first MiB only, and never a file on a network share", async () => {
    const padding = `-- ${'x'.repeat(1024 * 1024)}\n`;
    const ctx = context({ [join(APP, 'head.sql')]: `DELETE FROM rows;\n${padding}`, [join(APP, 'tail.sql')]: `${padding}DROP TABLE rows;\n` });
    assert.deepEqual(await writes('psql -f head.sql; psql -f tail.sql', ctx), ['psql runs DELETE']);
    // A drive in the folder reads the line by Windows rules on every host, where two leading separators name a share.
    const share = { ...context({ '//host/share/fix.sql': 'DELETE FROM rows;\n' }), cwd: 'C:\\work\\app' };
    assert.deepEqual(await writes("psql -f '//host/share/fix.sql'; psql app < '\\\\host\\share\\fix.sql'", share), []);
  });

  it('finds no write in a file it cannot read, and the rest of the line its own', async () => {
    const files = new FaultyFiles(new MemoryFiles({ [join(APP, 'locked.sql')]: 'DROP TABLE rows;\n' }));
    files.fail('readHead', join(APP, 'locked.sql'), systemError('EACCES'));
    assert.deepEqual(await writes("psql -c 'DELETE FROM rows' -f locked.sql", { ...context(), files }), ['psql runs DELETE']);
  });

  it("reads a team's program before a built-in of the same name, by the name a line runs", async () => {
    const ctx = context({}, { programs: [{ name: 'psql', reads: 'sql-execute' }, { name: 'Docsh.EXE', reads: 'document-shell' }] });
    // Each line alone: joined, a reader trying the built-in first would find the -c write and miss the -e one, the same count.
    assert.deepEqual(await writes("psql -c 'DROP TABLE rows'", ctx), []);
    assert.deepEqual(await writes("psql -e 'DROP TABLE rows'", ctx), ['psql runs DROP']);
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

describe('dbWritesOf, each client, runner and option it reads', () => {
  // Forward slashes on every host: a bash line reads a backslash as an escape, so `join`'s Windows path would name another file.
  const FIX = 'scratchpad/fix-rows.cjs';
  const KV_CODE = "const r = new (require('kvstore'))(); r.flushall()";
  const scripts = (): DbWriteContext =>
    context({ [join(APP, 'scratchpad', 'fix-rows.cjs')]: DOC_FIX, [join(APP, 'fix.cjs')]: DOC_FIX, [join(APP, 'read.cjs')]: DOC_READ });

  it('finds the SQL writes of mariadb, the long option forms and SQL a redirect hands the client', async () => {
    const ctx = context({ [join(APP, 'fix.sql')]: 'UPDATE rows SET a = 1;' }, NO_RULES);
    assert.deepEqual(await writes("mariadb -e 'DELETE FROM rows'", ctx), ['mariadb runs DELETE']);
    assert.deepEqual(await writes("psql --command 'DELETE FROM rows'; mysql --execute 'DELETE FROM rows'", ctx), ['psql runs DELETE', 'mysql runs DELETE']);
    assert.deepEqual(await writes('psql app < fix.sql; psql app 0< fix.sql; sqlite3 app.db < fix.sql', ctx), ['psql runs UPDATE', 'psql runs UPDATE', 'sqlite3 runs UPDATE']);
  });

  it("reads sqlite3's -cmd as SQL and skips the value of its valued options, never reading a database name as SQL", async () => {
    assert.deepEqual(await writes("sqlite3 -cmd 'DELETE FROM rows' app.db"), ['sqlite3 runs DELETE']);
    assert.deepEqual(await writes("sqlite3 -cmd '.mode csv' backups/pre-update.db 'SELECT 1'; sqlite3 -init x.sql backups/pre-update.db 'SELECT 1'"), []);
  });

  it('reads no value joined to a long single-dash option, and none for a short option that ends the line', async () => {
    assert.deepEqual(await writes("sqlite3 '-cmdDROP TABLE rows' app.db"), []);
    // A file at the folder's own path: a bare -f read as a joined empty value would name the folder and find this write.
    assert.deepEqual(await writes('docsh -f', context({ [APP]: 'db.rows.drop()' })), []);
  });

  it('matches an entrypoint by its whole path, with or without ./, never by part of a folder name or by an empty path', async () => {
    const apply = (path: string): DbWriteContext => context({}, { entrypoints: [{ path, applyFlags: ['--apply'] }] });
    assert.deepEqual(await writes('tsx scripts/backfill.ts --apply', apply('./scripts/backfill.ts')), ['tsx scripts/backfill.ts runs with --apply']);
    assert.deepEqual(await writes('node xscripts/backfill.ts --apply', apply('scripts/backfill.ts')), []);
    assert.deepEqual(await writes("node '' --apply", apply('./')), []);
  });

  it('finds the script a package runner runs, past its valued options and by a bin path, and none it only knows at run time', async () => {
    for (const line of [
      `pnpx tsx ${FIX}`,
      `npx -p tsx tsx ${FIX}`,
      `npx --package tsx tsx ${FIX}`,
      `npx -w packages/api tsx ${FIX}`,
      `npx ./node_modules/.bin/tsx ${FIX}`,
    ]) {
      assert.deepEqual(await writes(line, scripts()), [`tsx ${FIX} runs deleteMany`], line);
    }
    // As with a program word the line itself only knows at run time, which the line's walker never reads as a run.
    assert.deepEqual(await writes(`npx $BIN/tsx ${FIX}`, scripts()), []);
  });

  it("finds the script node runs past its preload and env-file options, and none under an option that runs no script", async () => {
    for (const options of ['-r dotenv/config', '--require dotenv/config', '--import tsx', '--env-file .env']) {
      assert.deepEqual(await writes(`node ${options} ${FIX}`, scripts()), [`node ${FIX} runs deleteMany`], options);
    }
    for (const option of ['--test', '--check', '-c', '--version', '-v', '--help', '-h']) {
      assert.deepEqual(await writes(`node ${option} ${FIX}`, scripts()), [], option);
    }
  });

  it('finds the client writes of code node evaluates or prints, named by the option without its value', async () => {
    assert.deepEqual(await writes(`node --eval "${KV_CODE}"; node -p "${KV_CODE}"; node --print "${KV_CODE}"`), [
      'node --eval runs flushall',
      'node -p runs flushall',
      'node --print runs flushall',
    ]);
    assert.deepEqual(await writes(`node --eval="${KV_CODE}"; node --print="${KV_CODE}"`), ['node --eval runs flushall', 'node --print runs flushall']);
  });

  it('reads the code node takes on stdin from a pipe or a here-document, not a file named after the - word', async () => {
    assert.deepEqual(await writes('cat fix.cjs | node', scripts()), ['node runs deleteMany']);
    // Each file the printer pipes is one input; a write they share is named once.
    assert.deepEqual(await writes('cat fix.cjs fix.cjs | node', scripts()), ['node runs deleteMany']);
    assert.deepEqual(await writes(`node - read.cjs <<'EOF'\n${DOC_FIX}EOF`, scripts()), ['node runs deleteMany']);
  });

  it('finds a document-shell file named by -f, and reads no file named by a connection string', async () => {
    const ctx = context({ [join(APP, 'fix-rows')]: 'db.rows.deleteMany({})', [join(APP, 'db.example.com', 'app')]: 'db.rows.drop()' });
    assert.deepEqual(await writes('docsh -f fix-rows', ctx), ['docsh runs deleteMany']);
    assert.deepEqual(await writes('docsh db.example.com/app --eval "db.a.find()"', ctx), []);
  });

  it('finds a key-value command past valued options, in any case, and an EVAL in lower case', async () => {
    assert.deepEqual(await writes('kvcli -p 7000 DEL k; kvcli -a "$KV_AUTH" DEL k; kvcli del k'), ['kvcli runs DEL', 'kvcli runs DEL', 'kvcli runs DEL']);
    assert.deepEqual(await writes(`kvcli eval "kv.call('DEL', KEYS[1])" 1 k`), ['kvcli runs DEL']);
    assert.deepEqual(await writes("echo -n 'DEL k' | kvcli"), ['kvcli runs DEL']);
  });

  it('reads what a PowerShell writer or file reader pipes to a client', async () => {
    const ctx = { ...context({ [join(APP, 'fix.js')]: 'db.rows.deleteMany({})' }), dialect: 'powershell' as const };
    assert.deepEqual(await writes("Write-Output 'DEL k' | kvcli", ctx), ['kvcli runs DEL']);
    for (const reader of ['Get-Content', 'gc', 'type']) {
      assert.deepEqual(await writes(`${reader} fix.js | docsh`, ctx), ['docsh runs deleteMany'], reader);
    }
  });

  it('reads no input or script whose name is only known when the line runs, and no printer option as a file', async () => {
    // A file at the word's written text: reading a dynamic word as a name would find this write.
    const ctx = context({
      [join(APP, '$FILE')]: 'db.rows.deleteMany({})',
      [join(APP, '$SCRIPT')]: DOC_FIX,
      [join(APP, '-n')]: 'db.rows.drop()',
      [join(APP, 'read.js')]: 'db.rows.find()',
    });
    for (const line of ['docsh < "$FILE"', 'cat "$FILE" | docsh', 'node "$SCRIPT"', 'cat -n read.js | docsh']) {
      assert.deepEqual(await writes(line, ctx), [], line);
    }
  });

  it('reads a piped file from the folder its printer runs in, and no relative file under a folder it cannot know', async () => {
    const ctx = context({ [join(APP, 'fix.js')]: 'db.rows.deleteMany({})', 'fix.sql': 'DROP TABLE rows;' });
    assert.deepEqual(await writes('(cd sub && cat ../fix.js) | docsh', ctx), ['docsh runs deleteMany']);
    assert.deepEqual(await writes('cd "$D" && psql -f fix.sql', ctx), []);
  });

  it("reads no host file a remote line names, and no host input a remote pipe's receiver does not take", async () => {
    const ctx = context({ [join(APP, 'fix.js')]: 'db.rows.deleteMany({})' });
    const hostPath = join(APP, 'fix.js').replace(/\\/g, '/');
    assert.deepEqual(await writes(`kubectl exec -n ns deploy/api -- docsh ${hostPath}`, ctx), []);
    assert.deepEqual(await writes("kubectl exec -i p -- sh -c 'cat /x | docsh' < fix.js", ctx), []);
  });

  it('reads a remote line by the dialect of the shell that runs it, not the host line', async () => {
    // ssh hands the remote shell one line; bash there drops the backslashes, so the echo hands the client
    // `db.a.drop()`, where PowerShell would keep them. A `sh -c` line is bash under any host, so it proves no dialect.
    const ctx = { ...context(), dialect: 'powershell' as const };
    assert.deepEqual(await writes(String.raw`ssh h 'echo db.a.drop\(\) | docsh'`, ctx), [
      'docsh runs drop in a container or on a remote host',
    ]);
  });
});
