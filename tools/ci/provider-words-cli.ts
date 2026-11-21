import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { type SkillFile, baselineText, compareCounts, hitLine, parseBaseline, providerHits, skillCounts } from './provider-words.ts';

/** The folders whose every subfolder is one skill: the plugin's and this repo's own. */
const SKILL_ROOTS = ['plugins/teamrig/skills', '.claude/skills'] as const;
const BASELINE = 'tools/ci/provider-words.json';
/** A skill's step texts name one product by design, so the check leaves them out. */
const STEP_TEXTS = 'steps.md';
const USAGE = 'usage: provider-words-cli.ts [--list] [--write] [--root <repo>]';

/** The `/` path from the repo root. */
const repoPath = (root: string, absolute: string): string => relative(root, absolute).split(sep).join('/');

/** The Markdown files of every skill, skills and their files sorted by their `/` path so each OS reads one order. */
function skillFiles(root: string): readonly SkillFile[] {
  return SKILL_ROOTS.flatMap((folder) => {
    const top = join(root, folder);
    if (!existsSync(top)) return [];
    const skills = readdirSync(top, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${folder}/${entry.name}`)
      .sort();
    return skills.flatMap((skill) =>
      readdirSync(join(root, skill), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== STEP_TEXTS)
        .map((entry) => repoPath(root, join(entry.parentPath, entry.name)))
        .sort()
        .map((path) => ({ skill, path, text: readFileSync(join(root, path), 'utf8') })),
    );
  });
}

function readBaseline(root: string): ReadonlyMap<string, number> {
  const file = join(root, BASELINE);
  return existsSync(file) ? parseBaseline(JSON.parse(readFileSync(file, 'utf8'))) : new Map();
}

/**
 * Counts the host and tool words in each skill of this repo (or `--root <repo>`) against the baseline file and fails
 * when a count rose; `--list` prints each hit first, `--write` records the counts (a fall lowers a baseline, a new
 * skill adds one) and refuses a rise. Warn mode: a count at or below its baseline passes, so only a skill whose
 * baseline reached 0 fails on every word.
 */
async function main(args: readonly string[]): Promise<number> {
  const { root, rest } = takeRoot(args);
  const unknown = rest.filter((arg) => arg !== '--list' && arg !== '--write');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(' ')} (${USAGE})`);
  const files = skillFiles(root);
  if (rest.includes('--list')) {
    for (const hit of providerHits(files)) console.log(hitLine(hit));
  }
  const counts = skillCounts(files);
  const baseline = readBaseline(root);
  const { rose, fell, gone } = compareCounts(counts, baseline);
  for (const { skill, count, baseline: was } of rose) console.log(`provider-words: ${skill} rose to ${count} from ${was}: say the step and let the adapter say how`);
  if (rest.includes('--write')) {
    const raised = rose.filter(({ skill }) => baseline.has(skill));
    if (raised.length > 0) {
      console.log('provider-words: wrote nothing: a count never rises');
      return EXIT_FINDINGS;
    }
    writeFileSync(join(root, BASELINE), baselineText(counts));
    console.log(`provider-words: wrote ${BASELINE}`);
    return EXIT_CLEAN;
  }
  for (const { skill, count, baseline: was } of fell) console.log(`provider-words: ${skill} fell to ${count} from ${was}: run --write to lower its baseline`);
  for (const skill of gone) console.log(`provider-words: ${skill} is gone: run --write to drop its baseline`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const clear = [...counts.values()].filter((count) => count === 0).length;
  console.log(`provider-words: ${total} host or tool words in ${counts.size} skills, ${clear} with none; a count may fall, never rise`);
  return rose.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
}

process.exitCode = await runMain('provider-words', () => main(process.argv.slice(2)), (line) => console.error(line));
