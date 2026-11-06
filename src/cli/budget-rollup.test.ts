import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseRollup, rollupFileName, ROLLUP_IN_STATE, type TeamDayRollup } from '../budget/rollup-file.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { CliHarness, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { promptLine, replyLine, transcript } from '../testing/transcript-lines.ts';
import { EXIT } from './runtime.ts';

/** The harness clock is Tuesday 2030-01-08 10:00 UTC, so the last closed UTC day is the 7th. */
const TODAY = '2030-01-08';
const YESTERDAY = '2030-01-07';
const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const ALPHA_TAB = '0000000a-0000-4000-8000-000000000001';
const WEB_TAB = '0000000b-0000-4000-8000-000000000002';
const ALPHA_PATH = join(PROJECT, `${ALPHA_TAB}.jsonl`);
const WEB_PATH = join(PROJECT, `${WEB_TAB}.jsonl`);

function dayPath(day: string, home = TEAM_HOME): string {
  return join(home, 'state', ...ROLLUP_IN_STATE, rollupFileName(day));
}

function titled(title: string): string {
  return JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 'x' });
}

function reply(id: string, at: string, input: number): string {
  return replyLine({ id, requestId: `q-${id}`, at, usage: { input } });
}

/** A turn of `input` tokens at 09:00 UTC on `day`. */
function turnOn(day: string, id: string, input: number): readonly string[] {
  return [promptLine(`${day}T09:00:00.000Z`), reply(id, `${day}T09:00:05.000Z`, input)];
}

/** The tab titled alpha, with one turn on the last closed day. */
function source(kit: CliHarness): MemoryTranscripts {
  return new MemoryTranscripts({ [ALPHA_PATH]: transcript([titled('alpha'), ...turnOn(YESTERDAY, 'a1', 1_000)]) }, kit.clock.now());
}

function ok(result: CliResult): readonly string[] {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout;
}

function usageError(result: CliResult, message: RegExp): void {
  assert.equal(result.code, EXIT.usage, [...result.stdout, ...result.stderr].join('\n'));
  assert.match(result.stderr.join('\n'), message);
}

function rollupAt(kit: CliHarness, path: string): TeamDayRollup {
  const rollup = parseRollup(kit.files.get(path) ?? '');
  assert.ok(rollup, `no rollup at ${path}`);
  return rollup;
}

function totalW(rollup: TeamDayRollup): number {
  return rollup.rows.reduce((sum, { w }) => sum + w, 0);
}

