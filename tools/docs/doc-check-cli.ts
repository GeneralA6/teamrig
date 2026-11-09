import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import { takeRoot } from '../lib/repo-root.ts';
import { runMain } from '../lib/run-main.ts';
import { checkDocs, describeProblems, type DocFile } from './doc-check.ts';

/** The Markdown a reader meets: the top-level `*.md` files and everything under docs/. */
function readDocs(root: string): DocFile[] {
  const top = readdirSync(root).filter((name) => name.endsWith('.md'));
  const docsDir = join(root, 'docs');
  const nested = existsSync(docsDir)
    ? readdirSync(docsDir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/${name.replaceAll('\\', '/')}`)
    : [];
  return [...top, ...nested].sort().map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

/**
 * Checks the links, anchors and Mermaid blocks of this repo's Markdown (or `--root <repo>`'s, doc-check.ts); exits 1
 * on a problem.
 */
async function main(args: readonly string[]): Promise<number> {
  const { root, rest } = takeRoot(args);
  if (rest.length > 0) throw new Error(`unknown option ${rest.join(' ')} (usage: doc-check-cli.ts [--root <repo>])`);
  const docs = readDocs(root);
  const report = checkDocs(docs, (path) => existsSync(join(root, path)));
  if (report.problems.length === 0) {
    console.log(`docs: ${docs.length} file(s), ${report.links} link(s) and ${report.diagrams} diagram(s) check out`);
    return EXIT_CLEAN;
  }
  console.log(`docs: ${report.problems.length} problem(s):`);
  describeProblems(report.problems).forEach((line) => console.log(`  ${line}`));
  return EXIT_FINDINGS;
}

process.exitCode = await runMain('docs', () => main(process.argv.slice(2)), (line) => console.error(line));
