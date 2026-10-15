import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');

/** The targets of the README's Markdown images and links, in order. */
const targets = (kind: 'image' | 'link'): string[] =>
  [...README.matchAll(kind === 'image' ? /!\[[^\]]*\]\(([^)\s]+)\)/g : /(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map((found) => found[1] ?? '');

describe('README.md', () => {
  it('shows its pictures in order: hero, growth, how it works, the plan, why it is different', () => {
    assert.deepEqual(targets('image'), ['hero', 'growth', 'how-it-works', 'plan', 'why'].map((name) => `docs/images/${name}.svg`));
  });

  it('gives every picture a text alternative', () => {
    for (const found of README.matchAll(/!\[([^\]]*)\]\(/g)) assert.ok((found[1] ?? '').length > 40, found[0]);
  });

  it('links the details: how it works, every command and contributing', () => {
    const links = targets('link');
    for (const path of ['docs/how-it-works.md', 'docs/commands.md', 'CONTRIBUTING.md']) assert.ok(links.includes(path), path);
  });

  it('links the task pane, teamrig-pane, and names its command', () => {
    assert.ok(targets('link').includes('https://github.com/GeneralA6/teamrig-pane'));
    assert.match(README, /\[teamrig-pane\]\([^)]+\) and run `\/teamrig`/);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(README, /\p{Extended_Pictographic}/u);
  });
});
