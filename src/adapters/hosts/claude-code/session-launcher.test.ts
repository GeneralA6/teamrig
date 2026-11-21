import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { declaration } from './declaration.ts';
import { sessionLauncher } from './session-launcher.ts';

const PROJECT = join('/', 'work', 'app');
const NONE = { projectDir: undefined, startedAs: undefined, sessionKind: undefined, sessionId: undefined };

describe("Claude Code's session launcher", () => {
  it('tells the folder the session started in, how Claude Code was started, the kind of session and its id, each trimmed', () => {
    const env = { CLAUDE_PROJECT_DIR: ` ${PROJECT} `, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_KIND: ' bg ', CLAUDE_CODE_SESSION_ID: ' s-1 ' };
    assert.deepEqual(sessionLauncher(env).identity(), { projectDir: PROJECT, startedAs: 'cli', sessionKind: 'bg', sessionId: 's-1' });
  });

  it('tells nothing of a run no session started, and reads a blank value as none', () => {
    assert.deepEqual(sessionLauncher({}).identity(), NONE);
    assert.deepEqual(sessionLauncher({ CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_ENTRYPOINT: ' ', CLAUDE_CODE_SESSION_KIND: '\t', CLAUDE_CODE_SESSION_ID: ' ' }).identity(), NONE);
  });

  it('reads no variable but its own four', () => {
    const env = { CLAUDE_PROJECT_DIR: PROJECT, PWD: join('/', 'tmp'), CLAUDECODE: '1', TEAMRIG_SESSION: 'dev' };
    assert.deepEqual(sessionLauncher(env).identity(), { ...NONE, projectDir: PROJECT });
  });

  it('hands a run the session variables its declaration names, whatever the environment holds', () => {
    assert.equal(sessionLauncher({}).variables, declaration.sessionVariables);
    assert.equal(sessionLauncher({ CLAUDECODE: '1' }).variables, declaration.sessionVariables);
  });

  it('reads the session id and the start folder from the variables it declares as identity', () => {
    const [sessionId, projectDir] = declaration.sessionVariables.identity;
    assert.deepEqual(sessionLauncher({ [sessionId ?? '']: 's-2', [projectDir ?? '']: PROJECT }).identity(), { ...NONE, projectDir: PROJECT, sessionId: 's-2' });
  });
});
