import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawPictures, IMAGES_DIR, stalePictures, writePictures } from './images.ts';
import { parseXml, placesIn, textOf } from './xml.ts';

describe('drawPictures', () => {
  it("draws the README's pictures in its order, then the commands screen", async () => {
    assert.deepEqual(
      (await drawPictures()).map((picture) => picture.file),
      ['wordmark.svg', 'hero.svg', 'how-it-works.svg', 'task-flow.svg', 'lead-morning.svg', 'why.svg', 'terminal-view.svg', 'lead-meeting.svg', 'plan.svg', 'reboot.svg', 'growth.svg', 'commands.svg'],
    );
  });

  it('draws every picture as well-formed XML with a text alternative and no pictographs (emoji)', async () => {
    for (const picture of await drawPictures()) {
      const root = parseXml(picture.svg);
      assert.equal(root.attributes.get('role'), 'img', picture.file);
      assert.notEqual(root.attributes.get('aria-label') ?? '', '', picture.file);
      assert.doesNotMatch(picture.svg, /\p{Extended_Pictographic}/u, picture.file);
    }
  });

  it('draws no text with a run of spaces, which a browser shows as one space', async () => {
    for (const picture of await drawPictures()) {
      for (const { element } of placesIn(parseXml(picture.svg))) {
        if (element.name === 'text' || element.name === 'tspan') assert.doesNotMatch(textOf(element), / {2}/, `${picture.file}: ${textOf(element)}`);
      }
    }
  });
});

describe('writing and checking pictures', () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'teamrig-images-'));
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
