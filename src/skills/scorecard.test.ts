import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptLine } from '../budget/line.ts';
import { promptLine, replyLine, resultsLine, type FixtureTool } from '../testing/transcript-lines.ts';
import { EMPTY_TALLY, isRefusal, LOAD_WINDOW_CALLS, newThread, ScorecardTally, ThreadFold, type ScorecardSkills, type SkillDay } from './scorecard.ts';
import { signatureOf } from './signature.ts';

const DAY = '2030-01-08';
const START = Date.parse(`${DAY}T09:00:00.000Z`);
const SKILLS: ScorecardSkills = {
  names: new Set(['alpha-inbox', 'alpha-ship']),
  signatures: [signatureOf({ name: 'alpha-inbox', text: 'Signature: `teamrig inbox read`' }), signatureOf({ name: 'alpha-ship', text: 'Signature: `ship\\.ts`' })],
};
const DENIED = 'Permission for this action was denied by the Claude Code auto mode. Reason: x';

function at(minute: number): string {
  return new Date(START + minute * 60_000).toISOString();
}

type Tool = Omit<FixtureTool, 'id'>;

/** Lines built in order; each tool gets the id `t<n>`, counted across the whole fixture. */
class Lines {
  readonly lines: string[] = [];
  private next = 0;

  prompt(minute: number, text = 'go'): this {
    this.lines.push(promptLine(at(minute), text));
    return this;
  }

  call(minute: number, ...tools: Tool[]): this {
    const withIds = tools.map((tool) => ({ ...tool, id: `t${(this.next += 1)}` }));
    this.lines.push(replyLine({ id: `m${this.next}`, at: at(minute), usage: { input: 1 }, tools: withIds }));
    return this;
  }

  bash(minute: number, command: string): this {
    return this.call(minute, { name: 'Bash', command });
  }

  background(minute: number, command: string): this {
    return this.call(minute, { name: 'Bash', command, background: true });
  }

  /** A task notification for the tool `t<n>`. */
  notification(minute: number, tool: number): this {
    return this.prompt(minute, `<task-notification>\n<task-id>b${tool}</task-id>\n<tool-use-id>t${tool}</tool-use-id>\n</task-notification>`);
  }

  error(minute: number, text: string): this {
    this.lines.push(resultsLine(at(minute), [{ id: `t${this.next}`, text, isError: true }]));
    return this;
  }
}

function fold(lines: readonly string[], skills: ScorecardSkills = SKILLS): { tally: ScorecardTally; thread: ThreadFold } {
  const tally = new ScorecardTally({});
  const thread = new ThreadFold(newThread(0, 0, START), tally, skills);
  for (const raw of lines) {
    const line = parseTranscriptLine(raw);
    if (line !== undefined) {
      thread.line(line);
    }
  }
  return { tally, thread };
}

function dayOf(tally: ScorecardTally, skill: string, day = DAY): SkillDay | undefined {
  return tally.days()[day]?.[skill];
}

