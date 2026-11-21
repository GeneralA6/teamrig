import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unsupported } from '../ports/host/index.ts';
import { hostDeclarationData, manifestOf } from '../testing/manifests.ts';
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
    const adapter = defineHost({
      declaration: data,
      create: (deps: HostDeps) => ({
        hooks: unsupported(`no hooks on ${deps.platform}`),
        toolCall: unsupported('no tool call'),
        transcripts: unsupported('no session log'),
        usage: unsupported('no call is priced'),
        statusLine: unsupported('no status line is drawn'),
        paths: unsupported('no folder is known'),
        permissions: unsupported('no permission rule is kept'),
        plugin: unsupported('no plugin is installed'),
        launcher: unsupported('no session is told'),
      }),
    });
    assert.equal(adapter.declaration, data);
    assert.deepEqual(adapter.create({ env: {}, platform: 'linux', run: () => Promise.reject(new Error('no program runs here')) }), {
      hooks: { kind: 'unsupported', notice: 'no hooks on linux' },
      toolCall: { kind: 'unsupported', notice: 'no tool call' },
      transcripts: { kind: 'unsupported', notice: 'no session log' },
      usage: { kind: 'unsupported', notice: 'no call is priced' },
      statusLine: { kind: 'unsupported', notice: 'no status line is drawn' },
      paths: { kind: 'unsupported', notice: 'no folder is known' },
      permissions: { kind: 'unsupported', notice: 'no permission rule is kept' },
      plugin: { kind: 'unsupported', notice: 'no plugin is installed' },
      launcher: { kind: 'unsupported', notice: 'no session is told' },
    });
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