describe('budget rollup', () => {
  it('previews the last closed day and writes nothing without --apply', async () => {
    const kit = new CliHarness();
    const lines = ok(await kit.run(['budget', 'rollup'], { transcripts: source(kit) }));
    assert.match(lines[0] ?? '', new RegExp(`^PREVIEW .*rollup, ${YESTERDAY} to ${YESTERDAY}: 1 inserted, 0 unchanged, 0 changed; nothing written \\(add --apply to write\\)$`));
    assert.match(lines[1] ?? '', new RegExp(`^  ${YESTERDAY} inserted: 1 rows, 0 task rows, \\d+ bytes$`));
    assert.equal(kit.files.get(dayPath(YESTERDAY)), undefined);
  });

  it('writes the day with --apply, under the team and the session that worked it', async () => {
    const kit = new CliHarness();
    const lines = ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts: source(kit) }));
    assert.match(lines[0] ?? '', new RegExp(`^WROTE .*rollup, ${YESTERDAY} to ${YESTERDAY}: 1 inserted, 0 unchanged, 0 changed; 1 written$`));
    const rollup = rollupAt(kit, dayPath(YESTERDAY));
    assert.equal(rollup.team, 'app');
    assert.equal(rollup.day, YESTERDAY);
    assert.deepEqual(
      rollup.rows.map(({ session }) => session),
      ['alpha'],
    );
    assert.ok(totalW(rollup) > 0);
  });

  it('has nothing to do once the last closed day is on disk', async () => {
    const kit = new CliHarness();
    const transcripts = source(kit);
    ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    const written = kit.files.get(dayPath(YESTERDAY));
    const lines = ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    assert.match(lines[0] ?? '', /^UP TO DATE .*rollup: nothing to roll up$/);
    assert.equal(kit.files.get(dayPath(YESTERDAY)), written);
  });

  it('goes on from the day after the newest on disk, so a missed day is not lost', async () => {
    const kit = new CliHarness();
    const transcripts = source(kit);
    ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    transcripts.append(ALPHA_PATH, transcript(turnOn(TODAY, 'a2', 2_000)), kit.clock.now());
    kit.clock.advance(2 * MS_PER_DAY);
    const lines = ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    assert.match(lines[0] ?? '', /, 2030-01-08 to 2030-01-09: 1 inserted, 0 unchanged, 0 changed; 1 written$/);
    assert.equal(rollupAt(kit, dayPath(TODAY)).rows.length, 1);
    assert.equal(kit.files.get(dayPath('2030-01-09')), undefined, 'a day with no use has no file');
  });

  it('gives the same file when a day is read again from the same transcripts', async () => {
    const kit = new CliHarness();
    const transcripts = source(kit);
    const range = ['--from', YESTERDAY, '--to', YESTERDAY];
    ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    const written = kit.files.get(dayPath(YESTERDAY));
    const lines = ok(await kit.run(['budget', 'rollup', ...range, '--apply', '--rewrite'], { transcripts }));
    assert.match(lines[0] ?? '', /: 0 inserted, 1 unchanged, 0 changed; 0 written$/);
    assert.equal(kit.files.get(dayPath(YESTERDAY)), written);
  });

  it('keeps a day that now reads differently unless --rewrite replaces it', async () => {
    const kit = new CliHarness();
    const transcripts = source(kit);
    const range = ['--from', YESTERDAY, '--to', YESTERDAY];
    ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    const written = kit.files.get(dayPath(YESTERDAY));
    const before = totalW(rollupAt(kit, dayPath(YESTERDAY)));
    transcripts.append(ALPHA_PATH, transcript(turnOn(YESTERDAY, 'a2', 2_000)), kit.clock.now());

    const kept = ok(await kit.run(['budget', 'rollup', ...range, '--apply'], { transcripts }));
    assert.match(kept[0] ?? '', /: 0 inserted, 0 unchanged, 1 changed; 0 written; 1 changed left as they are \(add --rewrite to replace them\)$/);
    assert.equal(kit.files.get(dayPath(YESTERDAY)), written);

    const replaced = ok(await kit.run(['budget', 'rollup', ...range, '--apply', '--rewrite'], { transcripts }));
    assert.match(replaced[0] ?? '', /: 0 inserted, 0 unchanged, 1 changed; 1 written$/);
    assert.ok(totalW(rollupAt(kit, dayPath(YESTERDAY))) > before);
  });

  it('leaves a session marked in another team of the tree to that team', async () => {
    const kit = await treeHarness();
    const mark = { v: 1, area: 'front', line: 0, at: `${YESTERDAY}T08:00:00.000Z`, claudeSession: WEB_TAB, lastLineHash: null };
    await kit.files.append(join(teamHomeOf('web'), 'state', 'inbox-marks.jsonl'), `${JSON.stringify(mark)}\n`);
    const transcripts = source(kit);
    transcripts.set(WEB_PATH, transcript([titled('alpha'), ...turnOn(YESTERDAY, 'w1', 5_000)]), kit.clock.now());

    ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts }));
    const own = rollupAt(kit, dayPath(YESTERDAY));
    ok(await kit.run(['budget', 'rollup', '--apply'], { transcripts, env: { TEAMRIG_TEAM: 'web' } }));
    const web = rollupAt(kit, dayPath(YESTERDAY, teamHomeOf('web')));

    assert.deepEqual(
      own.rows.map(({ session }) => session),
      ['alpha'],
    );
    assert.deepEqual(
      web.rows.map(({ session }) => session),
      ['front'],
    );
    assert.ok(totalW(web) > totalW(own));
  });

  it('refuses --rewrite without --apply, so a rewrite is never only a preview', async () => {
    const kit = new CliHarness();
    usageError(await kit.run(['budget', 'rollup', '--rewrite'], { transcripts: source(kit) }), /--rewrite needs --apply/);
  });

  it('refuses a day that is no day', async () => {
    const kit = new CliHarness();
    usageError(await kit.run(['budget', 'rollup', '--from', '2030-13-40'], { transcripts: source(kit) }), /--from "2030-13-40" is not a day, YYYY-MM-DD/);
  });

  it('refuses a day that has not closed', async () => {
    const kit = new CliHarness();
    usageError(await kit.run(['budget', 'rollup', '--to', TODAY], { transcripts: source(kit) }), /--to 2030-01-08 is not a closed day/);
  });

  it('refuses --from after --to', async () => {
    const kit = new CliHarness();
    usageError(await kit.run(['budget', 'rollup', '--from', YESTERDAY, '--to', '2030-01-06'], { transcripts: source(kit) }), /--from 2030-01-07 is after --to 2030-01-06/);
  });
});
