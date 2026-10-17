import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_PACKAGE_GUARD } from '../config/defaults.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { adHocReason, adHocRunnersOf, packageGuardOutput, type PackageGuardEnv } from './package-guard.ts';

const APP = resolve('/', 'work', 'app');
const OTHER = resolve('/', 'work', 'other');

function env(overrides: Partial<PackageGuardEnv> = {}): PackageGuardEnv {
  return { cwd: APP, home: resolve('/', 'u'), files: new MemoryFiles(), adHocRunners: 'deny', ...overrides };
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

describe('packageGuardOutput', () => {
  it('refuses an npx of a tool not installed, naming the call and the vetted route', async () => {
    const verdict = verdictOf(await packageGuardOutput(payload('npx eslint .'), env()));
    assert.equal(verdict?.decision, 'deny');
    assert.equal(verdict?.reason, adHocReason(['npx eslint']));
    assert.match(verdict?.reason ?? '', /`npx eslint` fetches and runs a package .* pinned devDependency/);
  });

  it('asks instead when the team set ask, and stays quiet when it set allow', async () => {
    assert.equal(verdictOf(await packageGuardOutput(payload('pnpm dlx cowsay'), env({ adHocRunners: 'ask' })))?.decision, 'ask');
    assert.equal(await packageGuardOutput(payload('pnpm dlx cowsay'), env({ adHocRunners: 'allow' })), '');
  });

  it("judges from the payload's folder and shell, and the env folder when the payload names none", async () => {
    const files = new MemoryFiles({ [join(APP, 'node_modules', '.bin', 'eslint.cmd')]: '' });
    assert.equal(await packageGuardOutput(payload('npx eslint'), env({ files })), '');
    assert.equal(verdictOf(await packageGuardOutput(payload('npx eslint', { cwd: OTHER }), env({ files })))?.decision, 'deny');
    const powershell = { tool_name: 'PowerShell', tool_input: { command: 'Set-Location ..\\other; npx eslint' } };
    assert.equal(verdictOf(await packageGuardOutput(powershell, env({ files })))?.decision, 'deny');
  });

  it('stays quiet for a line with no ad-hoc run, and for input that is not a shell call', async () => {
    for (const input of [payload('npm ci && npm test'), 'not a payload', { tool_name: 'Bash', tool_input: {} }]) {
      assert.equal(await packageGuardOutput(input, env()), '');
    }
  });
});

describe('adHocReason', () => {
  it('names every call, in the plural for more than one', () => {
    assert.match(adHocReason(['npx a', 'pnpm dlx b']), /^teamrig package guard: `npx a`, `pnpm dlx b` fetch and run packages outside/);
  });
});

describe('adHocRunnersOf', () => {
  it("takes a loaded config's choice and keeps the default for a missing or broken one", () => {
    const config = testConfig({ packageGuard: { adHocRunners: 'ask' } });
    assert.equal(adHocRunnersOf({ status: 'loaded', path: 'c.json', config, issues: [] }), 'ask');
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.equal(adHocRunnersOf(load), DEFAULT_PACKAGE_GUARD.adHocRunners);
    }
  });
});
