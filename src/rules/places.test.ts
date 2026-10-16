import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { claudeMemoryDir } from '../doctor/context-files.ts';
import { MemoryFiles, MemoryPathProbe, normalisePath } from '../testing/memory-files.ts';
import { findRulePlaces, isPlaceKind, NESTED_FOLDERS_MAX, type RulePlace, type RulePlaceLocations } from './places.ts';

const USER_HOME = resolve('/', 'u');
const CLAUDE_DIR = join(USER_HOME, '.claude');
const PROJECT = resolve('/', 'work', 'app');
const AT: RulePlaceLocations = {
  claudeDir: CLAUDE_DIR,
  userHome: USER_HOME,
  project: PROJECT,
  skills: join(CLAUDE_DIR, 'skills'),
  teamRules: resolve('/', 'kit', 'teams', 'app', 'rules.md'),
};

const SETTINGS = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node', args: ['~/.claude/hooks/policy.cjs'] }] },
      { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.js" --quiet' }] },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/own.js' },
          { type: 'command', command: 'sh hooks/start.sh' },
          { type: 'command', command: 'node /nowhere/gone.js' },
          { type: 'prompt', prompt: 'Is this safe?' },
          'not a hook',
        ],
      },
    ],
    Stop: 'not a list',
  },
};

function world(extra: Readonly<Record<string, string>> = {}): { files: MemoryFiles; probe: MemoryPathProbe } {
  const files = new MemoryFiles({
    [join(CLAUDE_DIR, 'CLAUDE.md')]: 'user',
    [join(PROJECT, 'CLAUDE.md')]: 'project',
    [join(PROJECT, '.claude', 'CLAUDE.md')]: 'project, hidden',
    [resolve('/', 'work', 'CLAUDE.local.md')]: 'parent',
    [join(PROJECT, 'api', 'CLAUDE.md')]: 'depth 1',
    [join(PROJECT, 'packages', 'web', 'CLAUDE.local.md')]: 'depth 2',
    [join(PROJECT, 'a', 'b', 'c', 'CLAUDE.md')]: 'depth 3',
    [join(PROJECT, 'a', 'b', 'c', 'd', 'CLAUDE.md')]: 'depth 4, too deep',
    [join(PROJECT, 'node_modules', 'pkg', 'CLAUDE.md')]: 'installed',
    [join(PROJECT, '.git', 'CLAUDE.md')]: 'hidden',
    [join(PROJECT, 'README.md')]: 'not a rule file',
    [join(PROJECT, '.claude', 'rules', 'deploy.md')]: 'rules',
    [join(PROJECT, '.claude', 'rules', 'db', 'store.MD')]: 'rules, nested',
    [join(PROJECT, '.claude', 'rules', 'notes.txt')]: 'not markdown',
    [join(PROJECT, '.claude', 'rules', 'a', 'b', 'c', 'd', 'e.md')]: 'rules, too deep',
    [join(CLAUDE_DIR, 'rules', 'global.md')]: 'user rules',
    [join(CLAUDE_DIR, 'skills', 'web-deploy', 'SKILL.md')]: 'skill',
    [join(CLAUDE_DIR, 'skills', 'cache', 'readme.md')]: 'not a skill',
    [join(PROJECT, '.claude', 'skills', 'api-check', 'SKILL.md')]: 'project skill',
    [join(claudeMemoryDir(CLAUDE_DIR, PROJECT), 'MEMORY.md')]: 'index',
    [join(claudeMemoryDir(CLAUDE_DIR, PROJECT), 'feedback.md')]: 'memory',
    [AT.teamRules]: 'team rules',
    [join(CLAUDE_DIR, 'settings.json')]: JSON.stringify(SETTINGS),
    [join(PROJECT, '.claude', 'settings.local.json')]: '\uFEFF{"autoMode": {}}',
    [join(PROJECT, '.claude', 'settings.json')]: 'not json',
    [join(CLAUDE_DIR, 'hooks', 'policy.cjs')]: 'script',
    [join(PROJECT, '.claude', 'hooks', 'guard.js')]: 'script',
    [join(PROJECT, 'hooks', 'start.sh')]: 'script',
    ...extra,
  });
  return { files, probe: new MemoryPathProbe(files) };
}

