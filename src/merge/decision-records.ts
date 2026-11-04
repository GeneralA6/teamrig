import { posix, win32, type PlatformPath } from 'node:path';
import { DEFAULT_DOCS_FOLDER } from '../config/defaults.ts';
import type { Files } from '../core/files.ts';
import { isAtOrBelow } from '../core/paths.ts';
import type { MergeGit } from './git.ts';
import { taskOfBranch } from './review-gate-step.ts';

/**
 * The decision record gate (`delivery.repos.<name>.decisionRecordGate`): a branch whose task has a design note in its
 * task folder merges only with a decision record in the project's docs, because a task folder sits outside the
 * repository: a design settled there is lost to every reader of the code unless it lands in the repository too.
 */

/** The folder in the docs folder that holds the decision records. */
export const DECISIONS_FOLDER = 'decisions';
/** A design note in a task's folder: a `.md` file named for a design, such as `design.md`, `design-v2.md` or `pr2-design.md`. */
const DESIGN_NOTE = /(?:^|[-_. ])design(?:[-_. ][^\\/]*)?\.md$/i;
/** A decisions folder's own index, which is no record. */
const INDEX_NAME = 'readme.md';

/** The branch the gate weighs, and where its task's notes and the decision records are. */
export interface DecisionRecordChange {
  /** The repository's name in `delivery.repos`, which the refusal names. */
  readonly repo: string;
  /** Its `docsFolder`; undefined for the default. */
  readonly docsFolder: string | undefined;
  /** The branch's checkout. */
  readonly top: string;
  /** The repository's main checkout, which an absolute docs folder may name in place of the branch's checkout. */
  readonly mainCheckout: string;
  readonly branch: string;
  /** What the branch merges into, as `<remote>/<branch>`. */
  readonly onto: string;
  /** The team's task folders, one per task id. */
  readonly tasksFolder: string;
}

export interface DecisionRecordPorts {
  readonly git: Pick<MergeGit, 'mergeBase' | 'changedPaths' | 'fileAt'>;
  readonly files: Pick<Files, 'list' | 'read'>;
  readonly platform: NodeJS.Platform;
}

/** The docs folder: in the repository, as its path there with `/`, or outside it, as a place on disk. */
type DocsPlace = { readonly kind: 'inside'; readonly relative: string } | { readonly kind: 'outside'; readonly folder: string };

function pathsOf(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

function docsPlace(change: DecisionRecordChange, platform: NodeJS.Platform): DocsPlace {
  const paths = pathsOf(platform);
  const folder = paths.resolve(change.top, change.docsFolder ?? DEFAULT_DOCS_FOLDER);
  for (const root of [change.top, change.mainCheckout]) {
    if (isAtOrBelow(folder, root, platform)) {
      return { kind: 'inside', relative: paths.relative(root, folder).replaceAll('\\', '/') };
    }
  }
  return { kind: 'outside', folder };
}

function isRecordName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') && posix.basename(lower) !== INDEX_NAME;
}

/**
 * Why the gate holds the branch: its task (`t<n>-…`) has a design note and the branch adds or changes no decision
 * record in `<docsFolder>/decisions/`, or, for a docs folder outside the repository, which no branch changes, no record
 * there names the task; undefined when it lets the branch through. A branch named for no task, or a task with no
 * design note, goes through.
 */
export async function decisionRecordHold(change: DecisionRecordChange, ports: DecisionRecordPorts): Promise<string | undefined> {
  const id = taskOfBranch(change.branch);
  if (id === undefined) {
    return undefined;
  }
  const paths = pathsOf(ports.platform);
  const notes = (await ports.files.list(paths.join(change.tasksFolder, id))).filter((name) => DESIGN_NOTE.test(name)).sort();
  if (notes.length === 0) {
    return undefined;
  }
  const held = `${id} has a design note (${notes.join(', ')})`;
  const setting = `delivery.repos.${change.repo}.decisionRecordGate holds a task with a design note until its record lands`;
  const place = docsPlace(change, ports.platform);
  if (place.kind === 'outside') {
    return outsideHold(ports, place.folder, id, held, setting);
  }
  const records = place.relative === '' ? `${DECISIONS_FOLDER}/` : `${place.relative}/${DECISIONS_FOLDER}/`;
  const base = ports.git.mergeBase(change.top, change.onto, 'HEAD');
  const changed = base === undefined ? undefined : ports.git.changedPaths(change.top, base, 'HEAD');
  if (changed === undefined) {
    return `could not read what ${change.branch} changes against ${change.onto}, so the decision record gate cannot clear it`;
  }
  // A deleted record is in the changed paths too, but it is no record of this design.
  const recorded = changed.some((path) => path.startsWith(records) && isRecordName(path) && ports.git.fileAt(change.top, 'HEAD', path) !== undefined);
  if (recorded) {
    return undefined;
  }
  return (
    `${held} and ${change.branch} adds or changes no decision record in ${records}: write the decided design there as a record ` +
    `(${records}YYYY-MM-DD-<slug>.md, in the format the teamrig merge guide gives) and commit it on the branch; ${setting}`
  );
}

/** A docs folder outside the repository: a record there whose text names the task clears it. */
async function outsideHold(ports: DecisionRecordPorts, folder: string, id: string, held: string, setting: string): Promise<string | undefined> {
  const paths = pathsOf(ports.platform);
  const records = paths.join(folder, DECISIONS_FOLDER);
  // The id is `T` and digits, so it needs no escaping; the word edges keep T12 from matching T123.
  const names = new RegExp(`\\b${id}\\b`);
  for (const name of (await ports.files.list(records)).filter(isRecordName)) {
    const text = await ports.files.read(paths.join(records, name));
    if (text !== undefined && names.test(text)) {
      return undefined;
    }
  }
  return (
    `${held} and no decision record in ${records} names it: write the decided design there as a record that names ${id} ` +
    `(YYYY-MM-DD-<slug>.md, in the format the teamrig merge guide gives); ${setting}`
  );
}
