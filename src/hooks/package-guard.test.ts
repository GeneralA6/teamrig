import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_PACKAGE_GUARD } from '../config/defaults.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { adHocReason, adHocRunnersOf, lostFlagReason, packageGuardOutput, type PackageGuardEnv } from './package-guard.ts';

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

  it('refuses an npx --no that hands its bin a flag npm takes, whatever adHocRunners says, naming the form that keeps it', async () => {
    for (const adHocRunners of ['deny', 'ask', 'allow'] as const) {
      const verdict = verdictOf(await packageGuardOutput(payload('npx --no tsc --version'), env({ adHocRunners })));
      assert.equal(verdict?.decision, 'deny', adHocRunners);
      assert.equal(verdict?.reason, lostFlagReason([{ bin: 'tsc', flag: '--version' }]));
    }
    assert.equal(await packageGuardOutput(payload('npx --no -- tsc --version'), env()), '');
  });

  it('names a lost flag and an ad-hoc run in one refusal, denied though the team set ask', async () => {
    const verdict = verdictOf(await packageGuardOutput(payload('npx --no tsc --version && npx eslint .'), env({ adHocRunners: 'ask' })));
    assert.equal(verdict?.decision, 'deny');
    assert.equal(verdict?.reason, `${lostFlagReason([{ bin: 'tsc', flag: '--version' }])} ${adHocReason(['npx eslint'])}`);
  });

  it('stays quiet for a line with no ad-hoc run, and for input that is not a shell call', async () => {
    for (const input of [payload('npm ci && npm test'), 'not a payload', { tool_name: 'Bash', tool_input: {} }]) {
      assert.equal(await packageGuardOutput(input, env()), '');
    }
  });
});

describe('adHocReason', () => {
  it('names every call, in the plural for more than one, and the local run that keeps its flags', () => {
    assert.match(adHocReason(['npx a', 'pnpm dlx b']), /^teamrig package guard: `npx a`, `pnpm dlx b` fetch and run packages outside/);
    assert.match(adHocReason(['npx a']), /run its local bin \(npx --no -- <bin>\)/);
  });
});

describe('lostFlagReason', () => {
  it('names each call, what npm takes from it and the form with --', () => {
    assert.equal(
      lostFlagReason([
        { bin: 'tsc', flag: '--version' },
        { bin: 'eslint', flag: '--fix' },
      ]),
      'teamrig package guard: `npx --no tsc --version` runs npm with --version, not tsc (run `npx --no -- tsc --version`); ' +
        '`npx --no eslint --fix` runs npm with --fix, not eslint (run `npx --no -- eslint --fix`). ' +
        "npx takes the word after a bare --no as that option's value, so the flags after it go to npm; put -- after --no.",
    );
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
