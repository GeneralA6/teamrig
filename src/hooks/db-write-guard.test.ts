import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_DB_WRITE_GUARD } from '../config/defaults.ts';
import type { DbWriteGuardConfig } from '../config/types.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { dbWriteGuardOf, dbWriteGuardOutput, dbWriteReason, type DbWriteGuardEnv } from './db-write-guard.ts';
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

function env(overrides: Partial<DbWriteGuardEnv> = {}): DbWriteGuardEnv {
  return { ...DEFAULT_DB_WRITE_GUARD, ...TEAM, cwd: APP, home: resolve('/', 'u'), files: new MemoryFiles(), hookAsks: 'ask', ...overrides };
}

function payload(command: string, extra: Readonly<Record<string, string>> = {}): unknown {
  return { tool_name: 'Bash', tool_input: { command }, ...extra };
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

describe('dbWriteGuardOutput', () => {
  it('asks about a hand-run write, naming it and the count to show the owner first', async () => {
    const verdict = verdictOf(await dbWriteGuardOutput(payload(`docsh app --eval 'db.orders.deleteMany({})'`), env()));
    assert.equal(verdict?.decision, 'ask');
    assert.equal(verdict?.reason, dbWriteReason([{ program: 'docsh', writes: ['deleteMany'], entrypoint: false, elsewhere: false }]));
    assert.match(verdict?.reason ?? '', /docsh runs deleteMany\. First run a count or find .* \[dbWriteGuard\.writes\]$/);
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

  it('refuses when the team set deny, stays quiet when it set allow, and refuses an ask when asks are off', async () => {
    const command = payload('kvcli FLUSHALL');
    assert.equal(verdictOf(await dbWriteGuardOutput(command, env({ writes: 'deny' })))?.decision, 'deny');
    assert.equal(await dbWriteGuardOutput(command, env({ writes: 'allow' })), '');
    const refused = verdictOf(await dbWriteGuardOutput(command, env({ hookAsks: 'refuse' })));
    assert.equal(refused?.decision, 'deny');
    assert.ok(refused?.reason?.endsWith(` ${ASK_REFUSED_NOTE}`));
  });

  it('asks about a team entrypoint only with an apply flag, pointing at its dry run', async () => {
    const entrypoints = [{ path: 'scripts/backfill.ts', applyFlags: ['--apply'] }];
    assert.equal(await dbWriteGuardOutput(payload('npx tsx scripts/backfill.ts'), env({ entrypoints })), '');
    const verdict = verdictOf(await dbWriteGuardOutput(payload('npx tsx scripts/backfill.ts --apply'), env({ entrypoints })));
    assert.equal(verdict?.decision, 'ask');
    assert.match(verdict?.reason ?? '', /runs with --apply\. First run it without its apply flag \(its dry run\)/);
  });

  it("reads a script from the payload's folder, and a PowerShell line in its own dialect", async () => {
    const files = new MemoryFiles({ [join(OTHER, 'fix.js')]: 'db.orders.updateMany({}, { $set: { a: 1 } })' });
    const there = verdictOf(await dbWriteGuardOutput(payload('docsh app fix.js', { cwd: OTHER }), env({ files })));
    assert.match(there?.reason ?? '', /docsh runs updateMany/);
    assert.equal(await dbWriteGuardOutput(payload('docsh app fix.js'), env({ files })), '');
    const powershell = { tool_name: 'PowerShell', tool_input: { command: 'kvcli DEL "cache:x"' } };
    assert.match(verdictOf(await dbWriteGuardOutput(powershell, env()))?.reason ?? '', /kvcli runs DEL/);
  });

  it('prints nothing for a payload that is not a shell call', async () => {
    for (const input of [undefined, 'text', { tool_name: 'Read', tool_input: { file_path: join(APP, 'a.js') } }]) {
      assert.equal(await dbWriteGuardOutput(input, env()), '');
    }
  });
});

describe('dbWriteGuardOf', () => {
  it("takes a loaded config's choices and keeps the default for a missing or broken one", () => {
    const entrypoints = [{ path: 'scripts/backfill.ts', applyFlags: ['--apply'] }];
    const programs = [{ name: 'docsh', reads: 'document-shell' }];
    const config = testConfig({ dbWriteGuard: { writes: 'deny', entrypoints, programs } });
    assert.deepEqual(dbWriteGuardOf({ status: 'loaded', path: 'c.json', config, issues: [] }), {
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
