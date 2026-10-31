import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { keepSummaryFile, summaryMinute, summaryPct } from './summary-file.ts';

const PATH = '/kit/teams/app/state/usage/some.week.json';
const FORMAT = 2;
const TEXT = JSON.stringify({ v: FORMAT, usedPct: 15 });

describe('summaryPct and summaryMinute', () => {
  it('round a percent to hundredths and a time down to its minute', () => {
    assert.equal(summaryPct(30.123_45), 30.12);
    assert.equal(summaryPct(119.375), 119.38);
    assert.equal(summaryPct(0), 0);
    const minute = Date.parse('2030-01-08T10:00:00Z');
    assert.equal(summaryMinute(minute), minute);
    assert.equal(summaryMinute(minute + 59_999), minute);
  });
});

describe('keepSummaryFile', () => {
  it('writes the text, and again only when it changes', async () => {
    const files = new MemoryFiles();
    assert.equal(await keepSummaryFile(files, PATH, TEXT, FORMAT), true);
    assert.equal(await files.read(PATH), TEXT);
    assert.equal(await keepSummaryFile(files, PATH, TEXT, FORMAT), false, 'the same text is not written again');
    const next = JSON.stringify({ v: FORMAT, usedPct: 15.01 });
    assert.equal(await keepSummaryFile(files, PATH, next, FORMAT), true);
    assert.equal(await files.read(PATH), next);
  });

  it('replaces a damaged file, and one of an older format', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, '{"v":2,"usedP');
    assert.equal(await keepSummaryFile(files, PATH, TEXT, FORMAT), true);
    assert.equal(await files.read(PATH), TEXT);
    await files.write(PATH, JSON.stringify({ v: FORMAT - 1, usedPct: 1 }));
    assert.equal(await keepSummaryFile(files, PATH, TEXT, FORMAT), true);
    assert.equal(await files.read(PATH), TEXT);
  });

  it('leaves a file a newer teamrig wrote as it is, without failing', async () => {
    const files = new MemoryFiles();
    const newer = JSON.stringify({ v: FORMAT + 1, usedPct: 1 });
    await files.write(PATH, newer);
    assert.equal(await keepSummaryFile(files, PATH, TEXT, FORMAT), false);
    assert.equal(await files.read(PATH), newer);
  });
});
