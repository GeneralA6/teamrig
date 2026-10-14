import type { Git } from './git.ts';

export interface CommitRecord {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly parents: readonly string[];
  readonly message: string;
}

const FIELD_SEPARATOR = '\x00';
const RECORD_SEPARATOR = '\x1e';
const LOG_FORMAT = '--format=%H%x00%an%x00%ae%x00%P%x00%B%x1e';

/** Reads the commits `git log` lists for `revision`: a range (`a..b`) or one revision for its whole history. */
export async function readCommits(git: Git, revision: string): Promise<CommitRecord[]> {
  const raw = await git.text(['log', LOG_FORMAT, revision, '--']);
  return raw
    .split(RECORD_SEPARATOR)
    .map((chunk) => chunk.replace(/^\r?\n/, ''))
    .filter((chunk) => chunk !== '')
    .map(parseRecord);
}

function parseRecord(chunk: string): CommitRecord {
  const [sha, authorName, authorEmail, parents, message] = chunk.split(FIELD_SEPARATOR);
  if (
    sha === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    parents === undefined ||
    message === undefined
  ) {
    throw new Error(`unexpected git log record: ${JSON.stringify(chunk.slice(0, 80))}`);
  }
  return {
    sha,
    authorName,
    authorEmail,
    parents: parents.split(' ').filter((parent) => parent !== ''),
    message,
  };
}