describe('ThreadFold', () => {
  it("charges a loaded skill's run its calls, failures and refusals when the next prompt starts new work", () => {
    const lines = new Lines()
      .prompt(1)
      .call(2, { name: 'Skill', skill: 'alpha-ship' })
      .bash(3, 'npm test')
      .error(3, 'boom')
      .bash(4, 'git push')
      .error(4, `<tool_use_error>${DENIED}</tool_use_error>`)
      .prompt(5).lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-ship'), { loads: 1, skill: { runs: 1, calls: 2, failed: 1, refused: 1 }, manual: EMPTY_TALLY, edits: 0 });
  });

  it('keeps a run going through a resumed compaction, and leaves it open at the end', () => {
    const summary = JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' }, timestamp: at(4) });
    const lines = new Lines().prompt(1).call(2, { name: 'Skill', skill: 'alpha-ship' }).bash(3, 'a').lines;
    const { tally, thread } = fold([...lines, summary, ...new Lines().bash(5, 'b').lines]);
    assert.equal(dayOf(tally, 'alpha-ship')?.skill.runs, 0);
    assert.deepEqual(thread.cursor(9, 9).open, [{ skill: 'alpha-ship', mode: 'skill', day: DAY, calls: 2, failed: 0, refused: 0, waitsOn: [] }]);
    thread.closeAll();
    assert.deepEqual(dayOf(tally, 'alpha-ship')?.skill, { runs: 1, calls: 2, failed: 0, refused: 0 });
    assert.deepEqual(thread.cursor(9, 9).open, []);
  });

  it('keeps a run going through notifications only while a background step of its own is running', () => {
    const lines = new Lines()
      .prompt(1)
      .call(2, { name: 'Skill', skill: 'alpha-ship' })
      .background(3, 'node ship.ts plan')
      .background(3, 'npm run lint')
      .notification(4, 3)
      .notification(5, 2)
      .bash(6, 'git push')
      .background(6, 'node ship.ts merge')
      .notification(7, 3)
      .bash(8, 'teamrig worktree remove')
      .notification(9, 5)
      .bash(10, 'ls')
      .prompt(11, '<task-notification>done</task-notification>').lines;
    const { tally, thread } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-ship')?.skill, { runs: 1, calls: 6, failed: 0, refused: 0 });
    assert.deepEqual(thread.cursor(9, 9).open, []);
  });

  it('ends a run at a notification of another task, a hand run as a loaded one', () => {
    const lines = new Lines().prompt(1).bash(2, 'teamrig inbox read').background(3, 'npm test').notification(4, 2).bash(5, 'ls').prompt(6, '<task-notification>done</task-notification>').lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-inbox')?.manual, { runs: 1, calls: 2, failed: 0, refused: 0 });
  });

  it('passes the waits of a hand run on to the run of a skill loaded mid-procedure', () => {
    const lines = new Lines().prompt(1).background(2, 'node ship.ts plan').call(3, { name: 'Skill', skill: 'alpha-ship' }).notification(4, 1).bash(5, 'git push').prompt(6).lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-ship'), { loads: 1, skill: { runs: 1, calls: 1, failed: 0, refused: 0 }, manual: EMPTY_TALLY, edits: 0 });
  });

  it('loads a skill typed as a slash command, and skips commands and Skill calls that are not installed skills', () => {
    const lines = new Lines()
      .prompt(1, '<command-name>/alpha-ship</command-name>')
      .bash(2, 'ls')
      .call(2, { name: 'Skill', skill: 'zulu-other' })
      .prompt(3, '<command-name>/clear</command-name>').lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-ship'), { loads: 1, skill: { runs: 1, calls: 2, failed: 0, refused: 0 }, manual: EMPTY_TALLY, edits: 0 });
    assert.deepEqual(Object.keys(tally.days()[DAY] ?? {}), ['alpha-ship']);
  });

  it('counts a signature hit with no load before it as one missed use, whose run lasts to the next prompt', () => {
    const lines = new Lines().prompt(1).bash(2, 'teamrig inbox read').bash(3, 'teamrig inbox read --all').bash(4, 'ls').error(4, 'no such file').prompt(5).lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-inbox'), { loads: 0, skill: EMPTY_TALLY, manual: { runs: 1, calls: 3, failed: 1, refused: 0 }, edits: 0 });
  });

  it(`takes a hit within ${LOAD_WINDOW_CALLS} calls of a load for the skill at work, and a later one for a missed use`, () => {
    const filler = Array.from({ length: LOAD_WINDOW_CALLS }, (): Tool => ({ name: 'Bash', command: 'ls' }));
    const lines = new Lines()
      .prompt(1)
      .call(2, { name: 'Skill', skill: 'alpha-inbox' })
      .prompt(3)
      .bash(4, 'teamrig inbox read')
      .call(5, ...filler)
      .prompt(6)
      .bash(7, 'teamrig inbox read')
      .prompt(8).lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-inbox'), {
      loads: 1,
      skill: { runs: 1, calls: 0, failed: 0, refused: 0 },
      manual: { runs: 1, calls: 1, failed: 0, refused: 0 },
      edits: 0,
    });
  });

  it("drops the hand run when the skill loads mid-procedure, and a reload continues the skill's run", () => {
    const lines = new Lines()
      .prompt(1)
      .bash(2, 'teamrig inbox read')
      .call(3, { name: 'Skill', skill: 'alpha-inbox' })
      .bash(4, 'a')
      .call(5, { name: 'Skill', skill: 'alpha-inbox' })
      .bash(6, 'b')
      .prompt(7).lines;
    const { tally } = fold(lines);
    assert.deepEqual(dayOf(tally, 'alpha-inbox'), { loads: 2, skill: { runs: 1, calls: 3, failed: 0, refused: 0 }, manual: EMPTY_TALLY, edits: 0 });
  });

  it("counts writes and edits of a skill's own files, not reads, other folders or skills not installed", () => {
    const lines = new Lines()
      .call(1, { name: 'Write', path: '/u/.claude/skills/alpha-ship/SKILL.md' })
      .call(2, { name: 'Edit', path: 'C:\\u\\.claude\\skills\\alpha-ship\\steps.md' })
      .call(3, { name: 'Read', path: '/u/.claude/skills/alpha-ship/SKILL.md' })
      .call(4, { name: 'Edit', path: '/u/.claude/skills/zulu-other/SKILL.md' })
      .call(5, { name: 'Edit', path: '/work/skills/alpha-ship/SKILL.md' }).lines;
    const { tally } = fold(lines);
    assert.equal(dayOf(tally, 'alpha-ship')?.edits, 2);
    assert.equal(dayOf(tally, 'zulu-other'), undefined);
  });

  it('counts a line with no readable time on the day of the line before it', () => {
    const untimed = replyLine({ id: 'm', usage: { input: 1 }, tools: [{ id: 's', name: 'Skill', skill: 'alpha-ship' }] });
    const tally = new ScorecardTally({});
    const thread = new ThreadFold(newThread(0, 0, Date.parse('2030-01-07T23:00:00Z')), tally, SKILLS);
    const line = parseTranscriptLine(untimed);
    assert.ok(line !== undefined);
    thread.line(line);
    assert.equal(dayOf(tally, 'alpha-ship', '2030-01-07')?.loads, 1);
  });

  it('charges a run to the day it started on, and resumes from a cursor as if the read never stopped', () => {
    const first = new Lines().prompt(1).call(2, { name: 'Skill', skill: 'alpha-ship' }).bash(3, 'a').lines;
    const next = new Lines().bash(24 * 60, 'b').prompt(24 * 60 + 1).lines;
    const whole = fold([...first, ...next]).tally.days();
    const tally = new ScorecardTally({});
    const thread = new ThreadFold(newThread(0, 0, START), tally, SKILLS);
    for (const raw of first) {
      const line = parseTranscriptLine(raw);
      if (line !== undefined) {
        thread.line(line);
      }
    }
    const resumed = new ThreadFold(thread.cursor(10, 10), tally, SKILLS);
    for (const raw of next) {
      const line = parseTranscriptLine(raw);
      if (line !== undefined) {
        resumed.line(line);
      }
    }
    assert.deepEqual(tally.days(), whole);
    assert.deepEqual(Object.keys(whole), [DAY]);
    assert.equal(whole[DAY]?.['alpha-ship']?.skill.calls, 2);
  });
});

