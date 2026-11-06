import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSCRIPT_TAIL_BYTES } from '../names/title.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { contextEstimateOf, contextTokensOf, ESTIMATE_BYTES_PER_TOKEN, readContextEstimate, readContextTokens } from './usage.ts';

interface Usage {
  readonly input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
}

/** A transcript line the way Claude Code writes an assistant reply. */
function reply(usage: Usage, isSidechain = false): string {
  return JSON.stringify({ type: 'assistant', isSidechain, message: { role: 'assistant', usage: { ...usage, output_tokens: 50 } } });
}

/** A user line of exactly `bytes` bytes, its line end included. */
function userLine(bytes: number): string {
  const line = (content: string): string => `${JSON.stringify({ type: 'user', isSidechain: false, message: { content } })}\n`;
  return line('x'.repeat(bytes - line('').length));
}

const PROMPT = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'go' } });
const MAIN = reply({ input_tokens: 2, cache_creation_input_tokens: 1_791, cache_read_input_tokens: 97_347 });
const TRANSCRIPT = '/t/session.jsonl';

describe('contextTokensOf', () => {
  it("adds the last main-thread reply's input, cache-creation and cache-read tokens", () => {
    const older = reply({ input_tokens: 5, cache_read_input_tokens: 10 });
    assert.equal(contextTokensOf([older, PROMPT, MAIN, PROMPT].join('\n'), false), 99_140);
  });

  it("skips a subagent's reply, a damaged line and a line that only mentions usage", () => {
    const sidechain = reply({ input_tokens: 1, cache_read_input_tokens: 400_000 }, true);
    const damaged = MAIN.slice(0, -2);
    const mention = JSON.stringify({ type: 'user', isSidechain: false, message: { content: '"usage" is in the text' } });
    assert.equal(contextTokensOf([MAIN, sidechain, damaged, mention, '{"usage": ['].join('\n'), false), 99_140);
  });

  it('skips a reply without usage, with damaged numbers, or that read nothing', () => {
    const lines = [
      MAIN,
      JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [] } }),
      JSON.stringify({ type: 'assistant', isSidechain: false, usage: {}, message: { usage: 'none' } }),
      reply({ input_tokens: -1, cache_read_input_tokens: 5 }),
      reply({ input_tokens: 1.5 }),
      reply({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 9 } } }),
    ];
    assert.equal(contextTokensOf(lines.join('\n'), false), 99_140);
  });

  it('counts a missing cache field as 0', () => {
    assert.equal(contextTokensOf(reply({ input_tokens: 1_234 }), false), 1_234);
  });

  it('skips the first line of a cut tail, which may be the end of a longer line', () => {
    const tail = `${reply({ input_tokens: 7 })}\n${PROMPT}`;
    assert.equal(contextTokensOf(tail, false), 7);
    assert.equal(contextTokensOf(tail, true), undefined);
  });

  it('is unknown when no line tells', () => {
    assert.equal(contextTokensOf('', false), undefined);
    assert.equal(contextTokensOf(PROMPT, false), undefined);
  });

  it('reads Windows line ends', () => {
    assert.equal(contextTokensOf(`${PROMPT}\r\n${MAIN}\r\n`, false), 99_140);
  });
});

describe('readContextTokens', () => {
  it('reads a short transcript whole, its first line included', async () => {
    const files = new MemoryFiles();
    await files.write(TRANSCRIPT, `${MAIN}\n${PROMPT}\n`);
    assert.equal(await readContextTokens(files, TRANSCRIPT), 99_140);
  });

  it('reads only the tail of a long transcript', async () => {
    const files = new MemoryFiles();
    const head = `${reply({ input_tokens: 1 })}\n`.repeat(10);
    const body = userLine(TRANSCRIPT_TAIL_BYTES);
    await files.write(TRANSCRIPT, `${head}${body}`);
    assert.equal(await readContextTokens(files, TRANSCRIPT), undefined);
    await files.write(TRANSCRIPT, `${head}${body}${MAIN}\n`);
    assert.equal(await readContextTokens(files, TRANSCRIPT), 99_140);
  });

  it("takes a tail as long as the limit as cut, so its first line is skipped, and a shorter one as whole", async () => {
    const files = new MemoryFiles();
    const first = `${MAIN}\n`;
    await files.write(TRANSCRIPT, `${first}${userLine(TRANSCRIPT_TAIL_BYTES - first.length)}`);
    assert.equal(await readContextTokens(files, TRANSCRIPT), undefined);
    await files.write(TRANSCRIPT, `${first}${userLine(TRANSCRIPT_TAIL_BYTES - first.length - 1)}`);
    assert.equal(await readContextTokens(files, TRANSCRIPT), 99_140);
  });

  it('is unknown for a missing transcript', async () => {
    assert.equal(await readContextTokens(new MemoryFiles(), TRANSCRIPT), undefined);
  });
});

/** The estimate for text whose last main-thread reply read 99,140 tokens and starts the `since` text. */
function estimate(since: string): number {
  return 99_140 + Math.ceil(Buffer.byteLength(since, 'utf8') / ESTIMATE_BYTES_PER_TOKEN);
}

describe('contextEstimateOf', () => {
  it("adds the last main-thread reply and every line after it, a byte share each, to that reply's context", () => {
    const result = userLine(30_000);
    assert.equal(ESTIMATE_BYTES_PER_TOKEN, 3);
    assert.equal(contextEstimateOf([PROMPT, MAIN, result].join('\n'), false), estimate(`${MAIN}\n${result}`));
    assert.equal(estimate(`${MAIN}\n${result}`) > 99_140 + 10_000, true, 'a 30,000-byte result adds at least 10,000');
    assert.equal(contextEstimateOf(MAIN, false), estimate(MAIN), 'the reply alone');
  });

  it("counts a subagent's reply after it as bytes, never as the context", () => {
    const sidechain = reply({ input_tokens: 1, cache_read_input_tokens: 400_000 }, true);
    assert.equal(contextEstimateOf([MAIN, sidechain].join('\n'), false), estimate(`${MAIN}\n${sidechain}`));
  });

  it('is unknown when no line tells, the first line of a cut tail included', () => {
    assert.equal(contextEstimateOf(PROMPT, false), undefined);
    assert.equal(contextEstimateOf(`${MAIN}\n${PROMPT}`, true), undefined);
  });
});

describe('readContextEstimate', () => {
  it('reads only the tail of a long transcript', async () => {
    const files = new MemoryFiles();
    const head = `${reply({ input_tokens: 1 })}\n`.repeat(10);
    const body = userLine(TRANSCRIPT_TAIL_BYTES);
    await files.write(TRANSCRIPT, `${head}${body}`);
    assert.equal(await readContextEstimate(files, TRANSCRIPT), undefined);
    await files.write(TRANSCRIPT, `${head}${body}${MAIN}\n`);
    assert.equal(await readContextEstimate(files, TRANSCRIPT), estimate(`${MAIN}\n`));
  });

  it('is unknown for a missing transcript', async () => {
    assert.equal(await readContextEstimate(new MemoryFiles(), TRANSCRIPT), undefined);
  });
});
