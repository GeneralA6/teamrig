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

  it("keeps every session's scratchpad under the system's temporary folder, unless CLAUDE_CODE_TMPDIR moves them", () => {
    assert.equal(hostPaths({}).scratchpads(SYSTEM_TEMP), join(SYSTEM_TEMP, 'claude', '*', '*', 'scratchpad'));
    assert.equal(hostPaths({ CLAUDE_CODE_TMPDIR: join('/', 'scratch') }).scratchpads(SYSTEM_TEMP), join('/', 'scratch', 'claude', '*', '*', 'scratchpad'));
    assert.equal(hostPaths({ CLAUDE_CODE_TMPDIR: ' ' }).scratchpads(SYSTEM_TEMP), join(SYSTEM_TEMP, 'claude', '*', '*', 'scratchpad'), 'a blank one moves nothing');
  });

  it("names a session's scratchpad by its transcript's project folder and file name, a folder its pattern matches", () => {
    const transcript = join('/', 'cfg', 'projects', 'C--work-app', '6f1c2d3e.jsonl');
    assert.equal(hostPaths({}).scratchpadOf(transcript, SYSTEM_TEMP), join(SYSTEM_TEMP, 'claude', 'C--work-app', '6f1c2d3e', 'scratchpad'));
    assert.equal(hostPaths({ CLAUDE_CODE_TMPDIR: join('/', 'scratch') }).scratchpadOf(transcript, SYSTEM_TEMP), join('/', 'scratch', 'claude', 'C--work-app', '6f1c2d3e', 'scratchpad'));
  });

  it("keeps a project's memory, a session's plan and the shell snapshots in its own folder, wherever that one is", () => {
    const moved = hostPaths({ CLAUDE_CONFIG_DIR: join('/', 'cfg') });
    assert.equal(hostPaths({}).memoryFolders(USER_HOME), join(USER_HOME, '.claude', 'projects', '*', 'memory'));
    assert.equal(moved.memoryFolders(USER_HOME), join('/', 'cfg', 'projects', '*', 'memory'));
    assert.equal(hostPaths({}).planFile(USER_HOME, 'quiet-river-otter'), join(USER_HOME, '.claude', 'plans', 'quiet-river-otter.md'));
    assert.equal(moved.planFile(USER_HOME, 'quiet-river-otter'), join('/', 'cfg', 'plans', 'quiet-river-otter.md'));
    assert.equal(hostPaths({}).shellSnapshots(USER_HOME), join(USER_HOME, '.claude', 'shell-snapshots'));
    assert.equal(moved.shellSnapshots(USER_HOME), join('/', 'cfg', 'shell-snapshots'));
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