describe('ScorecardTally', () => {
  it('adds to the days it starts from without changing them', () => {
    const start = { [DAY]: { 'alpha-ship': { loads: 1, skill: EMPTY_TALLY, manual: EMPTY_TALLY, edits: 0 } } };
    const tally = new ScorecardTally(start);
    tally.load(DAY, 'alpha-ship');
    tally.close({ skill: 'alpha-ship', mode: 'manual', day: DAY, calls: 2, failed: 1, refused: 0, waitsOn: [] });
    assert.equal(start[DAY]['alpha-ship'].loads, 1);
    assert.deepEqual(tally.days()[DAY]?.['alpha-ship'], { loads: 2, skill: EMPTY_TALLY, manual: { runs: 1, calls: 2, failed: 1, refused: 0 }, edits: 0 });
  });
});

describe('isRefusal', () => {
  it('reads a guard or permission refusal, bare or in a tool_use_error, and not a failing step', () => {
    assert.equal(isRefusal(DENIED), true);
    assert.equal(isRefusal(`<tool_use_error>  This session is isolated in the worktree x</tool_use_error>`), true);
    assert.equal(isRefusal("The user doesn't want to proceed with this tool use."), true);
    assert.equal(isRefusal('Exit code 1\nnpm ERR!'), false);
  });
});
