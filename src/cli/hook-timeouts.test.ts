import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GUARD_LIMIT_MS } from './guard-runner.ts';
import { HOOK_OUTPUT_MARGIN_MS, HOOK_TIMEOUT_MS, hookLockDeadline } from './hook-timeouts.ts';
import { COMMAND_FLAGS } from './run.ts';
import { MEETING_PANEL_TIMEOUT_MS } from '../mod/meeting-panel-hand.ts';
import { MEETING_TIMEOUT_MS } from '../mod/meeting-hand.ts';
import { NEEDS_YOU_TIMEOUT_MS } from '../mod/needs-you-hand.ts';
import { REFRESH_TIMEOUT_MS } from '../mod/refresh-hand.ts';
import { TIMEOUT_MS as SLASH_TIMEOUT_MS } from '../mod/slash-hand.ts';
import { UPDATE_APPLY_TIMEOUT_MS, UPDATE_CHECK_TIMEOUT_MS } from '../mod/update-hand.ts';
import { WAKE_TIMEOUT_MS } from '../mod/wake-hand.ts';

interface ManifestHook {
  readonly args?: readonly string[];
  readonly timeout?: number;
}

/** Each hook name hooks.json runs, with the shortest limit its runs get: the guard runner's for a guard-main.js run. */
async function manifestLimits(): Promise<Map<string, number>> {
  const manifest = JSON.parse(await readFile(new URL('../../plugins/teamrig/hooks/hooks.json', import.meta.url), 'utf8')) as {
    readonly hooks: Readonly<Record<string, readonly { readonly hooks: readonly ManifestHook[] }[]>>;
  };
  const limits = new Map<string, number>();
  for (const groups of Object.values(manifest.hooks)) {
    for (const hook of groups.flatMap((group) => group.hooks)) {
      const [script = '', word, name] = hook.args ?? [];
      assert.equal(word, 'hook', `a hooks.json entry runs a hook: ${JSON.stringify(hook.args)}`);
      assert.ok(name !== undefined && hook.timeout !== undefined, `hook ${String(name)} names its timeout`);
      const limit = script.endsWith('/guard-main.js') ? Math.min(GUARD_LIMIT_MS, hook.timeout * 1000) : hook.timeout * 1000;
      limits.set(name, Math.min(limit, limits.get(name) ?? limit));
    }
  }
  return limits;
}

describe('HOOK_TIMEOUT_MS (#737)', () => {
  it("holds the limit hooks.json gives each hook it runs, a guard's being the runner's", async () => {
    const limits = await manifestLimits();
    assert.ok(limits.size > 20, 'hooks.json was read');
    for (const [name, limit] of limits) {
      assert.equal(HOOK_TIMEOUT_MS[name], limit, `hook ${name}`);
    }
  });

  it("holds the limit the plugin's mod gives the hooks its hands run", () => {
    const hands: Readonly<Record<string, number | null>> = {
      'wake-check': WAKE_TIMEOUT_MS,
      'wake-dropped': WAKE_TIMEOUT_MS,
      'meeting-due': MEETING_TIMEOUT_MS,
      'meeting-panel': MEETING_PANEL_TIMEOUT_MS,
      'needs-you': NEEDS_YOU_TIMEOUT_MS,
      'needs-you-focus': NEEDS_YOU_TIMEOUT_MS,
      'refresh-mid': REFRESH_TIMEOUT_MS,
      'compact-check': REFRESH_TIMEOUT_MS,
      'update-check': UPDATE_CHECK_TIMEOUT_MS,
      'update-dismiss': UPDATE_CHECK_TIMEOUT_MS,
      'update-apply': UPDATE_APPLY_TIMEOUT_MS,
      'slash-command': SLASH_TIMEOUT_MS,
      'clear-dir': null,
      'clear-claim': null,
    };
    for (const [name, limit] of Object.entries(hands)) {
      assert.equal(HOOK_TIMEOUT_MS[name], limit, `hook ${name}`);
    }
  });

  it('has an entry for every hook command, and none for a command that is gone', () => {
    const hooks = Object.keys(COMMAND_FLAGS)
      .filter((command) => command.startsWith('hook '))
      .map((command) => command.slice('hook '.length))
      .sort();
    assert.deepEqual(Object.keys(HOOK_TIMEOUT_MS).sort(), hooks);
  });
});

describe('hookLockDeadline (#737)', () => {
  it("ends a hook's lock waits its output margin before its limit", () => {
    assert.equal(hookLockDeadline('hook stop', 1_000), 1_000 + 15_000 - HOOK_OUTPUT_MARGIN_MS);
    assert.equal(hookLockDeadline('hook push-guard', 1_000), 1_000 + GUARD_LIMIT_MS - HOOK_OUTPUT_MARGIN_MS);
    assert.equal(hookLockDeadline('hook tool-end', 0), 5_000 - HOOK_OUTPUT_MARGIN_MS);
  });

  it('sets none for a hook with no limit, an unknown hook or any other command', () => {
    assert.equal(hookLockDeadline('hook clear-dir', 1_000), undefined);
    assert.equal(hookLockDeadline('hook constructor', 1_000), undefined);
    assert.equal(hookLockDeadline('list', 1_000), undefined);
    assert.equal(hookLockDeadline('hookstop', 1_000), undefined);
  });
});
