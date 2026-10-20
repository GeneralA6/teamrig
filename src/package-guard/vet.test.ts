import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakePackageRegistry } from '../testing/fake-package-registry.ts';
import type { InstallTarget } from './installs.ts';
import type { Advisory, PackageDoc, PackageRegistry } from './registry.ts';
import { unvettedOf } from './vet.ts';

const NOW = '2026-10-20T12:00:00Z';
const LIMITS = { cooldownDays: 14, timeoutMs: 5_000 };

const PACKAGES = {
  lodash: { distTags: { latest: '4.17.21' }, published: { '4.17.20': '2020-08-13T16:53:54Z', '4.17.21': '2021-02-20T15:42:16Z' } },
  typescript: { distTags: { latest: '5.9.3', next: '6.0.0-dev.1' }, published: { '5.9.2': '2025-08-01T00:00:00Z', '5.9.3': '2026-10-18T09:00:00Z', '6.0.0-dev.1': '2026-10-20T01:00:00Z' } },
};

const POLLUTION: Advisory = { name: 'lodash', title: 'Prototype pollution', severity: 'high', url: 'https://github.com/advisories/GHSA-1' };

function version(name: string, exact: string): InstallTarget {
  return { kind: 'registry', spec: `${name}@${exact}`, name, wanted: { kind: 'version', version: exact } };
}

function tag(name: string, tagName: string): InstallTarget {
  return { kind: 'registry', spec: `${name}@${tagName}`, name, wanted: { kind: 'tag', tag: tagName } };
}

const RANGE: InstallTarget = { kind: 'unvetted', spec: 'chalk@^5', why: 'a range, not an exact version' };

/** A registry that answers nothing until the caller's signal ends the wait. */
class SilentRegistry implements PackageRegistry {
  packageDoc(_name: string, signal: AbortSignal): Promise<PackageDoc | undefined> {
    return new Promise((_done, fail) => signal.addEventListener('abort', () => fail(signal.reason)));
  }

  advisories(): Promise<readonly Advisory[]> {
    return Promise.resolve([]);
  }
}

describe('unvettedOf', () => {
  it('vets an exact version old enough with no advisory, asking for each package once and for advisories in one request', async () => {
    const registry = new FakePackageRegistry(PACKAGES);
    const lines = await unvettedOf([version('lodash', '4.17.21'), tag('lodash', 'latest'), version('typescript', '5.9.2')], { registry, clock: new FakeClock(NOW) }, LIMITS);
    assert.deepEqual(lines, []);
    assert.deepEqual(registry.docsAsked, ['lodash', 'typescript']);
    assert.deepEqual(registry.advisoriesAsked, [new Map([['lodash', ['4.17.21']], ['typescript', ['5.9.2']]])]);
  });

  it('refuses a version, or the version a tag points at, published inside the cooldown, naming its age and date', async () => {
    const registry = new FakePackageRegistry(PACKAGES);
    const lines = await unvettedOf([tag('typescript', 'latest'), tag('typescript', 'next')], { registry, clock: new FakeClock(NOW) }, LIMITS);
    assert.deepEqual(lines, [
      'typescript@5.9.3: published 2 days ago (2026-10-18), inside the 14-day cooldown',
      'typescript@6.0.0-dev.1: published 0 days ago (2026-10-20), inside the 14-day cooldown',
    ]);
  });

  it('vets a version of any age under a cooldown of 0 days', async () => {
    const registry = new FakePackageRegistry(PACKAGES);
    assert.deepEqual(await unvettedOf([tag('typescript', 'latest')], { registry, clock: new FakeClock(NOW) }, { ...LIMITS, cooldownDays: 0 }), []);
  });

  it('refuses a package not on the registry, a tag it lacks and a version never published', async () => {
    const registry = new FakePackageRegistry(PACKAGES);
    const lines = await unvettedOf([version('ghost', '1.0.0'), tag('lodash', 'canary'), version('lodash', '9.9.9')], { registry, clock: new FakeClock(NOW) }, LIMITS);
    assert.deepEqual(lines, ['ghost@1.0.0: not on the registry', 'lodash@canary: lodash has no "canary" tag', 'lodash@9.9.9: not a published version']);
    assert.deepEqual(registry.advisoriesAsked, []);
  });

  it('refuses a version with a known advisory, naming its severity, title and link', async () => {
    const registry = new FakePackageRegistry(PACKAGES, [POLLUTION]);
    const lines = await unvettedOf([version('lodash', '4.17.20'), version('typescript', '5.9.2')], { registry, clock: new FakeClock(NOW) }, LIMITS);
    assert.deepEqual(lines, ['lodash@4.17.20: a high advisory, Prototype pollution (https://github.com/advisories/GHSA-1)']);
  });

  it('keeps what cannot be vetted first and asks the registry nothing when no package can be', async () => {
    const registry = new FakePackageRegistry(PACKAGES);
    assert.deepEqual(await unvettedOf([RANGE], { registry, clock: new FakeClock(NOW) }, LIMITS), ['chalk@^5: a range, not an exact version']);
    assert.deepEqual(registry.docsAsked, []);
    const young = await unvettedOf([RANGE, tag('typescript', 'latest')], { registry, clock: new FakeClock(NOW) }, LIMITS);
    assert.deepEqual(young, ['chalk@^5: a range, not an exact version', 'typescript@5.9.3: published 2 days ago (2026-10-18), inside the 14-day cooldown']);
  });

  it('refuses every package it asked about when the registry fails, keeping the rest', async () => {
    const registry = new FakePackageRegistry(PACKAGES, [], new Error('network down'));
    const lines = await unvettedOf([RANGE, version('lodash', '4.17.21'), version('typescript', '5.9.2')], { registry, clock: new FakeClock(NOW) }, LIMITS);
    assert.deepEqual(lines, ['chalk@^5: a range, not an exact version', 'lodash, typescript: the registry could not be asked (network down), so nothing vouches for it']);
  });

  it('refuses when the registry does not answer in time', async () => {
    const lines = await unvettedOf([version('lodash', '4.17.21')], { registry: new SilentRegistry(), clock: new FakeClock(NOW) }, { ...LIMITS, timeoutMs: 50 });
    assert.deepEqual(lines, ['lodash: the registry could not be asked (no answer within 0.05 s), so nothing vouches for it']);
  });
});
