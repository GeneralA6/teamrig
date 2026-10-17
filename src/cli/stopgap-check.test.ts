import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { APP, CliHarness, EVENTS_PATH, SKILLS_DIR, TEAM } from '../testing/cli-harness.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };

async function runAll(kit: CliHarness, steps: readonly (readonly string[])[]): Promise<void> {
  for (const argv of steps) {
    const result = await kit.run(argv, AS_ALPHA);
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  }
}

/** T1 done, T2 open, T3 dropped; tags name all three and an unknown T9 in CLAUDE.md, a rule file and a skill. */
async function taggedKit(config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await runAll(kit, [
    ['add', '--title', 'Ship the pool cap', '--description', 'what and why', '--priority', 'p2'],
    ['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none'],
    ['add', '--title', 'Ship the queue', '--description', 'what and why', '--priority', 'p2'],
    ['add', '--title', 'Ship the cache', '--description', 'what and why', '--priority', 'p3'],
    ['set', 'T3', '--status', 'dropped', '--note', 'not needed'],
  ]);
  await kit.files.write(join(APP, 'CLAUDE.md'), '# Rules\n- cap the pool (stopgap T1)\n- queue (stopgap T2), typo (stopgap T9)\n');
  await kit.files.write(join(APP, '.claude', 'rules', 'cache.md'), 'cache rule, stopgap T3\n');
  await kit.files.write(join(APP, '.claude', 'rules', 'notes.txt'), 'not read: stopgap T1\n');
  await kit.files.write(join(SKILLS_DIR, 'alpha-ship', 'SKILL.md'), '---\nname: alpha-ship\n---\nstep (stopgap T1)\n');
  return kit;
}

function stopgapLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith('STOPGAP-DONE'));
}

/** The places each STOPGAP-DONE line names. */
function placesOf(lines: readonly string[]): (string | undefined)[] {
  return stopgapLines(lines).map((line) => /\(tagged in ([^;]+);/.exec(line)?.[1]);
}

describe('check flags stopgap tags of finished tasks', () => {
  it('names every place of a done or dropped task, and none of an active or unknown one', async () => {
    const kit = await taggedKit();
    const checked = await kit.run(['check', '--all'], AS_ALPHA);
    assert.equal(checked.code, EXIT.ok, checked.stderr.join('\n'));
    const lines = stopgapLines(checked.stdout);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0] ?? '', /^STOPGAP-DONE \(tagged in CLAUDE\.md:2, alpha-ship\/SKILL\.md:4; remove the stopgap\) T1 /);
    assert.match(lines[1] ?? '', /^STOPGAP-DONE \(tagged in \.claude\/rules\/cache\.md:1; replace the task or keep the stopgap by a decision\) T3 /);
  });

  it('reads the files the config names instead', async () => {
    const kit = await taggedKit({ ...TEAM, register: { check: { stopgapFiles: ['.claude/rules/'] } } });
    assert.deepEqual(placesOf((await kit.run(['check', '--all'], AS_ALPHA)).stdout), ['alpha-ship/SKILL.md:4', '.claude/rules/cache.md:1']);
  });

  it('reads a team named by $TEAMRIG_TEAM from the Claude Code project folder, else the working folder', async () => {
    const kit = await taggedKit();
    const elsewhere = join('/', 'elsewhere');
    const tmp = join('/', 'tmp', 'run');
    await kit.files.write(join(elsewhere, 'CLAUDE.md'), 'stopgap T3\n');
    await kit.files.write(join(tmp, 'CLAUDE.md'), '\n\nstopgap T1\n');
    const named = { TEAMRIG_SESSION: 'alpha', TEAMRIG_TEAM: 'app' };
    const project = await kit.run(['check', '--all'], { env: { ...named, CLAUDE_PROJECT_DIR: elsewhere }, cwd: tmp });
    const working = await kit.run(['check', '--all'], { env: named, cwd: tmp });
    assert.deepEqual(placesOf(project.stdout), ['alpha-ship/SKILL.md:4', 'CLAUDE.md:1']);
    assert.deepEqual(placesOf(working.stdout), ['CLAUDE.md:3, alpha-ship/SKILL.md:4']);
  });

  it('finds a done task a compaction retired, through the history', async () => {
    const kit = await taggedKit();
    kit.clock.advance(20 * MS_PER_DAY);
    const compaction = await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    assert.deepEqual(compaction.retiredNow, ['T1', 'T3']);
    const lines = stopgapLines((await kit.run(['check', '--all'], AS_ALPHA)).stdout);
    assert.deepEqual(
      lines.map((line) => /\) (T\d+) /.exec(line)?.[1]),
      ['T1', 'T3'],
    );
  });
});
