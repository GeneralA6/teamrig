import { changedFrame, DOCUMENTS, helloFrame, isDocumentName, movedDocuments, type DocumentName, type DocumentRevision } from '../../interface/index.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { documentFlagsOf, revisionOf, scopeFlagsOf, sourcesOf, type ReadRequest } from './read.ts';
import type { DocumentSource } from './read-source.ts';

/** How long the follower waits between two looks at its documents' files; every change inside one wait is one frame. */
export const EVENTS_PASS_MS = 1_000;

const DOCUMENTS_FORM = `--documents takes <document>[,<document>...]; the documents are ${DOCUMENTS.join(', ')}`;

/**
 * `teamrig events --json`: the events side of the public interface (docs/design/public-interface.md), as a follower
 * a program starts and reads. Each frame is one JSON line on stdout and nothing else is ever written there: `hello`
 * first, naming every followed document with its revision, then a `changed` frame naming the documents whose
 * revision moved, at most one each {@link EVENTS_PASS_MS}. A frame names documents and revisions only, so the reader
 * runs `read --unless` for what it wants of them. A refusal goes to stderr before the first frame, as `read`'s does.
 *
 * It looks only at the stamps `read` hashes a revision from: it folds no register, builds no document, and writes no
 * file, no mark and no lock. It ends with exit 0 once the process that started it is gone or its stdout's reader is;
 * the reader's end is seen only at a frame's write, so with nothing changing it is the starter's end that stops it.
 *
 * The scope is opened once: a config edit moves every revision, but the sessions and paths the follower holds are
 * the ones it started with until it is started again. A revision it then names may differ from the one `read`
 * answers, which costs the reader one full answer and nothing else.
 */
export async function events(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const request = requestOf(args, runtime);
  let sources: ReadonlyMap<DocumentName, DocumentSource>;
  try {
    ({ sources } = await sourcesOf(request, runtime));
  } catch (error) {
    if (error instanceof RefusedError) {
      runtime.out.stderr(`REFUSED ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  }
  const watching = await runtime.starters.watch();
  const ended = (): boolean => watching.stop.aborted || runtime.out.closed?.aborted === true;
  try {
    let held = await revisionsOf(sources);
    runtime.out.stdout(JSON.stringify(helloFrame(held)));
    while (!ended()) {
      await runtime.sleep(EVENTS_PASS_MS);
      if (ended()) {
        break;
      }
      const now = await revisionsOf(sources);
      const frame = changedFrame(movedDocuments(held, now));
      if (frame !== undefined) {
        runtime.out.stdout(JSON.stringify(frame));
      }
      held = now;
    }
    return EXIT.ok;
  } finally {
    watching.close();
  }
}

function requestOf(args: ParsedArgs, runtime: CliRuntime): ReadRequest {
  const [extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}": events names its documents with --documents`);
  }
  if (!args.switches.has('json')) {
    throw new UsageError('events answers only as JSON in interface 1: add --json');
  }
  const documents = documentsOf(args.flags.get('documents'), args.flags.has('task'));
  return { documents, ...scopeFlagsOf(args, runtime.env), ...documentFlagsOf(args, documents), unless: new Map(), speaks: undefined };
}

/**
 * `--documents`: the documents to follow, each once. With the flag left out, every document of the interface, but
 * `history` only when `--task` names its task: `history` is one task's, so with no task it would refuse the whole run.
 */
function documentsOf(typed: string | undefined, taskNamed: boolean): readonly DocumentName[] {
  if (typed === undefined) {
    return taskNamed ? DOCUMENTS : DOCUMENTS.filter((name) => name !== 'history');
  }
  const documents: DocumentName[] = [];
  for (const name of typed.split(',')) {
    if (!isDocumentName(name)) {
      throw new UsageError(`${DOCUMENTS_FORM}; got "${name}"`);
    }
    if (documents.includes(name)) {
      throw new UsageError(`--documents names ${name} twice`);
    }
    documents.push(name);
  }
  return documents;
}

/**
 * Each followed document with its revision now. A document whose files could not be stamped (a permission refused,
 * a disk gone) is named with no revision, which differs from any it held: the reader then reads it and is told why.
 */
async function revisionsOf(sources: ReadonlyMap<DocumentName, DocumentSource>): Promise<DocumentRevision[]> {
  const revisions: DocumentRevision[] = [];
  for (const [document, source] of sources) {
    revisions.push({ document, revision: await revisionOrNull(source) });
  }
  return revisions;
}

async function revisionOrNull(source: DocumentSource): Promise<string | null> {
  try {
    return revisionOf(await source.parts());
  } catch {
    return null;
  }
}
