import { join } from 'node:path';
import type { Git } from '../lib/git.ts';
import { readCommits } from '../lib/commits.ts';

export interface ScanInput {
  readonly source: string;
  readonly content: Buffer | string;
}

export type ReadFile = (path: string) => Promise<Buffer>;

/** Staged additions and modifications, read from the index, plus each staged path name. */
export async function stagedInputs(git: Git): Promise<ScanInput[]> {
  const names = splitNul(await git.text(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
  const inputs: ScanInput[] = [];
  for (const name of names) {
    inputs.push(pathInput(name), { source: name, content: await git.bytes(['show', `:${name}`]) });
  }
  return inputs;
}

/** Every tracked file as it is in the working tree, plus each path name. Tracked files deleted on disk are skipped. */
export async function treeInputs(git: Git, readFile: ReadFile): Promise<ScanInput[]> {
  const root = (await git.text(['rev-parse', '--show-toplevel'])).trim();
  const names = splitNul(await git.text(['ls-files', '-z']));
  const inputs: ScanInput[] = [];
  for (const name of names) {
    inputs.push(pathInput(name));
    const content = await readIfPresent(readFile, join(root, name));
    if (content !== undefined) {
      inputs.push({ source: name, content });
    }
  }
  return inputs;
}

/** The message of every commit in `revision`. */
export async function commitMessageInputs(git: Git, revision: string): Promise<ScanInput[]> {
  const commits = await readCommits(git, revision);
  return commits.map((commit) => ({ source: `commit ${commit.sha.slice(0, 12)} message`, content: commit.message }));
}

/** A commit message file as the commit-msg hook receives it, without git's `#` comment lines. */
export function messageFileInput(path: string, text: string): ScanInput {
  const content = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  return { source: `commit message (${path})`, content };
}

export function isBinary(content: Buffer | string): boolean {
  return typeof content !== 'string' && content.subarray(0, 8000).includes(0);
}

function pathInput(name: string): ScanInput {
  return { source: `${name} (path)`, content: name };
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((name) => name !== '');
}

async function readIfPresent(readFile: ReadFile, path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
