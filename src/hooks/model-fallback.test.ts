import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { FALLBACK_TAIL_BYTES, fallbackLine, lastFallbackOf, readLastFallback, type ModelFallback } from './model-fallback.ts';

const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-4-8';
const SWITCH: ModelFallback = { id: 'd1a87003-e004-4233-8310-9cf5c77cca16', from: FABLE, to: OPUS, category: 'cyber' };

/** A main-thread reply from `model`, as Claude Code writes it. */
function reply(model: string, isSidechain = false): string {
  return JSON.stringify({ type: 'assistant', isSidechain, requestedModel: model, message: { model, role: 'assistant', content: [] } });
}

/** The switch entry Claude Code 2.1.300 writes, trimmed to the fields that matter here. */
function fallback(fields: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    isSidechain: false,
    type: 'system',
    subtype: 'model_refusal_fallback',
    content: 'Switched to Opus 4.8.',
    trigger: 'refusal',
    scope: 'session',
    originalModel: FABLE,
    fallbackModel: OPUS,
    apiRefusalCategory: 'cyber',
    uuid: SWITCH.id,
    ...fields,
  });
}

function lines(...entries: readonly string[]): string {
  return `${entries.join('\n')}\n`;
}

describe('lastFallbackOf', () => {
  it('finds the switch while the session still runs on the fallback model', () => {
    assert.deepEqual(lastFallbackOf(lines(reply(FABLE), fallback(), reply(OPUS), reply(OPUS)), false), SWITCH);
    assert.deepEqual(lastFallbackOf(lines(reply(FABLE), fallback()), false), SWITCH, 'no reply after it yet');
  });

  it('finds nothing without a switch, or once the user switched back', () => {
    assert.equal(lastFallbackOf(lines(reply(FABLE), reply(FABLE)), false), undefined);
    assert.equal(lastFallbackOf(lines(fallback(), reply(OPUS), reply(FABLE)), false), undefined);
    assert.equal(lastFallbackOf('', false), undefined);
  });

  it('takes the last switch, and ignores subagents, made-up replies and damaged lines', () => {
    const later = fallback({ uuid: 'later', originalModel: 'claude-opus-5-5', apiRefusalCategory: undefined });
    assert.deepEqual(lastFallbackOf(lines(fallback(), reply(FABLE), later, reply(OPUS)), false), { id: 'later', from: 'claude-opus-5-5', to: OPUS, category: undefined });
    assert.deepEqual(lastFallbackOf(lines(fallback(), reply(FABLE, true), reply('<synthetic>'), '{"fallbackModel": broken', '{"type":"assistant"'), false), SWITCH);
    assert.equal(lastFallbackOf(lines(fallback({ isSidechain: true })), false), undefined);
  });

  it('needs both models, and two different ones, and keys a switch with no uuid by its models', () => {
    assert.equal(lastFallbackOf(lines(fallback({ originalModel: undefined })), false), undefined);
    assert.equal(lastFallbackOf(lines(fallback({ fallbackModel: FABLE })), false), undefined);
    assert.equal(lastFallbackOf(lines(fallback({ type: 'assistant' })), false), undefined);
    assert.equal(lastFallbackOf(lines(fallback({ uuid: undefined })), false)?.id, `${FABLE}>${OPUS}`);
  });

  it('skips the first line of a cut tail, which may be partial', () => {
    assert.equal(lastFallbackOf(lines(fallback(), reply(OPUS)), true), undefined);
    assert.deepEqual(lastFallbackOf(lines(reply(FABLE), fallback(), reply(OPUS)), true), SWITCH);
  });
});

describe('readLastFallback', () => {
  const TRANSCRIPT = join('/', 'projects', 'app', 'session.jsonl');

  it('reads the switch from the transcript, and nothing from a missing one', async () => {
    const files = new MemoryFiles();
    assert.equal(await readLastFallback(files, TRANSCRIPT), undefined);
    await files.write(TRANSCRIPT, lines(reply(FABLE), fallback(), reply(OPUS)));
    assert.deepEqual(await readLastFallback(files, TRANSCRIPT), SWITCH);
  });

  it('reads only the tail, so a switch further back is not found', async () => {
    const files = new MemoryFiles();
    const filler = reply(OPUS);
    const count = Math.ceil(FALLBACK_TAIL_BYTES / (filler.length + 1)) + 1;
    await files.write(TRANSCRIPT, lines(fallback(), ...Array.from({ length: count }, () => filler)));
    assert.equal(await readLastFallback(files, TRANSCRIPT), undefined);
  });
});

describe('fallbackLine', () => {
  it('names both models, the category and the command back to the team model or the old one', () => {
    assert.equal(
      fallbackLine('app-lead', SWITCH, 'opus'),
      'MODEL app-lead now runs model claude-opus-4-8, not claude-fable-5-1: Claude Code switched after its safeguards stopped a reply (cyber) and keeps it for this session; type /model opus to switch back',
    );
    assert.equal(
      fallbackLine('app-alpha', { ...SWITCH, category: undefined }, undefined),
      'MODEL app-alpha now runs model claude-opus-4-8, not claude-fable-5-1: Claude Code switched after its safeguards stopped a reply and keeps it for this session; type /model claude-fable-5-1 to switch back',
    );
  });
});
