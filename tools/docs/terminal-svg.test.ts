import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COLUMNS, highlight, lineLength, renderTerminal, truncate, type Line, type TerminalScreen } from './terminal-svg.ts';

const plain = (text: string): Line => [{ text, tone: 'text' }];

describe('highlight', () => {
  it('splits a typed command into the prompt and the command', () => {
    assert.deepEqual(highlight('$ teamrig list'), [
      { text: '$ ', tone: 'prompt' },
      { text: 'teamrig list', tone: 'command' },
    ]);
  });

  it('colours the verdict, ids, priorities and due dates of an output line', () => {
    assert.deepEqual(highlight('ADDED T12 open, p1, owner api, due 10-14 | Saved-card API'), [
      { text: 'ADDED', tone: 'good' },
      { text: ' ', tone: 'text' },
      { text: 'T12', tone: 'id' },
      { text: ' open, ', tone: 'text' },
      { text: 'p1', tone: 'priority' },
      { text: ', owner api, ', tone: 'text' },
      { text: 'due 10-14', tone: 'dim' },
      { text: ' | Saved-card API', tone: 'text' },
    ]);
  });

  it('colours each status and a refusal', () => {
    const tones = (text: string): string[] => highlight(text).filter((span) => span.tone !== 'text').map((span) => `${span.text}:${span.tone}`);
    assert.deepEqual(tones('REFUSED T1 waiting'), ['REFUSED:bad', 'T1:id', 'waiting:bad']);
    assert.deepEqual(tones('SET T1 in-progress'), ['SET:good', 'T1:id', 'in-progress:warn']);
    assert.deepEqual(tones('SET T1 done'), ['SET:good', 'T1:id', 'done:good']);
  });

  it('dims the stamp of an inbox line', () => {
    assert.deepEqual(highlight('- 2026-10-12 09:09 lead: hi')[0], { text: '- 2026-10-12 09:09', tone: 'dim' });
  });

  it('keeps a verdict word inside a sentence and a word that only contains an id uncoloured', () => {
    assert.deepEqual(highlight('was ADDED by XT1'), plain('was ADDED by XT1'));
    assert.deepEqual(highlight('| Cut the p95 latency'), plain('| Cut the p95 latency'), 'a p-word outside the priority slot');
  });

  it('returns no spans for an empty line', () => {
    assert.deepEqual(highlight(''), []);
  });
});

describe('truncate', () => {
  const line: Line = [
    { text: 'abc', tone: 'id' },
    { text: 'defgh', tone: 'text' },
  ];

  it('returns a line that fits unchanged', () => {
    assert.equal(truncate(line, 8), line);
  });

  it('cuts a longer line to the column count, the last character an ellipsis in the cut span tone', () => {
    const cut = truncate(line, 6);
    assert.deepEqual(cut, [
      { text: 'abc', tone: 'id' },
      { text: 'de…', tone: 'text' },
    ]);
    assert.equal(lineLength(cut), 6);
  });

  it('ends on a span boundary when the room runs out there', () => {
    assert.deepEqual(truncate(line, 4), [{ text: 'abc…', tone: 'id' }]);
  });

  it('leaves only the ellipsis at one column', () => {
    assert.deepEqual(truncate(line, 1), [{ text: '…', tone: 'dim' }]);
  });
});

