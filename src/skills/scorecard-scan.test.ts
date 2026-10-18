import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { TranscriptSource } from '../budget/discover.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { promptLine, replyLine, transcript } from '../testing/transcript-lines.ts';
import type { ScorecardSkills } from './scorecard.ts';
import { RUN_IDLE_MS, SCORECARD_DAYS_KEPT, scanTranscripts, type ScanResult } from './scorecard-scan.ts';
import { ScorecardStore } from './scorecard-store.ts';
import { signatureOf } from './signature.ts';

const PROJECTS = join('/', 'c', 'projects');
const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const MAIN = join(PROJECTS, 'app', `${SESSION}.jsonl`);
const SUB = join(PROJECTS, 'app', SESSION, 'subagents', 'agent-a.jsonl');
const STATE = '/kit/state/skills-scorecard.json';
const NOW = Date.parse('2030-01-08T10:00:00Z');
const SINCE = Date.parse('2030-01-02T00:00:00Z');
const SKILLS: ScorecardSkills = {
  names: new Set(['alpha-inbox', 'alpha-ship']),
  signatures: [signatureOf({ name: 'alpha-inbox', text: 'Signature: `teamrig inbox read`' })],
};

let ids = 0;
function bash(at: string, command: string): string {
  ids += 1;
  return replyLine({ id: `m${ids}`, at, usage: { input: 1 }, tools: [{ id: `t${ids}`, name: 'Bash', command }] });
}

function load(at: string, skill: string): string {
  ids += 1;
  return replyLine({ id: `m${ids}`, at, usage: { input: 1 }, tools: [{ id: `t${ids}`, name: 'Skill', skill }] });
}

/** A missed use of alpha-inbox at `at`: a prompt, the signature hit, and the prompt that ends its run. */
function missed(at: string): string[] {
  return [promptLine(at), bash(at, 'teamrig inbox read'), promptLine(at)];
}

class World {
  readonly files = new MemoryFiles();
  readonly transcripts = new MemoryTranscripts();
  readonly clock = new FakeClock(NOW);
  readonly store = new ScorecardStore(this.files, STATE);

  scan(maxBytes = 1024 * 1024, source: TranscriptSource = this.transcripts, since = SINCE): Promise<ScanResult> {
    return scanTranscripts({ source, store: this.store, clock: this.clock }, { projectsDir: PROJECTS, skills: SKILLS, since, maxBytes });
  }
}

function manualRuns(result: ScanResult, day: string): number | undefined {
  return result.state.days[day]?.['alpha-inbox']?.manual.runs;
}