function shown(places: readonly RulePlace[]): string[] {
  return places.map((place) => `${place.kind} ${normalisePath(place.path)}`);
}

describe('findRulePlaces', () => {
  it('finds every place a local rule can override a core rule, each once, grouped by kind', async () => {
    const { files, probe } = world();
    const { places, nestedCapped } = await findRulePlaces(files, probe, AT);
    const path = (...parts: string[]) => normalisePath(join(...parts));
    assert.deepEqual(shown(places), [
      `claude-md ${path(CLAUDE_DIR, 'CLAUDE.md')}`,
      `claude-md ${path(PROJECT, 'CLAUDE.md')}`,
      `claude-md ${path(PROJECT, '.claude', 'CLAUDE.md')}`,
      `claude-md ${path(resolve('/', 'work', 'CLAUDE.local.md'))}`,
      `claude-md ${path(PROJECT, 'api', 'CLAUDE.md')}`,
      `claude-md ${path(PROJECT, 'packages', 'web', 'CLAUDE.local.md')}`,
      `claude-md ${path(PROJECT, 'a', 'b', 'c', 'CLAUDE.md')}`,
      `rules ${path(PROJECT, '.claude', 'rules', 'db', 'store.MD')}`,
      `rules ${path(PROJECT, '.claude', 'rules', 'deploy.md')}`,
      `rules ${path(CLAUDE_DIR, 'rules', 'global.md')}`,
      `skill ${path(CLAUDE_DIR, 'skills', 'web-deploy', 'SKILL.md')}`,
      `skill ${path(PROJECT, '.claude', 'skills', 'api-check', 'SKILL.md')}`,
      `memory ${path(claudeMemoryDir(CLAUDE_DIR, PROJECT), 'MEMORY.md')}`,
      `memory ${path(claudeMemoryDir(CLAUDE_DIR, PROJECT), 'feedback.md')}`,
      `team-rules ${path(AT.teamRules)}`,
      `hook ${path(CLAUDE_DIR, 'hooks', 'policy.cjs')}`,
      `hook ${path(PROJECT, '.claude', 'hooks', 'guard.js')}`,
      `hook ${path(PROJECT, 'hooks', 'start.sh')}`,
      `settings ${path(CLAUDE_DIR, 'settings.json')}`,
      `settings ${path(PROJECT, '.claude', 'settings.json')}`,
      `settings ${path(PROJECT, '.claude', 'settings.local.json')}`,
    ]);
    assert.equal(nestedCapped, false);
  });

  it('lists a file once when the project is the home folder', async () => {
    const files = new MemoryFiles({ [join(CLAUDE_DIR, 'CLAUDE.md')]: 'user' });
    const { places } = await findRulePlaces(files, new MemoryPathProbe(files), { ...AT, project: USER_HOME });
    assert.deepEqual(shown(places), [`claude-md ${normalisePath(join(CLAUDE_DIR, 'CLAUDE.md'))}`]);
  });

  it(`stops looking for CLAUDE.md files below the project after ${NESTED_FOLDERS_MAX} folders, and says so`, async () => {
    const folders = Object.fromEntries(Array.from({ length: NESTED_FOLDERS_MAX + 1 }, (_, index) => [join(PROJECT, `f${String(index).padStart(5, '0')}`, 'x.txt'), 'x']));
    const files = new MemoryFiles({ ...folders, [join(PROJECT, 'zz', 'CLAUDE.md')]: 'past the cap' });
    const { places, nestedCapped } = await findRulePlaces(files, new MemoryPathProbe(files), AT);
    assert.equal(nestedCapped, true);
    assert.deepEqual(places, []);
  });

  it('names its kinds', () => {
    assert.equal(isPlaceKind('memory'), true);
    assert.equal(isPlaceKind('memories'), false);
  });
});
