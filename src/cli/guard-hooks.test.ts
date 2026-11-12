import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, isStringArray } from '../core/guards.ts';
import { GUARD_LIMIT_MS } from './guard-runner.ts';

const RUNNER = '${CLAUDE_PLUGIN_ROOT}/dist/cli/guard-main.js';
const CLI = '${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js';

/** The PreToolUse hooks that can refuse a call, so they run under the fail-closed runner: a crash must block the call. */
const WRAPPED: ReadonlySet<string> = new Set(['push-guard', 'package-guard', 'secret-guard', 'exec-guard', 'pass-record-guard', 'cold-send', 'helper-gate', 'picker-guard']);

/** The PreToolUse hooks left on the plain CLI, each with why failing open is its safe side. */
const UNWRAPPED: ReadonlyMap<string, string> = new Map([
  ['readonly-allow', 'an allow hook: when it fails, the call falls back to the permission rules'],
  ['route-allow', "an allow hook: when it fails, the call gets Claude Code's own check"],
  ['tab-status', 'paints the tab title; it never answers for a call'],
]);

/** Node.js starting and loading the runner before its time limit starts counting. */
const START_MARGIN_MS = 2_000;

interface ManifestHook {
  readonly event: string;
  readonly script: string;
  readonly name: string;
  /** Claude Code's timeout for the hook, in seconds. */
  readonly timeout: number | undefined;
}

/** Every exec-form hook of the plugin's hooks.json, with the script it runs and the hook name it passes. */
async function manifestHooks(): Promise<ManifestHook[]> {
  const manifest: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/hooks/hooks.json', import.meta.url), 'utf8'));
  const events = isRecord(manifest) ? manifest['hooks'] : undefined;
  if (!isRecord(events)) {
    throw new Error('hooks.json has no "hooks" object');
  }
  const found: ManifestHook[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      throw new Error(`hooks.json: ${event} is not a list`);
    }
    for (const group of groups) {
      const hooks = isRecord(group) ? group['hooks'] : undefined;
      if (!Array.isArray(hooks)) {
        throw new Error(`hooks.json: a ${event} entry has no "hooks" list`);
      }
      for (const hook of hooks) {
        const args = isRecord(hook) ? hook['args'] : undefined;
        if (!isRecord(hook) || !isStringArray(args)) {
          throw new Error(`hooks.json: a ${event} hook has no "args" list`);
        }
        const [script = '', , name = ''] = args;
        const timeout = hook['timeout'];
        found.push({ event, script, name, timeout: typeof timeout === 'number' ? timeout : undefined });
      }
    }
  }
  return found;
}

describe("the plugin's hooks.json and the guard runner", () => {
  it('runs every PreToolUse hook that can refuse a call through the runner, and the rest through the plain CLI', async () => {
    const preToolUse = (await manifestHooks()).filter(({ event }) => event === 'PreToolUse');
    for (const { name, script } of preToolUse) {
      if (WRAPPED.has(name)) {
        assert.equal(script, RUNNER, `${name} can refuse a call, so it must run through the fail-closed runner`);
      } else {
        assert.ok(UNWRAPPED.has(name), `the PreToolUse hook ${name} is not classified: add it to WRAPPED, or to UNWRAPPED with why it may fail open`);
        assert.equal(script, CLI, name);
      }
    }
    const names = new Set(preToolUse.map(({ name }) => name));
    assert.deepEqual([...WRAPPED, ...UNWRAPPED.keys()].filter((name) => !names.has(name)), [], 'a classified hook is gone from hooks.json');
  });

  it("gives each wrapped guard a Claude Code timeout past the runner's limit, so the runner's answer comes first", async () => {
    const wrapped = (await manifestHooks()).filter(({ script }) => script === RUNNER);
    assert.ok(wrapped.length >= WRAPPED.size);
    for (const { name, timeout } of wrapped) {
      assert.ok(timeout !== undefined && timeout * 1000 >= GUARD_LIMIT_MS + START_MARGIN_MS, `${name}: timeout ${String(timeout)} s`);
    }
  });

  it('gives every tab-status entry the 15 second timeout the other plain hooks have, as a loaded host measured it past 5 s', async () => {
    const entries = (await manifestHooks()).filter(({ name }) => name === 'tab-status');
    assert.ok(entries.length > 0);
    for (const { event, timeout } of entries) {
      assert.equal(timeout, 15, `${event}: timeout ${String(timeout)} s`);
    }
  });

  it('uses the runner on PreToolUse hooks only, where a block stops one tool call', async () => {
    const elsewhere = (await manifestHooks()).filter(({ event, script }) => script === RUNNER && event !== 'PreToolUse');
    assert.deepEqual(elsewhere, []);
  });
});
