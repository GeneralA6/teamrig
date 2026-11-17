import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { DEFAULT_LOCK } from '../config/defaults.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { HOOK_OUTPUT_MARGIN_MS, HOOK_TIMEOUT_MS } from './hook-timeouts.ts';

const NAMED: JsonRecord = { ...TEAM, names: { lead: 'captain' } };
const RENAMES_LOCK = join(TEAM_HOME, 'state', 'renames.lock');
const EVENTS_LOCK = join(TEAM_HOME, 'state', 'events.lock');

function hookInput(fields: JsonRecord): string {
  return JSON.stringify({ cwd: APP, session_id: CLAUDE_SESSION, ...fields });
}

describe("runCli: a hook's lock waits end before its time limit (#737)", () => {
  it('gives up a lock another tab holds by the hook\'s deadline, under the 20 s default wait, and still answers', async () => {
    const limit = HOOK_TIMEOUT_MS['inbox-reminder'];
    assert.ok(typeof limit === 'number' && limit < DEFAULT_LOCK.waitMs, 'the default wait outlasts the hook, as #737 found');
    const kit = new CliHarness(NAMED);
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    await holdFileLock(kit, RENAMES_LOCK);
    const startedAt = kit.clock.now();
    const result = await kit.run(['hook', 'inbox-reminder'], { stdin: hookInput({ session_title: 'ranger' }) });
    const waited = kit.clock.now() - startedAt;
    assert.ok(waited > 0, 'the hook waited on the held lock');
    assert.ok(waited <= limit - HOOK_OUTPUT_MARGIN_MS, `waited ${waited} ms, past ${limit - HOOK_OUTPUT_MARGIN_MS} ms`);
    assert.equal(result.code, 0, 'the hook answers, the rename left for a later prompt');
  });

  it('leaves a command that is no hook its whole wait', async () => {
    const kit = new CliHarness(NAMED);
    await holdFileLock(kit, EVENTS_LOCK);
    const startedAt = kit.clock.now();
    const result = await kit.run(['add', '--title', 'T', '--description', 'D', '--priority', 'p2', '--session', 'alpha']);
    assert.match(result.stderr.join('\n'), /events\.lock is held by another process \(waited 20000 ms\); retry/);
    assert.ok(kit.clock.now() - startedAt >= DEFAULT_LOCK.waitMs, 'a command run by hand waits as before');
  });
});
