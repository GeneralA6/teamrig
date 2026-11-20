import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostPaths } from './paths.ts';

const USER_HOME = join('/', 'people', 'sam');
const SYSTEM_TEMP = join('/', 'tmp');

/** The paths in `env` on the platform the spec runs on, whose separators its `join` writes. */
function pathsIn(env: Parameters<typeof hostPaths>[0]): ReturnType<typeof hostPaths> {
  return hostPaths(env, process.platform);
}

describe("Claude Code's paths", () => {
  it('keeps its own folder at .claude in the home folder, unless CLAUDE_CONFIG_DIR moves it', () => {
    assert.equal(pathsIn({}).home(USER_HOME), join(USER_HOME, '.claude'));
    assert.equal(pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).home(USER_HOME), join('/', 'cfg'));
    assert.equal(pathsIn({ CLAUDE_CONFIG_DIR: ` ${join('/', 'cfg')} ` }).home(USER_HOME), join('/', 'cfg'), 'trimmed');
    assert.equal(pathsIn({ CLAUDE_CONFIG_DIR: ' ' }).home(USER_HOME), join(USER_HOME, '.claude'), 'a blank one moves nothing');
  });

  it("keeps every session's scratchpad under the system's temporary folder, unless CLAUDE_CODE_TMPDIR moves them", () => {
    assert.equal(pathsIn({}).scratchpads(SYSTEM_TEMP), join(SYSTEM_TEMP, 'claude', '*', '*', 'scratchpad'));
    assert.equal(pathsIn({ CLAUDE_CODE_TMPDIR: join('/', 'scratch') }).scratchpads(SYSTEM_TEMP), join('/', 'scratch', 'claude', '*', '*', 'scratchpad'));
    assert.equal(pathsIn({ CLAUDE_CODE_TMPDIR: ' ' }).scratchpads(SYSTEM_TEMP), join(SYSTEM_TEMP, 'claude', '*', '*', 'scratchpad'), 'a blank one moves nothing');
  });

  it("names a session's scratchpad by its transcript's project folder and file name, a folder its pattern matches", () => {
    const transcript = join('/', 'cfg', 'projects', 'C--work-app', '6f1c2d3e.jsonl');
    assert.equal(pathsIn({}).scratchpadOf(transcript, SYSTEM_TEMP), join(SYSTEM_TEMP, 'claude', 'C--work-app', '6f1c2d3e', 'scratchpad'));
    assert.equal(pathsIn({ CLAUDE_CODE_TMPDIR: join('/', 'scratch') }).scratchpadOf(transcript, SYSTEM_TEMP), join('/', 'scratch', 'claude', 'C--work-app', '6f1c2d3e', 'scratchpad'));
  });

  it("keeps a project's memory, a session's plan and the shell snapshots in its own folder, wherever that one is", () => {
    const moved = pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') });
    assert.equal(pathsIn({}).memoryFolders(USER_HOME), join(USER_HOME, '.claude', 'projects', '*', 'memory'));
    assert.equal(moved.memoryFolders(USER_HOME), join('/', 'cfg', 'projects', '*', 'memory'));
    assert.equal(pathsIn({}).planFile(USER_HOME, 'quiet-river-otter'), join(USER_HOME, '.claude', 'plans', 'quiet-river-otter.md'));
    assert.equal(moved.planFile(USER_HOME, 'quiet-river-otter'), join('/', 'cfg', 'plans', 'quiet-river-otter.md'));
    assert.equal(pathsIn({}).shellSnapshots(USER_HOME), join(USER_HOME, '.claude', 'shell-snapshots'));
    assert.equal(moved.shellSnapshots(USER_HOME), join('/', 'cfg', 'shell-snapshots'));
  });

  it("loads a person's skills from the skills folder of its own folder, wherever that one is", () => {
    assert.equal(pathsIn({}).skills(USER_HOME), join(USER_HOME, '.claude', 'skills'));
    assert.equal(pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).skills(USER_HOME), join('/', 'cfg', 'skills'));
  });

  it("loads a person's instruction file, rules and agent types from its own folder, wherever that one is", () => {
    const moved = pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') });
    assert.equal(pathsIn({}).userInstructions(USER_HOME), join(USER_HOME, '.claude', 'CLAUDE.md'));
    assert.equal(moved.userInstructions(USER_HOME), join('/', 'cfg', 'CLAUDE.md'));
    assert.equal(pathsIn({}).userRules(USER_HOME), join(USER_HOME, '.claude', 'rules'));
    assert.equal(moved.userRules(USER_HOME), join('/', 'cfg', 'rules'));
    assert.equal(pathsIn({}).userAgents(USER_HOME), join(USER_HOME, '.claude', 'agents'));
    assert.equal(moved.userAgents(USER_HOME), join('/', 'cfg', 'agents'));
  });

  it("reads a folder's instruction file, the person's local one there, then the one in its own folder there", () => {
    const folder = join('/', 'work', 'app');
    const files = [join(folder, 'CLAUDE.md'), join(folder, 'CLAUDE.local.md'), join(folder, '.claude', 'CLAUDE.md')];
    assert.deepEqual(pathsIn({}).folderInstructions(folder), files);
    assert.deepEqual(pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).folderInstructions(folder), files, 'the variable moves no project file');
  });

  it("loads a project's rules, skills and agent types from the project folder, wherever its own folder is", () => {
    const project = join('/', 'work', 'app');
    for (const paths of [pathsIn({}), pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') })]) {
      assert.equal(paths.projectRules(project), join(project, '.claude', 'rules'));
      assert.equal(paths.projectSkills(project), join(project, '.claude', 'skills'));
      assert.equal(paths.projectAgents(project), join(project, '.claude', 'agents'));
    }
  });

  it("keeps a project's memory in a folder named by the project's path, each character but a letter or digit a dash", () => {
    const moved = pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') });
    assert.equal(pathsIn({}).memoryFolder(USER_HOME, 'C:\\Work\\my_app.v2'), join(USER_HOME, '.claude', 'projects', 'C--Work-my-app-v2', 'memory'));
    assert.equal(moved.memoryFolder(USER_HOME, '/work/app'), join('/', 'cfg', 'projects', '-work-app', 'memory'));
    assert.equal(moved.memoryIndex(USER_HOME, '/work/app'), join('/', 'cfg', 'projects', '-work-app', 'memory', 'MEMORY.md'));
  });

  it("reads a person's settings from its own folder, wherever that one is", () => {
    assert.equal(pathsIn({}).userSettings(USER_HOME), join(USER_HOME, '.claude', 'settings.json'));
    assert.equal(pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).userSettings(USER_HOME), join('/', 'cfg', 'settings.json'));
  });

  it("reads a folder's shared settings, then the person's local ones there, wherever its own folder is", () => {
    const project = join('/', 'work', 'app');
    const files = [
      { path: join(project, '.claude', 'settings.json'), kind: 'shared' },
      { path: join(project, '.claude', 'settings.local.json'), kind: 'local' },
    ];
    assert.deepEqual(pathsIn({}).folderSettings(project), files);
    assert.deepEqual(pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).folderSettings(project), files, 'the variable moves no project file');
  });

  it("makes a project's worktrees under the project folder, wherever its own folder is", () => {
    const project = join('/', 'work', 'app');
    assert.equal(pathsIn({}).worktrees(project), join(project, '.claude', 'worktrees'));
    assert.equal(pathsIn({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }).worktrees(project), join(project, '.claude', 'worktrees'));
  });

  it('reads a path at or below one of its worktrees as the same place in the project (T1593)', () => {
    const linux = hostPaths({}, 'linux');
    const windows = hostPaths({}, 'win32');
    assert.equal(linux.worktreeRepo('/work/app/.claude/worktrees/t1'), '/work/app');
    assert.equal(linux.worktreeRepo('/work/app/.claude/worktrees/t1/web/src'), '/work/app/web/src');
    assert.equal(windows.worktreeRepo('C:\\Work\\App\\.claude\\worktrees\\t1'), 'C:\\Work\\App');
    assert.equal(windows.worktreeRepo('C:/Work/App/.claude/worktrees/t1/web'), 'C:/Work/App/web');
    assert.equal(hostPaths({ CLAUDE_CONFIG_DIR: '/cfg' }, 'linux').worktreeRepo('/work/app/.claude/worktrees/t1'), '/work/app', 'the variable moves no project file');
  });

  it('keeps a project at a root at that root, with the separator of the platform', () => {
    assert.equal(hostPaths({}, 'linux').worktreeRepo('/.claude/worktrees/t1'), '/');
    assert.equal(hostPaths({}, 'win32').worktreeRepo('C:\\.claude\\worktrees\\t1'), 'C:\\');
  });

  it('matches the worktree folder names in any case only where the filesystem ignores case', () => {
    assert.equal(hostPaths({}, 'win32').worktreeRepo('C:\\Work\\App\\.Claude\\Worktrees\\t1'), 'C:\\Work\\App');
    assert.equal(hostPaths({}, 'darwin').worktreeRepo('/work/app/.Claude/Worktrees/t1'), '/work/app');
    assert.equal(hostPaths({}, 'linux').worktreeRepo('/work/app/.Claude/Worktrees/t1'), undefined);
  });

  it('reads no worktree in the project folder, another folder of its own there, the worktrees folder itself or a like name', () => {
    const linux = hostPaths({}, 'linux');
    for (const path of ['/work/app', '/work/app/.claude/skills/check', '/work/app/.claude/worktrees', '/work/app/.claude/worktrees/', '/work/app/claude/worktrees/t1']) {
      assert.equal(linux.worktreeRepo(path), undefined, path);
    }
  });

  it("names its login, its prompt history and a folder's local settings as the files whose content is a secret", () => {
    assert.deepEqual(pathsIn({}).secretFiles(), ['~/.claude/.credentials.json', '~/.claude/history.jsonl', '**/.claude/settings.local.json']);
  });

  it('reads the environment of the run it was built for, not a later one', () => {
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: join('/', 'first') };
    const paths = pathsIn({ ...env });
    env['CLAUDE_CONFIG_DIR'] = join('/', 'second');
    assert.equal(paths.home(USER_HOME), join('/', 'first'));
  });
});
