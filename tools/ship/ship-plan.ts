import { readFileSync } from 'node:fs';
import { versionMention } from './version-bump.ts';

/** What `node ship.ts <teamrig dir> <plan.json> ...` reads: its arguments and the plan's commits. */

/** One commit of a ship's plan. */
export interface Chunk {
  readonly files: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export interface ShipArgs {
  readonly repo: string;
  readonly plan: string;
  /** Where the commit list printed at the end starts. */
  readonly base: string;
  /** Push the change branch and merge it in the same run, so in the same host-lock hold, once the gate passes (T629). */
  readonly merge: boolean;
  /** A Markdown file whose text opens the body of the pull request --merge opens; null for none. */
  readonly noteFile: string | null;
}

export const SHIP_USAGE =
  'usage: ship.ts <teamrig dir> <plan.json> [base] [--merge [--note-file <path>]] | ship.ts check <repo dir> | ship.ts merge <repo dir> ...';

export function parseShipArgs(argv: readonly string[]): ShipArgs {
  const positional: string[] = [];
  let merge = false;
  let noteFile: string | null = null;
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === '--merge') merge = true;
    else if (arg === '--note-file') {
      const value = rest.shift();
      if (value === undefined || value.startsWith('--')) throw new Error(`--note-file needs a path; ${SHIP_USAGE}`);
      noteFile = value;
    } else if (arg.startsWith('--')) throw new Error(`${SHIP_USAGE} (got ${arg})`);
    else positional.push(arg);
  }
  const [repo, plan, base = 'origin/main', ...extra] = positional;
  if (repo === undefined || plan === undefined || extra.length > 0) throw new Error(SHIP_USAGE);
  if (noteFile !== null && !merge) throw new Error('--note-file opens the pull request that --merge opens: pass --merge too');
  return { repo, plan, base, merge, noteFile };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');

/** plan.json: { "chunks": [ { "files": ["src/a.ts", ...], "subject": "area: what", "body": "why" } ] } */
export function parsePlan(text: string, path: string): Chunk[] {
  const plan: unknown = JSON.parse(text);
  const chunks = isRecord(plan) ? plan['chunks'] : undefined;
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error(`${path}: expected { "chunks": [ ... ] }`);
  return chunks.map((chunk: unknown, index) => {
    if (isRecord(chunk) && isStringList(chunk['files']) && typeof chunk['subject'] === 'string' && typeof chunk['body'] === 'string') {
      return { files: chunk['files'], subject: chunk['subject'], body: chunk['body'] };
    }
    throw new Error(`${path}: chunk ${index} needs files (non-empty), subject and body`);
  });
}

export const readPlan = (path: string): Chunk[] => parsePlan(readFileSync(path, 'utf8'), path);

/** The plan with the version the ship set from main (sync.ts) where it names the one it was written with. */
export function withPlanVersion(chunks: readonly Chunk[], version: { readonly from: string; readonly to: string }): Chunk[] {
  const mention = versionMention(version.from, 'g');
  return chunks.map((chunk) => ({ files: chunk.files, subject: chunk.subject.replace(mention, version.to), body: chunk.body.replace(mention, version.to) }));
}
