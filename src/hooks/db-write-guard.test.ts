import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_DB_WRITE_GUARD } from '../config/defaults.ts';
import type { DbWriteGuardConfig } from '../config/types.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import { hookEventOf, replyText } from '../testing/host.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { DbWrite } from '../db-write-guard/writes.ts';
import { dbWriteGuardOf, dbWriteGuardReply, dbWriteReason, type DbWriteGuardEnv } from './db-write-guard.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';

const APP = resolve('/', 'work', 'app');
const OTHER = resolve('/', 'work', 'other');

/** A team that adds a document shell and a key-value CLI to the built-in SQL clients. */
const TEAM: Pick<DbWriteGuardConfig, 'programs' | 'nodeClients'> = {
  programs: [
    { name: 'docsh', reads: 'document-shell' },
    { name: 'kvcli', reads: 'key-value-cli' },
  ],
  nodeClients: [{ module: 'docstore', vocabulary: 'document' }],
};

/** The guard's env, with the platform the host reads the call on: Linux when a spec names none. */
type SpecEnv = DbWriteGuardEnv & { readonly platform?: NodeJS.Platform };

function env(overrides: Partial<SpecEnv> = {}): SpecEnv {
  return { ...DEFAULT_DB_WRITE_GUARD, ...TEAM, cwd: APP, home: resolve('/', 'u'), files: new MemoryFiles(), ...overrides };
}

function payload(command: string, extra: Readonly<Record<string, string>> = {}): JsonRecord {
  return { tool_name: 'Bash', tool_input: { command }, ...extra };
}

/** What the shipped host is handed for the guard's reply to this hook input. */
async function dbWriteGuardOutput(input: JsonRecord, guardEnv: SpecEnv): Promise<string> {
  return replyText('tool-start', await dbWriteGuardReply(hookEventOf(input, guardEnv.platform), guardEnv));
}

