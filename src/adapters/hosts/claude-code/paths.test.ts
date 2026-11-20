import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostPaths } from './paths.ts';

const USER_HOME = join('/', 'people', 'sam');
const SYSTEM_TEMP = join('/', 'tmp');

describe("Claude Code's paths", () => {
  it('keeps its own folder at .claude in the home folder, unless CLAUDE_CONFIG_DIR moves it', () => {
    assert.equal(hostPaths({}).home(USER_HOME), join(USER_HOME, '.claude'));
    assert.equal(hostPaths({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).home(USER_HOME), join('/', 'cfg'));
    assert.equal(hostPaths({ CLAUDE_CONFIG_DIR: ` ${join('/', 'cfg')} ` }).home(USER_HOME), join('/', 'cfg'), 'trimmed');
    assert.equal(hostPaths({ CLAUDE_CONFIG_DIR: ' ' }).home(USER_HOME), join(USER_HOME, '.claude'), 'a blank one moves nothing');
  });

  it("keeps its temporary files under the system's folder, unless CLAUDE_CODE_TMPDIR moves them", () => {
    assert.equal(hostPaths({}).temp(SYSTEM_TEMP), SYSTEM_TEMP);
    assert.equal(hostPaths({ CLAUDE_CODE_TMPDIR: join('/', 'scratch') }).temp(SYSTEM_TEMP), join('/', 'scratch'));
    assert.equal(hostPaths({ CLAUDE_CODE_TMPDIR: ' ' }).temp(SYSTEM_TEMP), SYSTEM_TEMP, 'a blank one moves nothing');
  });

  it("loads a person's skills from the skills folder of its own folder, wherever that one is", () => {
    assert.equal(hostPaths({}).skills(USER_HOME), join(USER_HOME, '.claude', 'skills'));
    assert.equal(hostPaths({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).skills(USER_HOME), join('/', 'cfg', 'skills'));
  });

  it('reads the environment of the run it was built for, not a later one', () => {
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: join('/', 'first') };
    const paths = hostPaths({ ...env });
    env['CLAUDE_CONFIG_DIR'] = join('/', 'second');
    assert.equal(paths.home(USER_HOME), join('/', 'first'));
  });
});
