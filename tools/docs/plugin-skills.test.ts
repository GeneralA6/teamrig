import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { descriptionOf } from '../../src/skills/lint.ts';
import { checkDocs, type DocFile } from './doc-check.ts';

/**
 * Every skill the plugin ships, held to what Claude Code needs to offer it: a name that matches its folder and a
 * short description that stays a plain YAML value (each session's skill list carries it on every turn), with
 * relative links and anchors that resolve. The security skill also names the commands it is about.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = 'plugins/teamrig/skills';
const MAX_DESCRIPTION_WORDS = 30;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const frontmatterOf = (text: string): string => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';

const folders = readdirSync(join(ROOT, SKILLS), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** Every Markdown file of every skill, so a link into another skill's file has its anchors checked too. */
const docs: readonly DocFile[] = folders.flatMap((folder) =>
  readdirSync(join(ROOT, SKILLS, folder))
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ path: `${SKILLS}/${folder}/${name}`, text: read(`${SKILLS}/${folder}/${name}`) })),
);

describe('the plugin skills', () => {
  it('are read from the plugin folder', () => {
    assert.ok(folders.includes('teamrig-guide') && folders.includes('security'), folders.join(', '));
  });

  for (const folder of folders) {
    describe(folder, () => {
      const path = `${SKILLS}/${folder}/SKILL.md`;
      const front = frontmatterOf(read(path));

      it('is named after its folder', () => {
        assert.equal(/^name:\s*(\S+)\s*$/m.exec(front)?.[1], folder);
      });

      it(`has a description of at most ${MAX_DESCRIPTION_WORDS} words, a plain YAML value with no ": " in it`, () => {
        const description = descriptionOf(front);
        assert.ok(description !== null, `${path} has a description`);
        const words = description.split(/\s+/).length;
        assert.ok(words <= MAX_DESCRIPTION_WORDS, `${words} words`);
        assert.doesNotMatch(description, /:\s/);
      });

      it('has relative links and anchors that resolve', () => {
        const report = checkDocs(docs, (target) => existsSync(join(ROOT, target)));
        assert.deepEqual(report.problems.filter((problem) => problem.path.startsWith(`${SKILLS}/${folder}/`)), []);
      });
    });
  }
});

describe('the security skill', () => {
  const skill = read(`${SKILLS}/security/SKILL.md`);

  it('names the ad-hoc runners by their commands, not just "installing"', () => {
    for (const command of ['`npx`', '`npm exec`', '`npm create`', '`pnpm dlx`', '`yarn dlx`']) {
      assert.ok(skill.includes(command), command);
    }
  });

  it('regenerates a lockfile without installing or running scripts, for npm and pnpm', () => {
    assert.ok(skill.includes('`npm install --package-lock-only --ignore-scripts`'));
    assert.ok(skill.includes('`pnpm install --lockfile-only --ignore-scripts`'));
  });

  it('scopes an override to its major', () => {
    assert.match(skill, /`"flat-cache@6": "6\.1\.13"`/);
  });
});
