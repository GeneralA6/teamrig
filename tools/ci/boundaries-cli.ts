import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { type SourceFile, boundaryCounts, boundaryFindings, findingLine } from './boundaries.ts';

/** The folders whose TypeScript the boundaries hold. */
const FOLDERS = ['src', 'tools'] as const;

/** The `.ts` files under one folder of the repo, by their path from the repo root with `/` separators. */
function pathsUnder(root: string, folder: string): readonly string[] {
  const top = join(root, folder);
  if (!existsSync(top)) return [];
  return readdirSync(top, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

/** Every source file of the repo, sorted by its `/` path so each OS lists the findings in one order. */
function sourceFiles(root: string): readonly SourceFile[] {
  return FOLDERS.flatMap((folder) => [...pathsUnder(root, folder)].sort()).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

/**
 * Counts what crosses the layer boundaries of this repo's `src` (or `--root <repo>`), one line per rule; `--list`
 * prints each finding first. Warn mode: the counts are the backlog of the move into adapters, so it exits 0 whatever
 * it finds.
 */
async function main(args: readonly string[]): Promise<number> {
  const { root, rest } = takeRoot(args);
  const unknown = rest.filter((arg) => arg !== '--list');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(' ')} (usage: boundaries-cli.ts [--list] [--root <repo>])`);
  const findings = boundaryFindings(sourceFiles(root));
  if (rest.includes('--list')) {
    for (const finding of findings) console.log(findingLine(finding));
  }
  for (const line of boundaryCounts(findings)) console.log(`boundaries: ${line}`);
  console.log('boundaries: warn mode, so the counts fail nothing yet');
  return EXIT_CLEAN;
}

process.exitCode = await runMain('boundaries', () => main(process.argv.slice(2)), (line) => console.error(line));
