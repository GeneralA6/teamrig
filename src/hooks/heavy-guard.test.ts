import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { isRecord, stringField } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import { heavyGuardOutput, unwrappedOf, type HeavyGuardEnv } from './heavy-guard.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';

const APP = resolve('/', 'work', 'app');

function env(overrides: Partial<HeavyGuardEnv> = {}): HeavyGuardEnv {
  return { cwd: APP, home: resolve('/', 'u'), unwrapped: 'deny', hookAsks: 'ask', session: async () => 'alpha', ...overrides };
}

function payload(command: string, toolName = 'Bash'): unknown {
  return { tool_name: toolName, tool_input: { command } };
}

/** The decision and reason the output carries, or undefined for no output. */
function verdictOf(output: string): { readonly decision: string | undefined; readonly reason: string } | undefined {
  if (output === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(output);
  const hook = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  assert.ok(isRecord(hook));
  assert.equal(stringField(hook, 'hookEventName'), 'PreToolUse');
  return { decision: stringField(hook, 'permissionDecision'), reason: stringField(hook, 'permissionDecisionReason') ?? '' };
}

async function reasonOf(command: string, overrides: Partial<HeavyGuardEnv> = {}, toolName = 'Bash'): Promise<string> {
  const verdict = verdictOf(await heavyGuardOutput(payload(command, toolName), env(overrides)));
  assert.ok(verdict !== undefined, command);
  assert.equal(verdict.decision, 'deny', command);
  return verdict.reason;
}

describe('heavyGuardOutput', () => {
  it('refuses a test run outside the host lock and hands back the teamrig heavy and teamrig test call', async () => {
    const reason = await reasonOf('npm test');
    assert.ok(reason.startsWith('teamrig heavy guard: this line runs a test or a build outside the host lock'), reason);
    assert.ok(reason.includes("`teamrig heavy --session alpha --what 'npm test' -- teamrig test --session alpha -- npm test`"), reason);
    assert.ok(reason.endsWith('[coordinator.heavy.unwrapped]'), reason);
  });

  it('hands back a build as a teamrig heavy call alone', async () => {
    assert.ok((await reasonOf('npm run build')).includes("`teamrig heavy --session alpha --what 'npm run build' -- npm run build`"));
    assert.ok((await reasonOf('tsc --noEmit')).includes("`teamrig heavy --session alpha --what 'tsc --noEmit' -- tsc --noEmit`"));
  });

  it('names every heavy step of the line, in order', async () => {
    const reason = await reasonOf('npm run build && npx vitest run');
    assert.ok(
      reason.includes(
        "`teamrig heavy --session alpha --what 'npm run build' -- npm run build`, then " +
          "`teamrig heavy --session alpha --what 'npx vitest run' -- teamrig test --session alpha -- npx vitest run`",
      ),
      reason,
    );
  });

  it('quotes a word the shell would split, keeps one only known when it runs, and cuts a long label', async () => {
    assert.ok((await reasonOf('npm test -- --grep "a b"')).includes("-- npm test -- --grep 'a b'`"));
    assert.ok((await reasonOf('npx vitest run $FILE')).includes('-- npx vitest run "$FILE"`'));
    const long = await reasonOf('node --test src/one/very/long/path/to/a.test.ts');
    assert.ok(long.includes("--what 'node --test src/one/very/long/path/to...' --"), long);
  });

  it('says where a step runs when the line moves away from its folder', async () => {
    assert.ok((await reasonOf('cd sub && tsc')).includes(`-- tsc\` (from ${join(APP, 'sub')})`));
    assert.ok(!(await reasonOf('tsc')).includes('(from '));
  });

  it('names the <you> placeholder when the tab is bound to no session', async () => {
    assert.ok((await reasonOf('npm test', { session: async () => undefined })).includes('--session <you> --what'));
  });

  it('says to run the call in the Bash tool for a PowerShell line', async () => {
    assert.ok((await reasonOf('npm test', {}, 'PowerShell')).includes('run it in the Bash tool'));
    assert.ok(!(await reasonOf('npm test')).includes('Bash tool'));
  });

  it('stays a refusal with no ask note when asks are off', async () => {
    const reason = await reasonOf('npm test', { hookAsks: 'refuse' });
    assert.ok(!reason.includes(ASK_REFUSED_NOTE));
  });

  it('stays quiet for a step teamrig heavy or teamrig test starts, and for a line that only quotes one', async () => {
    for (const command of [
      "teamrig heavy --session a --what 'tests' -- teamrig test --session a -- npm test",
      "teamrig heavy --session a --what 'build' -- npm run build",
      'teamrig test --session a -- node --test src/a.test.ts',
      'teamrig heavy --session a --what x -- "npm run lint && npm test"',
      'env -C /work/app /c/kit/bin/teamrig heavy --session a --what x -- /c/kit/bin/teamrig test --session a -- "npx tsc -p tsconfig.json && node --test src/a.test.ts"',
      'git commit -m "npm test"',
      "cat > notes.md <<'EOF'\nnpm test\nEOF",
      'npm install',
      'git status',
    ]) {
      assert.equal(await heavyGuardOutput(payload(command), env()), '', command);
    }
  });

  it('reads the session only when it refuses', async () => {
    let reads = 0;
    const counted = env({
      session: async () => {
        reads += 1;
        return 'alpha';
      },
    });
    await heavyGuardOutput(payload('git status'), counted);
    assert.equal(reads, 0);
    await heavyGuardOutput(payload('npm test'), counted);
    assert.equal(reads, 1);
  });

  it('stays quiet when the team allows unwrapped steps, and for input with no command', async () => {
    assert.equal(await heavyGuardOutput(payload('npm test'), env({ unwrapped: 'allow' })), '');
    for (const input of [null, 'npm test', { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 1 } }]) {
      assert.equal(await heavyGuardOutput(input, env()), '');
    }
  });

  it("judges from the payload's folder when it names one", async () => {
    const other = resolve('/', 'work', 'other');
    const output = await heavyGuardOutput({ tool_name: 'Bash', tool_input: { command: 'tsc' }, cwd: other }, env());
    assert.ok(!(verdictOf(output)?.reason ?? '').includes('(from '));
  });
});

describe('unwrappedOf', () => {
  it("takes a loaded config's choice and keeps deny for a missing or broken one", () => {
    const config = testConfig({ coordinator: { heavy: { unwrapped: 'allow' } } });
    assert.equal(unwrappedOf({ status: 'loaded', path: 'c.json', config, issues: [] }), 'allow');
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.equal(unwrappedOf(load), 'deny');
    }
  });
});
