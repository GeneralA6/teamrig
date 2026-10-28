import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptLine, replyLine, resultsLine, transcript, type FixtureTool } from '../testing/transcript-lines.ts';
import { chainOf, nudgeLine, type Chain } from './loop-nudge.ts';

const AT = '2026-10-15T10:00:00.000Z';
const CONTEXT = 100_000;

let next = 0;
function tool(name: string, command?: string): FixtureTool {
  next += 1;
  return command === undefined ? { id: `t${next}`, name } : { id: `t${next}`, name, command };
}

/** One reply calling these tools, with its results line after it. */
function call(...tools: FixtureTool[]): string[] {
  next += 1;
  const reply = replyLine({ id: `m${next}`, requestId: `r${next}`, at: AT, usage: { cacheRead: CONTEXT, output: 50 }, tools });
  return [reply, resultsLine(AT, tools.map((each) => ({ id: each.id, text: 'ok' })))];
}

function chain(lines: readonly string[]): Chain {
  return chainOf(transcript(lines), false, undefined);
}

const read = (): FixtureTool => tool('Read');
const edit = (): FixtureTool => tool('Edit');
const test = (): FixtureTool => tool('Bash', 'node --test src/a.test.ts');

describe('chainOf', () => {
  it('counts the single-step calls that end the turn, with the last reply context', () => {
    const lines = [promptLine(AT), ...call(read()), ...call(tool('Grep')), ...call(tool('Bash', 'git status'))];
    assert.deepEqual(chain(lines), { length: 3, editThenTest: false, context: CONTEXT });
  });

  it('starts again at a prompt, so a run never spans two turns', () => {
    assert.equal(chain([...call(read()), ...call(read()), promptLine(AT), ...call(read())]).length, 1);
  });

  it('ends the run at a call with several tools or one tool of another kind', () => {
    assert.equal(chain([promptLine(AT), ...call(read()), ...call(read(), read()), ...call(read())]).length, 1);
    assert.equal(chain([promptLine(AT), ...call(read()), ...call(tool('Agent')), ...call(read()), ...call(edit())]).length, 2);
    assert.equal(chain([promptLine(AT), ...call(read()), ...call(tool('Bash', 'node script.cjs'))]).length, 0);
  });

  it('joins the lines of one reply, so parallel tools written one per line are one call', () => {
    const first = read();
    const second = read();
    const reply = { id: 'mJ', requestId: 'rJ', at: AT, usage: { cacheRead: CONTEXT } };
    const lines = [promptLine(AT), ...call(read()), replyLine({ ...reply, tools: [first] }), replyLine({ ...reply, tools: [second] })];
    assert.equal(chain(lines).length, 0);
  });

  it('skips a helper reply (a sidechain) inside the turn', () => {
    const helper = replyLine({ id: 'mS', requestId: 'rS', at: AT, sidechain: true, usage: { cacheRead: 5 }, tools: [tool('Agent')] });
    assert.deepEqual(chain([promptLine(AT), ...call(read()), helper, ...call(read())]), { length: 2, editThenTest: false, context: CONTEXT });
  });

  it('sees an edit and then its test in separate calls, but not an edit and its test in one', () => {
    assert.equal(chain([promptLine(AT), ...call(read()), ...call(edit()), ...call(test())]).editThenTest, true);
    assert.equal(chain([promptLine(AT), ...call(test()), ...call(edit())]).editThenTest, false);
    assert.equal(chain([promptLine(AT), ...call(edit(), test()), ...call(read())]).editThenTest, false);
  });

  it('counts the tool the hook fires for when its reply is not written yet, once', () => {
    const lines = [promptLine(AT), ...call(read()), ...call(read())];
    const current = { id: 'tNew', name: 'Grep', command: undefined };
    assert.deepEqual(chainOf(transcript(lines), false, current), { length: 3, editThenTest: false, context: CONTEXT });
    const written = read();
    const withReply = [...lines, ...call(written)];
    assert.equal(chainOf(transcript(withReply), false, { id: written.id, name: 'Read', command: undefined }).length, 3);
  });

  it('skips the first line of a cut tail, which may start mid-line', () => {
    const lines = [promptLine(AT), ...call(read()), ...call(read())];
    const text = transcript(lines);
    assert.equal(chainOf(text.slice(10), true, undefined).length, 2);
    assert.equal(chainOf(transcript([...call(read()), ...lines.slice(1)]), true, undefined).length, 2);
  });

  it('is empty for a turn with no calls, with context 0', () => {
    assert.deepEqual(chainOf('', false, undefined), { length: 0, editThenTest: false, context: 0 });
  });
});

describe('nudgeLine', () => {
  const run: Chain = { length: 3, editThenTest: false, context: 130_000 };

  it('speaks once, as the run reaches the threshold, pricing the re-reads after the first call and naming the one-call form', () => {
    assert.equal(
      nudgeLine(run, 3),
      'teamrig: 3 single-step calls in a row this turn (about 26k W of re-reads at this context); send independent reads and lookups as several tool calls in one message, join shell steps into one command, and send an edit with its re-test.',
    );
    assert.equal(nudgeLine({ ...run, length: 2 }, 3), undefined);
    assert.equal(nudgeLine({ ...run, length: 4 }, 3), undefined);
  });

  it('names the edit and test split when it saw one', () => {
    assert.match(
      nudgeLine({ ...run, editThenTest: true }, 3) ?? '',
      /an edit and then its test went in separate calls: send an edit with its re-test in one message, and independent reads as several tool calls in one\.$/,
    );
  });

  it('never speaks when the threshold is 0', () => {
    assert.equal(nudgeLine({ ...run, length: 0 }, 0), undefined);
  });
});
