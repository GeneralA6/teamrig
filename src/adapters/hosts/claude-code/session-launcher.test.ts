import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sessionLauncher } from './session-launcher.ts';

const PROJECT = join('/', 'work', 'app');

describe("Claude Code's session launcher", () => {
  it('tells the folder the session started in, how Claude Code was started and the kind of session, each trimmed', () => {
    const env = { CLAUDE_PROJECT_DIR: ` ${PROJECT} `, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_KIND: ' bg ' };
    assert.deepEqual(sessionLauncher(env).identity(), { projectDir: PROJECT, startedAs: 'cli', sessionKind: 'bg' });
  });

  it('tells nothing of a run no session started, and reads a blank value as none', () => {
    const none = { projectDir: undefined, startedAs: undefined, sessionKind: undefined };
    assert.deepEqual(sessionLauncher({}).identity(), none);
    assert.deepEqual(sessionLauncher({ CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_ENTRYPOINT: ' ', CLAUDE_CODE_SESSION_KIND: '\t' }).identity(), none);
  });

  it('reads no variable but its own three', () => {
    const env = { CLAUDE_PROJECT_DIR: PROJECT, PWD: join('/', 'tmp'), CLAUDE_CODE_SESSION_ID: 's-1', TEAMRIG_SESSION: 'dev' };
    assert.deepEqual(sessionLauncher(env).identity(), { projectDir: PROJECT, startedAs: undefined, sessionKind: undefined });
  });
});
