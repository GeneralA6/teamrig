import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, featuresOf, hostAdapterProblems, hostDeclarationProblems, isUnsupported } from '../../../plugin-api/index.ts';
import { hostDeps } from '../../../testing/adapter-deps.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';
import { statusLine } from './status-line.ts';
import { transcriptReader } from './transcript.ts';
import { usageMeter } from './usage.ts';

describe('the Claude Code adapter', () => {
  it('declares a host built for the plugin API of this teamrig', () => {
    assert.deepEqual(hostDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'claude-code');
    assert.equal(declaration.name, 'Claude Code');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('supports every host feature but the two it says it lacks', () => {
    const lacking = featuresOf('host')
      .filter((row) => declaration.manifest[row.id].kind !== 'supported')
      .map((row) => row.id);
    assert.deepEqual(lacking, ['budget.tuning', 'errors.kinds']);
  });

  it('says tuning is not built, and which kinds of error have no rule of their own yet', () => {
    assert.deepEqual(declaration.manifest['budget.tuning'], { kind: 'unsupported', notice: "tuning from a user's own results is not built yet" });
    const errors = declaration.manifest['errors.kinds'];
    assert.equal(errors.kind, 'partial');
    assert.match(errors.kind === 'partial' ? errors.missing : '', /rate-limit hit.*context too long/);
  });

  it('enters through defineHost with that declaration, and names every host port, the transcripts, the usage meter and the status line filled', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(hostAdapterProblems(adapter), []);
    const ports = adapter.create(hostDeps());
    assert.deepEqual(Object.keys(ports), ['hooks', 'toolCall', 'transcripts', 'usage', 'statusLine']);
    assert.equal(isUnsupported(ports.hooks), true);
    assert.equal(isUnsupported(ports.toolCall), true);
    assert.equal(ports.transcripts, transcriptReader);
    assert.equal(ports.usage, usageMeter);
    assert.equal(ports.statusLine, statusLine);
  });
});
