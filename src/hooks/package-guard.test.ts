import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_PACKAGE_GUARD } from '../config/defaults.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakePackageRegistry } from '../testing/fake-package-registry.ts';
import { FakeWorktreeFiles } from '../testing/fake-worktrees.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { adHocReason, installReason, linkedModulesReason, lostFlagReason, packageGuardOf, packageGuardOutput, type PackageGuardEnv } from './package-guard.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';

const APP = resolve('/', 'work', 'app');
const OTHER = resolve('/', 'work', 'other');

const PACKAGES = {
  lodash: { distTags: { latest: '4.17.21' }, published: { '4.17.21': '2021-02-20T15:42:16Z' } },
  typescript: { distTags: { latest: '5.9.3' }, published: { '5.9.2': '2025-08-01T00:00:00Z', '5.9.3': '2026-10-18T09:00:00Z' } },
};

const YOUNG_TYPESCRIPT = 'typescript@5.9.3: published 2 days ago (2026-10-18), inside the 14-day cooldown';

function env(overrides: Partial<PackageGuardEnv> = {}): PackageGuardEnv {
  return {
    ...DEFAULT_PACKAGE_GUARD,
    cwd: APP,
    home: resolve('/', 'u'),
    files: new MemoryFiles(),
    tree: new FakeWorktreeFiles(),
    registry: new FakePackageRegistry(PACKAGES),
    clock: new FakeClock('2026-10-20T12:00:00Z'),
    hookAsks: 'ask',
    platform: 'linux',
    ...overrides,
  };
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

  it('refuses what it would ask about when asks are off, saying what to do instead', async () => {
    const verdict = verdictOf(await packageGuardOutput(payload('pnpm dlx cowsay'), env({ adHocRunners: 'ask', hookAsks: 'refuse' })));
    assert.deepEqual(verdict, { decision: 'deny', reason: `${adHocReason(['pnpm dlx cowsay'])} ${ASK_REFUSED_NOTE}` });
    assert.equal(verdictOf(await packageGuardOutput(payload('npx eslint .'), env({ hookAsks: 'refuse' })))?.reason, adHocReason(['npx eslint']));
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

  it('stays quiet for a line with no ad-hoc run or named install, and for input that is not a shell call', async () => {
    for (const input of [payload('npm ci && npm install && npm test'), 'not a payload', { tool_name: 'Bash', tool_input: {} }]) {
      assert.equal(await packageGuardOutput(input, env()), '');
    }
  });

  it('refuses an install of a version inside the cooldown and lets exact versions old enough with no advisory through', async () => {
    const verdict = verdictOf(await packageGuardOutput(payload('npm i typescript'), env()));
    assert.deepEqual(verdict, { decision: 'deny', reason: installReason([YOUNG_TYPESCRIPT], 14) });
    assert.equal(await packageGuardOutput(payload('npm i -D typescript@5.9.2 lodash@4.17.21'), env()), '');
  });

  it('refuses a range without asking the registry, and a version with a known advisory', async () => {
    const registry = new FakePackageRegistry(PACKAGES, [{ name: 'lodash', title: 'Prototype pollution', severity: 'high', url: '' }]);
    const range = verdictOf(await packageGuardOutput(payload('pnpm add chalk@^5'), env({ registry })));
    assert.deepEqual(range, { decision: 'deny', reason: installReason(['chalk@^5: a range, not an exact version'], 14) });
    assert.deepEqual(registry.docsAsked, []);
    const advised = verdictOf(await packageGuardOutput(payload('pnpm add lodash@4.17.21'), env({ registry })));
    assert.equal(advised?.reason, installReason(['lodash@4.17.21: a high advisory, Prototype pollution'], 14));
  });

  it('refuses an install the registry could not be asked about', async () => {
    const registry = new FakePackageRegistry(PACKAGES, [], new Error('network down'));
    const verdict = verdictOf(await packageGuardOutput(payload('npm i lodash@4.17.21'), env({ registry })));
    assert.deepEqual(verdict, { decision: 'deny', reason: installReason(['lodash: the registry could not be asked (network down), so nothing vouches for it'], 14) });
  });

  it('asks about an unvetted install when the team set ask, and lets it through without asking the registry when it set allow', async () => {
    assert.equal(verdictOf(await packageGuardOutput(payload('npm i typescript'), env({ installs: 'ask' })))?.decision, 'ask');
    const registry = new FakePackageRegistry(PACKAGES);
    assert.equal(await packageGuardOutput(payload('npm i typescript'), env({ installs: 'allow', registry })), '');
    assert.deepEqual(registry.docsAsked, []);
  });

  it('refuses a line when any part of it is refused, naming every reason, and asks when every part is asked about', async () => {
    const line = payload('npx eslint . && npm i typescript');
    const denied = verdictOf(await packageGuardOutput(line, env({ adHocRunners: 'ask' })));
    assert.deepEqual(denied, { decision: 'deny', reason: `${adHocReason(['npx eslint'])} ${installReason([YOUNG_TYPESCRIPT], 14)}` });
    assert.equal(verdictOf(await packageGuardOutput(line, env({ adHocRunners: 'ask', installs: 'ask' })))?.decision, 'ask');
  });

  it('refuses an install from the lockfile in a folder whose node_modules links to another, whatever the config says', async () => {
    const main = resolve('/', 'work', 'main', 'node_modules');
    const tree = new FakeWorktreeFiles({ [join(APP, 'node_modules')]: { kind: 'link', target: main } });
    const allowAll = { adHocRunners: 'allow', installs: 'allow', tree } as const;
    const verdict = verdictOf(await packageGuardOutput(payload('npm ci'), env(allowAll)));
    assert.deepEqual(verdict, { decision: 'deny', reason: linkedModulesReason([{ call: 'npm ci', modules: join(APP, 'node_modules'), target: main }]) });
    assert.equal(verdictOf(await packageGuardOutput(payload('npm ci', { cwd: OTHER }), env(allowAll))), undefined);
  });
});

describe('packageGuardOutput: a Bash line on Windows (T2319)', () => {
  /** A run of n backslashes; on Windows bash receives each run not before a double quote halved, rounded up. */
  const bs = (n: number): string => '\\'.repeat(n);
  const windows = (overrides: Partial<PackageGuardEnv> = {}): PackageGuardEnv => env({ platform: 'win32', ...overrides });
  const hiddenSeparator = (command: string): string => `echo a${bs(3)}; ${command}`;
  const hiddenBacktick = (command: string): string => `echo "p${bs(3)}\`${command}; echo ${bs(3)}\`q"`;
  const main = resolve('/', 'work', 'main', 'node_modules');
  const linkedTree = (): FakeWorktreeFiles => new FakeWorktreeFiles({ [join(APP, 'node_modules')]: { kind: 'link', target: main } });

  it('refuses an ad-hoc run, an unvetted install, a lost flag and a linked install that bash runs behind what the line as written escapes', async () => {
    for (const [command, reason, overrides] of [
      ['npx some-pkg', adHocReason(['npx some-pkg']), {}],
      ['npm i typescript', installReason([YOUNG_TYPESCRIPT], 14), {}],
      ['npx --no tsc --version', lostFlagReason([{ bin: 'tsc', flag: '--version' }]), {}],
      ['npm ci', linkedModulesReason([{ call: 'npm ci', modules: join(APP, 'node_modules'), target: main }]), { tree: linkedTree() }],
    ] as const) {
      for (const line of [hiddenSeparator(command), hiddenBacktick(command)]) {
        assert.deepEqual(verdictOf(await packageGuardOutput(payload(line), windows(overrides))), { decision: 'deny', reason }, line);
        assert.equal(await packageGuardOutput(payload(line), env(overrides)), '', `off Windows bash runs the line as written: ${line}`);
      }
    }
  });

  it('names a call both readings run once and reads the registry once for it, and leaves a line whose readings run none', async () => {
    const registry = new FakePackageRegistry(PACKAGES);
    const line = `npx --no tsc --version; npx eslint .; npm i typescript; grep 'a${bs(4)}b' f`;
    const verdict = verdictOf(await packageGuardOutput(payload(line), windows({ registry })));
    assert.deepEqual(verdict, {
      decision: 'deny',
      reason: `${lostFlagReason([{ bin: 'tsc', flag: '--version' }])} ${adHocReason(['npx eslint'])} ${installReason([YOUNG_TYPESCRIPT], 14)}`,
    });
    assert.deepEqual(registry.docsAsked, ['typescript']);
    for (const benign of [`grep 'a${bs(4)}b' f`, hiddenSeparator('npm ci'), hiddenSeparator('npx --no -- tsc --version')]) {
      assert.equal(await packageGuardOutput(payload(benign), windows()), '', benign);
    }
  });
});

describe('linkedModulesReason', () => {
  it('names each call with its link and target, and how to remove the link without emptying its target', () => {
    assert.equal(
      linkedModulesReason([
        { call: 'npm ci', modules: 'W/node_modules', target: 'M/node_modules' },
        { call: 'yarn', modules: 'V/node_modules', target: 'M/node_modules' },
      ]),
      'teamrig package guard: `npm ci` would write through W/node_modules, a link to M/node_modules; `yarn` would write through ' +
        'V/node_modules, a link to M/node_modules. A package manager rewrites the folder a link points to (npm ci empties it first), ' +
        'breaking every checkout that shares it. Remove the link itself first (Bash `rm <link>` or `cmd /c rmdir <link>`; a recursive ' +
        'delete empties its target too), then install a copy here; or install in the checkout that owns the folder.',
    );
  });
});

describe('installReason', () => {
  it('names each package and the cooldown, and leaves the age out under a cooldown of 0 days', () => {
    assert.equal(
      installReason(['a@1.0.0: too young'], 14),
      'teamrig package guard: this install is not vetted: a@1.0.0: too young. Install an exact version published at least 14 days ago with no ' +
        'known advisory (`npm view <name> time` lists when each version was published). [packageGuard.installs]',
    );
    assert.match(installReason(['a', 'b'], 0), /not vetted: a; b\. Install an exact version with no known advisory/);
    assert.match(installReason(['a'], 1), /published at least 1 day ago/);
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

describe('packageGuardOf', () => {
  it("takes a loaded config's choices and keeps the defaults for a missing or broken one", () => {
    const config = testConfig({ packageGuard: { adHocRunners: 'ask', installs: 'allow', cooldownDays: 3 } });
    assert.deepEqual(packageGuardOf({ status: 'loaded', path: 'c.json', config, issues: [] }), { adHocRunners: 'ask', installs: 'allow', cooldownDays: 3 });
    for (const load of [undefined, { status: 'missing', path: 'c.json' } as const, { status: 'unreadable', path: 'c.json', issue: { path: '', message: 'bad' } } as const]) {
      assert.deepEqual(packageGuardOf(load), DEFAULT_PACKAGE_GUARD);
    }
  });
});
