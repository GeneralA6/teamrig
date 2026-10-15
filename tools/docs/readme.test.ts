import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');

/** The targets of the README's Markdown images and links, in order. */
const targets = (kind: 'image' | 'link'): string[] =>
  [...README.matchAll(kind === 'image' ? /!\[[^\]]*\]\(([^)\s]+)\)/g : /(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map((found) => found[1] ?? '');

describe('README.md', () => {
  it('shows its pictures in order: hero, why it is different, your terminal, growth, how it works, the plan', () => {
    assert.deepEqual(targets('image'), ['hero', 'why', 'terminal-view', 'growth', 'how-it-works', 'plan'].map((name) => `docs/images/${name}.svg`));
  });

  it('gives every picture a text alternative', () => {
    for (const found of README.matchAll(/!\[([^\]]*)\]\(/g)) assert.ok((found[1] ?? '').length > 40, found[0]);
  });

  it('links the details: how it works, updating, every command, contributing and the guide for language models', () => {
    const links = targets('link');
    for (const path of ['docs/how-it-works.md', 'docs/how-it-works.md#updating-the-plugin', 'docs/commands.md', 'CONTRIBUTING.md', 'llms.txt']) {
      assert.ok(links.includes(path), path);
    }
  });

  it('names only the major needs under Get started, Claude Code and Node.js, and says teamrig checks the rest', () => {
    const requirements = README.slice(README.indexOf('### Requirements\n') + '### Requirements\n'.length, README.indexOf('## Your day')).trim();
    assert.match(requirements, /^Claude Code and Node\.js 22\.18 or later\./);
    assert.match(requirements, /teamrig checks for anything else when you start it/);
    assert.match(requirements, /^\*Coming: .+/m);
    assert.ok(requirements.split('\n').length <= 4, `Requirements is ${requirements.split('\n').length} lines; keep it to the major needs`);
  });

  it('marks what is not built yet with a Coming line', () => {
    for (const section of ['## Your day', "## Why it's different", '## Grows with your project', '## Never runs out mid-task']) {
      const from = README.indexOf(section);
      assert.ok(from >= 0, section);
      assert.match(README.slice(from, README.indexOf('\n## ', from + 1)), /^\*Coming: .+/m, section);
    }
  });

  it('links the task pane, teamrig-pane, and names its command', () => {
    assert.ok(targets('link').includes('https://github.com/GeneralA6/teamrig-pane'));
    assert.match(README, /\[teamrig-pane\]\([^)]+\) and run `\/teamrig-pane`/);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(README, /\p{Extended_Pictographic}/u);
  });
});
