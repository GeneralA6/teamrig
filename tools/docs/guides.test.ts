import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { headingAnchors } from './doc-check.ts';

/**
 * The guides in docs/guides/, one per goal a reader has (keep it safe...), cut from how-it-works.md (T905): each is
 * reachable from the README, how-it-works.md and llms.txt, opens with a contents list of its sections, and no section
 * lives both in a guide and in how-it-works.md, so the two cannot drift apart.
 */

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

interface Guide {
  readonly name: string;
  readonly text: string;
}

const GUIDES: readonly Guide[] = readdirSync(fileURLToPath(new URL('../../docs/guides/', import.meta.url)))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name, text: read(`docs/guides/${name}`) }));
const HOW_IT_WORKS = read('docs/how-it-works.md');

/** The titles of a page's `## ` sections, in order. */
const sections = (text: string): string[] => [...text.matchAll(/^## (.+)$/gm)].map((found) => found[1] ?? '');

/** The anchor GitHub gives a `## ` heading with this title. */
function anchorOf(title: string): string {
  const [anchor] = headingAnchors(`## ${title}`);
  assert.ok(anchor !== undefined, `"${title}" has an anchor`);
  return anchor;
}

describe('docs/guides', () => {
  it('holds the guides', () => {
    assert.deepEqual(
      GUIDES.map((guide) => guide.name),
      [
        'grow-the-team.md',
        'improve-itself.md',
        'keep-it-safe.md',
        'plan-the-week.md',
        'recover.md',
        'run-your-day.md',
        'ship-from-many-sessions.md',
        'start-here.md',
      ],
    );
  });

  it('links each guide from the README, how-it-works.md and llms.txt', () => {
    const readme = read('README.md');
    const llms = read('llms.txt');
    const missing = GUIDES.flatMap(({ name }) => [
      ...(readme.includes(`](docs/guides/${name})`) ? [] : [`README.md -> ${name}`]),
      ...(HOW_IT_WORKS.includes(`](guides/${name})`) ? [] : [`docs/how-it-works.md -> ${name}`]),
      ...(llms.includes(`](https://github.com/GeneralA6/teamrig/blob/main/docs/guides/${name})`) ? [] : [`llms.txt -> ${name}`]),
    ]);
    assert.deepEqual(missing, []);
  });

  it('opens each guide with its title and a contents list naming every section', () => {
    const problems = GUIDES.flatMap(({ name, text }) => [
      ...(text.startsWith('# ') ? [] : [`${name}: opens with no "# " title`]),
      ...sections(text)
        .filter((title) => !text.includes(`- [${title}](#${anchorOf(title)})`))
        .map((title) => `${name}: the contents list misses "${title}"`),
    ]);
    assert.deepEqual(problems, []);
  });

  it('keeps each section in one page, never both in a guide and in how-it-works.md', () => {
    const kept = new Set(sections(HOW_IT_WORKS));
    const twice = GUIDES.flatMap(({ name, text }) => sections(text).filter((title) => kept.has(title)).map((title) => `${name}: ${title}`));
    assert.deepEqual(twice, []);
  });
});
