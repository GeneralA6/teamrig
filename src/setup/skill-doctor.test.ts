import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { claudeSkillDoctor, parseSkillDoctor, SKILL_DOCTOR_ARGS, SKILL_DOCTOR_TIMEOUT_MS } from './skill-doctor.ts';

const CLAUDE = 'C:\\bin\\claude.exe';
const PROJECT = 'C:\\work\\app';

/** As Claude Code 2.1.312 printed it (10-28), cut to one row of each kind. */
const TABLE = [
  'Skills loaded this session',
  '',
  '  skill                                source           context  7d tokens   uses  last used',
  '  release-notes-draft                  userSettings           -          -     0×  never',
  '  teamrig-hook-load-trace              userSettings         ~80          -     0×  never',
  '  anthropic-skills:chrome-browser      claude.ai sync      < 20          -     5×  9 days',
  '  teamrig:daily-meeting                teamrig              ~60       1.3m     1×  2 days',
  '  teamrig:hire                         teamrig              ~50          -     1×  1 day',
  '  a row cut short',
  '  old-habit                            userSettings         ~40          -     4×  3 weeks',
  '  dev-update-docs                      projectSettings      ~60      26.2m    10×  today',
  '',
  '  context = this skill\'s one-line listing in the system prompt, included every turn',
  '  stray                                userSettings         ~40          -     1×  today',
];

describe('parseSkillDoctor', () => {
  it('reads each row from the header to the first blank line, leaving out a row it cannot read', () => {
    assert.deepEqual(parseSkillDoctor(TABLE), [
      { name: 'release-notes-draft', source: 'userSettings', listed: 0, uses: 0, lastUsedDays: undefined },
      { name: 'teamrig-hook-load-trace', source: 'userSettings', listed: 80, uses: 0, lastUsedDays: undefined },
      { name: 'anthropic-skills:chrome-browser', source: 'claude.ai sync', listed: 20, uses: 5, lastUsedDays: 9 },
      { name: 'teamrig:daily-meeting', source: 'teamrig', listed: 60, uses: 1, lastUsedDays: 2 },
      { name: 'teamrig:hire', source: 'teamrig', listed: 50, uses: 1, lastUsedDays: 1 },
      { name: 'old-habit', source: 'userSettings', listed: 40, uses: 4, lastUsedDays: undefined },
      { name: 'dev-update-docs', source: 'projectSettings', listed: 60, uses: 10, lastUsedDays: 0 },
    ]);
  });

  it('is undefined with no table header', () => {
    assert.equal(parseSkillDoctor(['Unknown command: /skill-doctor']), undefined);
  });

  it('is empty for a header with no rows', () => {
    assert.deepEqual(parseSkillDoctor(TABLE.slice(0, 3)), []);
  });
});

function doctorOf(hooks: FakeHooks, path: string): ReturnType<typeof claudeSkillDoctor> {
  return claudeSkillDoctor({ env: { PATH: path }, platform: 'win32', probe: new FakePathProbe({ files: [CLAUDE] }), files: new MemoryFiles(), node: 'C:\\node\\node.exe', hooks });
}

describe('claudeSkillDoctor', () => {
  it('runs /skill-doctor headless in the project, bounded, with no shell, and reads its table', async () => {
    const hooks = new FakeHooks().answer([CLAUDE, ...SKILL_DOCTOR_ARGS], { lines: TABLE });
    const read = await doctorOf(hooks, 'C:\\bin').read(PROJECT);
    assert.equal(read.kind, 'read');
    assert.equal(read.kind === 'read' ? read.skills.length : 0, 7);
    const [request] = hooks.ran;
    assert.deepEqual(request?.argv, [CLAUDE, '-p', '/skill-doctor', '--no-session-persistence', '--strict-mcp-config', '--no-chrome', '--settings', '{"disableAllHooks":true}']);
    assert.equal(request?.cwd, PROJECT);
    assert.equal(request?.timeoutMs, SKILL_DOCTOR_TIMEOUT_MS);
  });

  it('is skipped without running anything when Claude Code is not on PATH', async () => {
    const hooks = new FakeHooks();
    assert.deepEqual(await doctorOf(hooks, 'C:\\elsewhere').read(PROJECT), { kind: 'skipped', why: 'Claude Code is not on PATH' });
    assert.deepEqual(hooks.ran, []);
  });

  it('is skipped with how the run ended when it fails or runs out of time', async () => {
    const failed = new FakeHooks().answer([CLAUDE, ...SKILL_DOCTOR_ARGS], { lines: TABLE, end: 1 });
    const slow = new FakeHooks().answer([CLAUDE, ...SKILL_DOCTOR_ARGS], { end: { kind: 'timedOut' } });
    assert.deepEqual(await doctorOf(failed, 'C:\\bin').read(PROJECT), { kind: 'skipped', why: 'claude -p /skill-doctor exited 1' });
    assert.deepEqual(await doctorOf(slow, 'C:\\bin').read(PROJECT), { kind: 'skipped', why: 'claude -p /skill-doctor was killed at its time limit' });
  });

  it('is skipped when the Claude Code it ran prints no table', async () => {
    const hooks = new FakeHooks().answer([CLAUDE, ...SKILL_DOCTOR_ARGS], { lines: ['Unknown command: /skill-doctor'] });
    assert.deepEqual(await doctorOf(hooks, 'C:\\bin').read(PROJECT), { kind: 'skipped', why: 'claude -p /skill-doctor printed no skill table' });
  });
});
