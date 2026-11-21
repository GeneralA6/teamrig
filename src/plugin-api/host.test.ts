import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostDeclarationData, manifestOf } from '../testing/manifests.ts';
import { unsupported } from '../ports/host/index.ts';
import { defineHost, hostAdapterProblems, hostDeclarationProblems, isHostAdapter, isHostDeclaration, type HostDeps } from './host.ts';

const NOT_DEFINED = 'its entry is not made by defineHost: it needs a declaration and a create function';

describe('a host declaration', () => {
  it('is a declaration whose manifest answers for every host feature', () => {
    assert.deepEqual(hostDeclarationProblems(hostDeclarationData()), []);
    assert.equal(isHostDeclaration(hostDeclarationData()), true);
  });

  it('is refused with a connector manifest', () => {
    const data = hostDeclarationData({ manifest: manifestOf('connector') });
    assert.equal(isHostDeclaration(data), false);
    assert.ok(hostDeclarationProblems(data).includes('its manifest has no row for rules.session-start'));
    assert.ok(hostDeclarationProblems(data).includes('its manifest names tracker.comment, which is no host feature'));
  });
});

describe('defineHost', () => {
  it('hands back the adapter it is given, whose create builds its ports from the deps', () => {
    const data = hostDeclarationData();
    assert.ok(isHostDeclaration(data));
    const adapter = defineHost({ declaration: data, create: (deps: HostDeps) => ({ transcripts: unsupported(`no session log on ${deps.platform}`), usage: unsupported('no call is priced'), statusLine: unsupported('no status line is drawn') }) });
    assert.equal(adapter.declaration, data);
    assert.deepEqual(adapter.create({ env: {}, platform: 'linux', run: () => Promise.reject(new Error('no program runs here')) }), { transcripts: { kind: 'unsupported', notice: 'no session log on linux' }, usage: { kind: 'unsupported', notice: 'no call is priced' }, statusLine: { kind: 'unsupported', notice: 'no status line is drawn' } });
    assert.equal(isHostAdapter(adapter), true);
  });
});

describe('a host adapter entry', () => {
  it('is refused when it is no declaration beside a create function', () => {
    assert.deepEqual(hostAdapterProblems({ declaration: hostDeclarationData() }), [NOT_DEFINED]);
    assert.deepEqual(hostAdapterProblems(undefined), [NOT_DEFINED]);
    assert.equal(isHostAdapter({ declaration: hostDeclarationData() }), false);
  });

  it('is refused for what is wrong with its declaration', () => {
    assert.deepEqual(hostAdapterProblems({ declaration: hostDeclarationData({ name: '' }), create: () => ({}) }), ['it needs a name']);
    assert.deepEqual(hostAdapterProblems({ create: () => ({}) }), ['its declaration is not an object']);
  });
});
