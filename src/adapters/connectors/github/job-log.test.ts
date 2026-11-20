import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXCERPT_LINES, EXCERPT_WIDTH, failedLogExcerpt } from './job-log.ts';

const TIME = '2026-11-15T16:02:11.1234567Z';
const KEEP = (text: string): string => text;

/** One line as `gh run view --log-failed` prints it. */
function line(step: string, text: string): string {
  return `test (ubuntu-latest)\t${step}\t${TIME} ${text}`;
}

describe('failedLogExcerpt', () => {
  it("gives the last failed step and its lines, without the time at each line's head", () => {
    const stdout = [line('Install', 'npm warn old'), line('Run tests', 'not ok 3 - parses'), line('Run tests', 'Error: Process completed with exit code 1.'), ''].join('\n');
    assert.deepEqual(failedLogExcerpt(stdout, KEEP), { step: 'Run tests', lines: ['not ok 3 - parses', 'Error: Process completed with exit code 1.'] });
  });

  it('keeps only the last lines, each cut to its width', () => {
    const many = Array.from({ length: EXCERPT_LINES + 5 }, (_, at) => line('Run tests', `line ${at}`));
    const excerpt = failedLogExcerpt([...many, line('Run tests', 'x'.repeat(EXCERPT_WIDTH + 50))].join('\r\n'), KEEP);
    assert.equal(excerpt.lines.length, EXCERPT_LINES);
    assert.equal(excerpt.lines[0], 'line 6');
    assert.equal(excerpt.lines.at(-1), `${'x'.repeat(EXCERPT_WIDTH - 1)}…`);
  });

  it('writes each line plain: no colour sequence, control or format character, and no tab of its own', () => {
    const stdout = line('Run\ttests', '\u001b[31mred\u001b[0m\rover‮back\u0007bell');
    assert.deepEqual(failedLogExcerpt(stdout, KEEP), { step: 'Run', lines: ['tests 2026-11-15T16:02:11.1234567Z red over back bell'] });
  });

  it('redacts each whole line before it is cut, and the step too', () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const redact = (text: string): string => text.replaceAll(secret, '[redacted token]');
    const long = `${'y'.repeat(EXCERPT_WIDTH - 10)} ${secret}`;
    const excerpt = failedLogExcerpt(line(`step ${secret}`, long), redact);
    assert.equal(excerpt.step, 'step [redacted token]');
    assert.ok(!(excerpt.lines[0] ?? '').includes('ghp_'), excerpt.lines[0]);
  });

  it('gives no step and no lines for a log with nothing to read', () => {
    assert.deepEqual(failedLogExcerpt('', KEEP), { step: undefined, lines: [] });
    assert.deepEqual(failedLogExcerpt('no tabs here\n', KEEP), { step: undefined, lines: [] });
  });
});
