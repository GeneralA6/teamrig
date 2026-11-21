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

  it("holds a security fix's branch name to the hardening, as its commits are, and names it apart from a task title", () => {
    const section = skill.slice(skill.indexOf('## A security hole'));
    assert.match(section, /The fix's branch name, commit messages, pull request text, code comments and test names describe the\s+hardening/);
    assert.ok(section.includes('`teamrig worktree add <branch>`'));
  });
});

describe('the write-issue skill', () => {
  const skill = read(`${SKILLS}/write-issue/SKILL.md`);

  it('has the steps an issue a contributor takes alone needs, the read-back last', () => {
    const steps = [...skill.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(steps, [
      '1. Read what binds the work',
      '2. The whole spec in the body',
      '3. Its sections',
      '4. A goal is a parent with sub-issues',
      '5. Labels and the taker',
      '6. A design issue is talk, not a spec',
      '7. Read it back',
      'Posting',
      'On GitHub',
    ]);
  });

  it('keeps a design issue as talk: the design label, no status or assignee, its own sections, agreed by the maintainer, nothing sensitive', () => {
    assert.ok(skill.includes('takes `design` and no status label or assignee'));
    for (const section of ['Question', 'Context', 'Options', 'Proposal', 'How it is agreed']) {
      assert.ok(skill.includes(`**${section}**`), section);
    }
    assert.ok(skill.includes('no claim, branch, code or change request until it\n  is agreed'));
    assert.ok(skill.includes('a comment starting `Agreed:`'));
    assert.ok(skill.includes('private vulnerability report'));
  });

  it("names the repository's own rule on where a change lives, and every section of the body", () => {
    assert.ok(skill.includes('`CONTRIBUTING.md`'));
    for (const section of ['Why', 'Scope', 'Out of scope', 'Deliverables', 'Constraints', 'Acceptance checks', 'What the maintainer decides', 'Review and dates', 'Starting points']) {
      assert.ok(skill.includes(`**${section}**`), section);
    }
  });

  it('replaces the body with a file, never a spec in comments, and reads the labels the repository has', () => {
    assert.ok(skill.includes('`teamrig issue edit <owner/name#n> --body-file <file>`'));
    assert.ok(skill.includes('`gh label list`'));
  });

  it("names GitHub's own commands only in its On GitHub section, so the steps fit every tracker", () => {
    const [steps = '', github = ''] = skill.split('\n## On GitHub\n');
    assert.doesNotMatch(steps, /`gh |\bGitHub\b|pull request/u);
    assert.match(github, /`gh issue list --state all/u);
  });

  it("stays generic: no repository, palette or task id of teamrig's own", () => {
    assert.doesNotMatch(skill, /GeneralA6|#[0-9a-f]{6}\b|\bT\d+\b|teamrig-github/u);
  });
});