describe('scanTranscripts', () => {
  it('reads every project transcript and its subagents from the first line at or after since', async () => {
    const world = new World();
    world.transcripts.set(MAIN, transcript([...missed('2030-01-01T12:00:00Z'), ...missed('2030-01-07T12:00:00Z')]), NOW);
    world.transcripts.set(SUB, transcript(missed('2030-01-07T13:00:00Z')), NOW);
    const result = await world.scan();
    assert.deepEqual(Object.keys(result.state.days), ['2030-01-07']);
    assert.equal(manualRuns(result, '2030-01-07'), 2);
    assert.equal(result.state.since, '2030-01-02');
    assert.equal(result.files, 2);
    assert.equal(result.catchingUp, false);
  });

  it('reads only what a transcript gained since the last scan, and keeps the first since', async () => {
    const world = new World();
    world.transcripts.set(MAIN, transcript(missed('2030-01-07T12:00:00Z')), NOW);
    const first = await world.scan();
    const unchanged = await world.scan();
    assert.equal(unchanged.bytesRead, 0);
    assert.equal(unchanged.files, 0);
    world.transcripts.append(MAIN, transcript(missed('2030-01-08T09:00:00Z')), NOW);
    const second = await world.scan(1024 * 1024, world.transcripts, Date.parse('2030-01-05T00:00:00Z'));
    assert.ok(second.bytesRead > 0 && second.bytesRead < first.bytesRead * 2);
    assert.equal(manualRuns(second, '2030-01-07'), 1);
    assert.equal(manualRuns(second, '2030-01-08'), 1);
    assert.equal(second.state.since, '2030-01-02');
    assert.deepEqual(await world.store.load(), second.state);
  });

  it('stops at the byte limit and carries on next scan, counting each line once', async () => {
    const world = new World();
    const lines = ['2030-01-03', '2030-01-04', '2030-01-05', '2030-01-06'].flatMap((day) => missed(`${day}T12:00:00Z`));
    world.transcripts.set(MAIN, transcript(lines), NOW);
    const limit = Math.ceil(transcript(lines).length / 3);
    const results: ScanResult[] = [];
    for (let scan = 0; scan < 4; scan += 1) {
      results.push(await world.scan(limit));
    }
    assert.equal(results[0]?.catchingUp, true);
    assert.equal(results.at(-1)?.catchingUp, false);
    const last = results.at(-1);
    assert.ok(last !== undefined);
    assert.deepEqual(
      Object.keys(last.state.days).map((day) => manualRuns(last, day)),
      [1, 1, 1, 1],
    );
  });

  it('waits for a line still being written', async () => {
    const world = new World();
    const whole = transcript(missed('2030-01-07T12:00:00Z'));
    world.transcripts.set(MAIN, `${whole}${bash('2030-01-07T13:00:00Z', 'ls').slice(0, 20)}`, NOW);
    const result = await world.scan();
    assert.equal(result.state.cursors[MAIN]?.offset, Buffer.byteLength(whole));
  });

  it('resumes a file that shrank (rewritten) after its last counted time', async () => {
    const world = new World();
    world.transcripts.set(MAIN, transcript([...missed('2030-01-06T12:00:00Z'), ...missed('2030-01-07T12:00:00Z')]), NOW);
    await world.scan();
    world.transcripts.set(MAIN, transcript(missed('2030-01-08T09:00:00Z')), NOW);
    const result = await world.scan();
    assert.equal(manualRuns(result, '2030-01-07'), 1);
    assert.equal(manualRuns(result, '2030-01-08'), 1);
  });

  it('charges the open runs of a thread idle a day, and keeps those of a live one open', async () => {
    const world = new World();
    world.transcripts.set(MAIN, transcript([promptLine('2030-01-07T09:00:00Z'), load('2030-01-07T09:00:00Z', 'alpha-ship')]), NOW);
    world.transcripts.set(SUB, transcript([promptLine('2030-01-08T09:00:00Z'), load('2030-01-08T09:00:00Z', 'alpha-ship')]), NOW);
    const result = await world.scan();
    assert.equal(NOW - Date.parse('2030-01-07T09:00:00Z') >= RUN_IDLE_MS, true);
    assert.equal(result.state.days['2030-01-07']?.['alpha-ship']?.skill.runs, 1);
    assert.equal(result.state.days['2030-01-08']?.['alpha-ship']?.skill.runs, 0);
    assert.equal(result.state.cursors[SUB]?.open.length, 1);
    assert.equal(result.state.cursors[MAIN]?.open.length, 0);
  });

  it(`drops days and cursors older than ${SCORECARD_DAYS_KEPT} days, and never reads from before them`, async () => {
    const world = new World();
    world.transcripts.set(MAIN, transcript(missed('2030-01-07T12:00:00Z')), NOW);
    await world.scan();
    world.clock.advance(SCORECARD_DAYS_KEPT * 24 * 3_600_000);
    world.transcripts.set(SUB, transcript([...missed('2030-01-07T12:00:00Z'), ...missed('2030-04-09T12:00:00Z')]), world.clock.now());
    const result = await world.scan(1024 * 1024, world.transcripts, 0);
    assert.deepEqual(Object.keys(result.state.days), ['2030-04-09']);
    assert.deepEqual(Object.keys(result.state.cursors), [SUB]);
  });

  it('skips a transcript removed while the scan runs', async () => {
    const world = new World();
    world.transcripts.set(MAIN, transcript(missed('2030-01-07T12:00:00Z')), NOW);
    const gone: TranscriptSource = {
      entries: (dir) => world.transcripts.entries(dir),
      changedAt: (path) => world.transcripts.changedAt(path),
      size: () => Promise.resolve(undefined),
      read: (path, offset, length) => world.transcripts.read(path, offset, length),
    };
    const result = await world.scan(1024 * 1024, gone);
    assert.deepEqual(result.state.cursors, {});
  });
});
