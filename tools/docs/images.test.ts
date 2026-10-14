import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawPictures, HERO_COLUMNS, heroScreen, IMAGES_DIR, paneLines, stalePictures, writePictures } from './images.ts';
import { lineLength } from './terminal-svg.ts';

describe('paneLines', () => {
  it('prints each command after a prompt, then its output, with a blank line between commands', () => {
    const lines = paneLines([
      { session: 'lead', command: 'teamrig list', output: ['T1 open, tier 1'] },
      { session: 'lead', command: 'teamrig show T1', output: [] },
    ]);
    assert.deepEqual(
      lines.map((line) => line.map((span) => span.text).join('')),
      ['$ teamrig list', 'T1 open, tier 1', '', '$ teamrig show T1'],
    );
  });
});

describe('heroScreen', () => {
  it('shows the lead pane above the web pane, under four tabs with lead active', async () => {
    const screen = await heroScreen();
    assert.equal(screen.layout, 'stacked');
    assert.deepEqual(
      screen.panes.map((pane) => pane.title),
      ['lead: a Claude Code session; Claude runs these commands', 'web: another Claude Code session'],
    );
    assert.deepEqual(
      screen.tabs.filter((tab) => tab.active).map((tab) => tab.label),
      ['lead'],
    );
    assert.equal(screen.tabs.length, 4);
  });

  it('fits every line in the hero columns, so the picture cuts nothing', async () => {
    const screen = await heroScreen();
    const longest = Math.max(...screen.panes.flatMap((pane) => pane.lines.map(lineLength)));
    assert.ok(longest <= HERO_COLUMNS, `the longest hero line has ${longest} characters`);
    const hero = (await drawPictures()).find((picture) => picture.file === 'hero.svg');
    assert.ok(hero !== undefined);
    assert.doesNotMatch(hero.svg, /…/);
  });

  it('shows web reading the lead note and starting its task', async () => {
    const web = (await heroScreen()).panes[1];
    const text = (web?.lines ?? []).map((line) => line.map((span) => span.text).join(''));
    assert.ok(text.includes("- 2026-10-12 09:06 lead: T2 is yours; it uses T1's API"), text.join('\n'));
    assert.ok(text.some((line) => line.startsWith('SET T2 in-progress, tier 1, owner web,')), text.join('\n'));
  });
});

describe('drawPictures', () => {
  it('draws the wordmark and the hero', async () => {
    assert.deepEqual(
      (await drawPictures()).map((picture) => picture.file),
      ['wordmark.svg', 'hero.svg'],
    );
  });
});

describe('writing and checking pictures', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'teamrig-images-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pictures = [
    { file: 'a.svg', svg: '<svg>a</svg>\n' },
    { file: 'b.svg', svg: '<svg>b</svg>\n' },
  ];

  it('reports every missing picture as stale', () => {
    assert.deepEqual(stalePictures(root, pictures), [`${IMAGES_DIR}/a.svg`, `${IMAGES_DIR}/b.svg`]);
  });

  it('writes every picture under the images folder, then finds none stale', () => {
    assert.deepEqual(writePictures(root, pictures), [`${IMAGES_DIR}/a.svg`, `${IMAGES_DIR}/b.svg`]);
    assert.equal(readFileSync(join(root, IMAGES_DIR, 'b.svg'), 'utf8'), '<svg>b</svg>\n');
    assert.deepEqual(stalePictures(root, pictures), []);
  });

  it('reports a picture that differs from a fresh drawing', () => {
    writeFileSync(join(root, IMAGES_DIR, 'a.svg'), '<svg>old</svg>\n');
    assert.deepEqual(stalePictures(root, pictures), [`${IMAGES_DIR}/a.svg`]);
  });
});