describe('renderTerminal', () => {
  const screen = (layout: Pick<TerminalScreen, 'layout'> = {}): TerminalScreen => ({
    label: 'Two <panes> & "tabs"',
    tabs: [
      { label: 'lead', active: true },
      { label: 'web', active: false },
    ],
    panes: [
      { title: 'lead', lines: [plain('x'.repeat(20))] },
      { title: 'web', lines: [plain('y'.repeat(10)), plain('z')] },
    ],
    ...layout,
  });
  const size = (svg: string): [number, number] => {
    const match = /^<svg [^>]*width="(\d+)" height="(\d+)"/.exec(svg);
    assert.ok(match, svg.slice(0, 200));
    return [Number(match[1]), Number(match[2])];
  };

  it('draws the same bytes for the same screen', () => {
    assert.equal(renderTerminal(screen({ layout: 'stacked' })), renderTerminal(screen({ layout: 'stacked' })));
  });

  it('names the picture for screen readers with the escaped label', () => {
    const svg = renderTerminal(screen({ layout: 'stacked' }));
    assert.match(svg, /aria-label="Two &lt;panes&gt; &amp; &quot;tabs&quot;"/);
    assert.match(svg, /<title>Two &lt;panes&gt; &amp; &quot;tabs&quot;<\/title>/);
    assert.match(svg, /xml:space="preserve"/);
  });

  it('marks only the active tab', () => {
    const svg = renderTerminal(screen({ layout: 'stacked' }));
    assert.equal(svg.match(/<rect x="[\d.]+" y="6"/g)?.length, 1);
  });

  it('puts panes side by side by default: wider and shorter than stacked, with a vertical divider', () => {
    const side = renderTerminal(screen());
    const stacked = renderTerminal(screen({ layout: 'stacked' }));
    const [sideWidth, sideHeight] = size(side);
    const [stackedWidth, stackedHeight] = size(stacked);
    assert.ok(sideWidth > stackedWidth, `${sideWidth} > ${stackedWidth}`);
    assert.ok(sideHeight < stackedHeight, `${sideHeight} < ${stackedHeight}`);
    assert.match(side, new RegExp(`<line x1="([\\d.]+)" y1="32" x2="\\1" y2="${sideHeight}"`));
    assert.match(stacked, new RegExp(`<line x1="0" y1="([\\d.]+)" x2="${stackedWidth}" y2="\\1"`));
  });

  it('cuts lines longer than the columns, by default at DEFAULT_COLUMNS', () => {
    const long: TerminalScreen = { label: 'l', tabs: [], panes: [{ title: 'p', lines: [plain('w'.repeat(DEFAULT_COLUMNS + 5))] }] };
    assert.match(renderTerminal(long), new RegExp(`>${'w'.repeat(DEFAULT_COLUMNS - 1)}…<`));
    assert.match(renderTerminal(long, DEFAULT_COLUMNS + 5), new RegExp(`>${'w'.repeat(DEFAULT_COLUMNS + 5)}<`));
  });

  it('escapes pane text', () => {
    const svg = renderTerminal({ label: 'l', tabs: [], panes: [{ title: 'p', lines: [plain('<a & b>')] }] });
    assert.match(svg, />&lt;a &amp; b&gt;</);
  });

  it('draws only the tab bar when there are no panes', () => {
    const svg = renderTerminal({ label: 'l', tabs: [{ label: 'lead', active: false }], panes: [], layout: 'stacked' });
    assert.equal(size(svg)[1], 32);
    assert.doesNotMatch(svg, /<line /);
  });

  it('draws an empty line as a short gap with no text, and moves the next line down by the gap only', () => {
    const one = (lines: readonly Line[]): string => renderTerminal({ label: 'l', tabs: [], panes: [{ title: 'p', lines }] });
    const baselines = (svg: string): number[] => [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)">/g)].map((match) => Number(match[1]));
    const gapped = one([plain('a'), [], plain('b')]);
    const tight = one([plain('a'), plain('b')]);
    const spaced = one([plain('a'), plain(' '), plain('b')]);
    assert.equal(baselines(gapped).length, 3, 'the title and two lines; the gap draws no text');
    const step = (svg: string): number => (baselines(svg).at(-1) ?? 0) - (baselines(svg)[1] ?? 0);
    assert.ok(step(tight) < step(gapped) && step(gapped) < step(spaced), `${step(tight)} < ${step(gapped)} < ${step(spaced)}`);
    assert.equal(size(gapped)[1] - size(tight)[1], step(gapped) - step(tight));
  });
});