/** The decision and reason the output carries, or undefined for no output. */
function verdictOf(output: string): { readonly decision: string | undefined; readonly reason: string | undefined } | undefined {
  if (output === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(output);
  const hook = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  assert.ok(isRecord(hook));
  assert.equal(stringField(hook, 'hookEventName'), 'PreToolUse');
  return { decision: stringField(hook, 'permissionDecision'), reason: stringField(hook, 'permissionDecisionReason') };
}

describe('dbWriteGuardReply', () => {
  it('refuses a hand-run write, naming it, the count to show the owner first and the route (T3356)', async () => {
    const verdict = verdictOf(await dbWriteGuardOutput(payload(`docsh app --eval 'db.orders.deleteMany({})'`), env()));
    assert.equal(verdict?.decision, 'deny');
    assert.equal(verdict?.reason, `${dbWriteReason([{ program: 'docsh', writes: ['deleteMany'], entrypoint: false, elsewhere: false }])} ${ASK_REFUSED_NOTE}`);
    assert.match(verdict?.reason ?? '', /docsh runs deleteMany\. First run a count or find .* \[dbWriteGuard\.writes\] /);
  });

  it('asks about a built-in SQL client with no team config, and lets a program the team never named run', async () => {
    const bare = env({ programs: [], nodeClients: [] });
    assert.match(verdictOf(await dbWriteGuardOutput(payload('psql -c "DELETE FROM orders"'), bare))?.reason ?? '', /psql runs DELETE/);
    assert.equal(await dbWriteGuardOutput(payload(`docsh app --eval 'db.orders.deleteMany({})'`), bare), '');
  });

  it('lets a read run, and a line with no database call', async () => {
    for (const command of [`docsh app --eval 'db.orders.countDocuments({})'`, 'kvcli GET cache:x', 'psql -c "SELECT 1"', 'git status']) {
      assert.equal(await dbWriteGuardOutput(payload(command), env()), '', command);
    }
  });

  it('refuses when the team set deny, stays quiet when it set allow, and refuses an ask with the note on what to do (T3356)', async () => {
    const command = payload('kvcli FLUSHALL');
    assert.equal(verdictOf(await dbWriteGuardOutput(command, env({ writes: 'deny' })))?.decision, 'deny');
    assert.equal(await dbWriteGuardOutput(command, env({ writes: 'allow' })), '');
    const refused = verdictOf(await dbWriteGuardOutput(command, env({})));
    assert.equal(refused?.decision, 'deny');
    assert.ok(refused?.reason?.endsWith(` ${ASK_REFUSED_NOTE}`));
  });

  it('asks about a team entrypoint only with an apply flag, pointing at its dry run', async () => {
    const entrypoints = [{ path: 'scripts/backfill.ts', applyFlags: ['--apply'] }];
    assert.equal(await dbWriteGuardOutput(payload('npx tsx scripts/backfill.ts'), env({ entrypoints })), '');
    const verdict = verdictOf(await dbWriteGuardOutput(payload('npx tsx scripts/backfill.ts --apply'), env({ entrypoints })));
    assert.equal(verdict?.decision, 'deny');
    assert.match(verdict?.reason ?? '', /runs with --apply\. First run it without its apply flag \(its dry run\)/);
  });

  it('names each write of the line, joined by semicolons, and points at the dry run when an entrypoint is among them', async () => {
    const entrypoints = [{ path: 'scripts/backfill.ts', applyFlags: ['--apply'] }];
    const line = payload("npx tsx scripts/backfill.ts --apply; psql -c 'DELETE FROM orders'");
    const reason = verdictOf(await dbWriteGuardOutput(line, env({ entrypoints })))?.reason ?? '';
    assert.match(reason, /: tsx scripts\/backfill\.ts runs with --apply; psql runs DELETE\. First run it without its apply flag \(its dry run\)/);
  });

  it('asks about Node code using a client module the team names, and a key-value call on a receiver the team names', async () => {
    const files = new MemoryFiles({
      [join(APP, 'fix.cjs')]: "const { Client } = require('docstore');\nawait client.db().collection('rows').deleteMany({});\n",
      [join(APP, 'warm.mjs')]: "import Kv from 'kvstore';\nawait cache.set(key, 1);\n",
    });
    assert.match(verdictOf(await dbWriteGuardOutput(payload('node fix.cjs'), env({ files })))?.reason ?? '', /node fix\.cjs runs deleteMany/);
    const kv = env({ files, nodeClients: [{ module: 'kvstore', vocabulary: 'key-value' }], clientReceivers: ['cache'] });
    assert.match(verdictOf(await dbWriteGuardOutput(payload('node warm.mjs'), kv))?.reason ?? '', /node warm\.mjs runs set/);
    assert.equal(await dbWriteGuardOutput(payload('node warm.mjs'), { ...kv, clientReceivers: [] }), '');
  });

  it("reads a script from the payload's folder, and a PowerShell line in its own dialect", async () => {
    const files = new MemoryFiles({ [join(OTHER, 'fix.js')]: 'db.orders.updateMany({}, { $set: { a: 1 } })' });
    const there = verdictOf(await dbWriteGuardOutput(payload('docsh app fix.js', { cwd: OTHER }), env({ files })));
    assert.match(there?.reason ?? '', /docsh runs updateMany/);
    assert.equal(await dbWriteGuardOutput(payload('docsh app fix.js'), env({ files })), '');
    const powershell = { tool_name: 'PowerShell', tool_input: { command: 'kvcli DEL "cache:x"' } };
    assert.match(verdictOf(await dbWriteGuardOutput(powershell, env()))?.reason ?? '', /kvcli runs DEL/);
    // bash drops the backslashes, so the echo hands docsh `db.a.drop()`; PowerShell keeps them, so docsh gets no call.
    const piped = (tool: string): JsonRecord => ({ tool_name: tool, tool_input: { command: String.raw`echo db.a.drop\(\) | docsh` } });
    assert.match(verdictOf(await dbWriteGuardOutput(piped('Bash'), env()))?.reason ?? '', /docsh runs drop/);
    assert.equal(await dbWriteGuardOutput(piped('PowerShell'), env()), '');
  });

  it('says nothing to a call that is no shell call, or a shell call with no line', async () => {
    for (const input of [{ tool_name: 'Read', tool_input: { file_path: join(APP, 'a.js') } }, { tool_name: 'Bash', tool_input: {} }, {}]) {
      assert.equal(await dbWriteGuardOutput(input, env()), '');
    }
  });
});

describe('dbWriteGuardReply: a Bash line on Windows', () => {
  /** A run of n backslashes; on Windows bash receives each run not before a double quote halved, rounded up. */
  const bs = (n: number): string => '\\'.repeat(n);
  const windows = (overrides: Partial<SpecEnv> = {}): SpecEnv => env({ platform: 'win32', ...overrides });
  const hiddenSeparator = (command: string): string => `echo a${bs(3)}; ${command}`;
  const hiddenBacktick = (command: string): string => `echo "p${bs(3)}\`${command}; echo ${bs(3)}\`q"`;
  const write = (program: string, what: string): DbWrite => ({ program, writes: [what], entrypoint: false, elsewhere: false });

  it('asks about a write that bash runs behind what the line as written escapes', async () => {
    for (const line of [hiddenSeparator("psql -c 'DELETE FROM orders'"), hiddenBacktick('kvcli FLUSHALL')]) {
      const verdict = verdictOf(await dbWriteGuardOutput(payload(line), windows()));
      assert.equal(verdict?.decision, 'deny', line);
      assert.match(verdict?.reason ?? '', /(psql runs DELETE|kvcli runs FLUSHALL)\. First/, line);
      assert.equal(await dbWriteGuardOutput(payload(line), env()), '', `off Windows bash runs the line as written: ${line}`);
    }
  });

  it('names a write both readings make once, and leaves a line whose readings write nothing', async () => {
    const line = `kvcli FLUSHALL; ${hiddenSeparator("psql -c 'DELETE FROM orders'")}`;
    const verdict = verdictOf(await dbWriteGuardOutput(payload(line), windows()));
    assert.equal(verdict?.reason, `${dbWriteReason([write('kvcli', 'FLUSHALL'), write('psql', 'DELETE')])} ${ASK_REFUSED_NOTE}`);
    for (const benign of [`grep 'a${bs(4)}b' f`, hiddenSeparator('kvcli GET cache:x')]) {
      assert.equal(await dbWriteGuardOutput(payload(benign), windows()), '', benign);
    }
  });
});

describe('dbWriteGuardOf', () => {
  it("takes a loaded config's choices and keeps the default for a missing or broken one", () => {
    const entrypoints = [{ path: 'scripts/backfill.ts', applyFlags: ['--apply'] }];
    const programs = [{ name: 'docsh', reads: 'document-shell' }];
    const config = testConfig({ dbWriteGuard: { writes: 'deny', entrypoints, programs } });
    assert.deepEqual(dbWriteGuardOf({ status: 'loaded', path: 'c.json', config, issues: [], warnings: [] }), {
      ...DEFAULT_DB_WRITE_GUARD,
      writes: 'deny',
      entrypoints,
      programs,
    });
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.deepEqual(dbWriteGuardOf(load), DEFAULT_DB_WRITE_GUARD);
    }
  });
});
