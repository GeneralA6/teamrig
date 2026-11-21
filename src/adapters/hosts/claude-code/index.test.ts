import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { API_VERSION, apiVersionNotice, featuresOf, hostAdapterProblems, hostDeclarationProblems, isUnsupported } from '../../../plugin-api/index.ts';
import { hostDeps } from '../../../testing/adapter-deps.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';
import { hostPermissions } from './permissions.ts';
import { hostPlugin } from './plugin.ts';
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

  it('enters through defineHost with that declaration, and fills every host port', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(hostAdapterProblems(adapter), []);
    const ports = adapter.create(hostDeps());
    assert.deepEqual(Object.keys(ports), ['hooks', 'toolCall', 'transcripts', 'usage', 'statusLine', 'paths', 'permissions', 'plugin', 'launcher']);
    assert.equal(isUnsupported(ports.hooks), false);
    assert.equal(isUnsupported(ports.toolCall), false);
    assert.equal(ports.transcripts, transcriptReader);
    assert.equal(ports.usage, usageMeter);
    assert.equal(ports.statusLine, statusLine);
    assert.equal(isUnsupported(ports.paths), false);
    assert.equal(ports.permissions, hostPermissions);
    assert.equal(ports.plugin, hostPlugin);
    assert.equal(isUnsupported(ports.launcher), false);
  });

  it('tells who a run is from the environment it was built with', () => {
    const { launcher } = adapter.create(hostDeps({ env: { CLAUDE_PROJECT_DIR: join('/', 'work', 'app') } }));
    assert.equal(!isUnsupported(launcher) && launcher.identity().projectDir, join('/', 'work', 'app'));
  });

  it('finds its own folder in the environment it was built with', () => {
    const moved = adapter.create(hostDeps({ env: { CLAUDE_CONFIG_DIR: join('/', 'cfg') } })).paths;
    assert.equal(!isUnsupported(moved) && moved.home(join('/', 'people', 'sam')), join('/', 'cfg'));
  });

  it('reads a hook call for the platform it was built on', () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo a\\\\b' } });
    const readings = (platform: NodeJS.Platform): readonly string[] | undefined => {
      const call = adapter.create(hostDeps({ platform })).hooks.parse(payload)?.call;
      return call?.kind === 'shell' ? call.readings : undefined;
    };
    assert.deepEqual(readings('linux'), ['echo a\\\\b']);
    assert.deepEqual(readings('win32'), ['echo a\\\\b', 'echo a\\b']);
  });
});
