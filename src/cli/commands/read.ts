import { createHash } from 'node:crypto';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { KIT_VERSION } from '../../core/version.ts';
import { GITHUB_CONNECTOR } from '../../github/connector.ts';
import {
  answerOf,
  checkInterfaceRange,
  DOCUMENTS,
  isDocumentName,
  parseInterfaceVersion,
  revisionText,
  tasksBody,
  type Connector,
  type DocumentName,
  type InterfaceVersion,
  type RevisionParts,
} from '../../interface/index.ts';
import type { Task } from '../../register/fold.ts';
import { layoutPaths, MissingSegmentError, readWorkingSet, type LayoutPaths } from '../../register/layout.ts';
import type { RegisterSnapshot } from '../../register/snapshot.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { configWarnings, findTeam, loadedConfig, openKit, pastOrPresentIdOf, rosterOf, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';

/** The trackers a document names a ref or a source by; a second one is one more entry here. */
const CONNECTORS: readonly Connector[] = [GITHUB_CONNECTOR];

/** What one run of `read` was asked for, checked as far as the command line alone allows. */
interface ReadRequest {
  readonly documents: readonly DocumentName[];
  readonly team: string | undefined;
  readonly owner: string | undefined;
  readonly speaks: InterfaceVersion | undefined;
}

/** What every document of one run is read from. */
interface ReadScope {
  readonly runtime: CliRuntime;
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  /** The one session whose tasks are served, by id; null serves every session's. */
  readonly owner: string | null;
  /** What the config's own read has to tell: every document is read through it, so each carries these. */
  readonly warnings: readonly string[];
}

/** A document's own fields, and what could only partly be served. */
interface Built {
  readonly body: object;
  readonly problems: readonly string[];
}

/**
 * One document: what its revision is made of, and its answer. `parts` reads file stamps only and is asked first,
 * so a write landing while `build` reads leaves the answer newer than its revision, never older: the reader's next
 * comparison then sees a change and reads again.
 */
interface DocumentSource {
  parts(): Promise<RevisionParts>;
  build(): Promise<Built>;
}

/** The documents this teamrig can build; the rest of interface 1 joins here, one by one. */
const SOURCES: Partial<Record<DocumentName, (scope: ReadScope) => DocumentSource>> = {
  tasks: tasksSource,
};

/**
 * `teamrig read <document>... --json`: the read side of the public interface (docs/design/public-interface.md).
 * Each document asked is answered as one JSON line on stdout, in the order asked, and nothing else is ever written
 * there: a refusal goes to stderr, where every other command writes it to stdout, so a reader parses every stdout
 * line without telling answers from words. A run answers every document it was asked or none. It writes no file,
 * no mark and no lock.
 */
export async function read(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const request = requestOf(args);
  try {
    const answers = await answersOf(request, runtime);
    answers.forEach((answer) => runtime.out.stdout(JSON.stringify(answer)));
    return EXIT.ok;
  } catch (error) {
    if (error instanceof RefusedError) {
      runtime.out.stderr(`REFUSED ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  }
}

function requestOf(args: ParsedArgs): ReadRequest {
  const documents = documentsOf(args.positionals);
  if (!args.switches.has('json')) {
    throw new UsageError('read answers only as JSON in interface 1: add --json');
  }
  const typed = args.flags.get('interface');
  const speaks = typed === undefined ? undefined : parseInterfaceVersion(typed);
  if (typed !== undefined && speaks === undefined) {
    throw new UsageError(`--interface takes <major.minor>, such as 1.0; got "${typed}"`);
  }
  return { documents, team: args.flags.get('team'), owner: args.flags.get('owner'), speaks };
}

function documentsOf(names: readonly string[]): DocumentName[] {
  if (names.length === 0) {
    throw new UsageError(`read needs a document: ${DOCUMENTS.join(', ')}`);
  }
  const documents: DocumentName[] = [];
  for (const name of names) {
    if (!isDocumentName(name)) {
      throw new UsageError(`unknown document "${name}"; the documents are ${DOCUMENTS.join(', ')}`);
    }
    if (documents.includes(name)) {
      throw new UsageError(`document ${name} is asked twice`);
    }
    if (SOURCES[name] === undefined) {
      throw new UsageError(`document ${name} is not served yet; this teamrig serves ${servedDocuments().join(', ')}`);
    }
    documents.push(name);
  }
  return documents;
}

function servedDocuments(): DocumentName[] {
  return DOCUMENTS.filter((name) => SOURCES[name] !== undefined);
}

async function answersOf(request: ReadRequest, runtime: CliRuntime): Promise<object[]> {
  const range = checkInterfaceRange(request.speaks);
  if (!range.served) {
    throw new RefusedError(range.reason);
  }
  const scope = await scopeOf(request, runtime);
  const answers: object[] = [];
  for (const name of request.documents) {
    const source = SOURCES[name]?.(scope);
    if (source !== undefined) {
      const revision = revisionOf(await source.parts());
      const built = await source.build();
      answers.push(answerOf(name, revision, [...scope.warnings, ...built.problems], built.body));
    }
  }
  return answers;
}

/**
 * The team a run reads: the caller's own, or with `--team` one above it in its tree, whose work the caller's team
 * is part of. Any other team is refused, a team below too: what a team shows the ones above it is its own call.
 */
async function scopeOf(request: ReadRequest, runtime: CliRuntime): Promise<ReadScope> {
  const own = (await findTeam(runtime)).team;
  const team = request.team ?? own;
  if (team !== own && !(await loadTree(runtime)).tree.ancestorsOf(own).includes(team)) {
    throw new RefusedError(`read serves your own team (${own}) and the teams above it; --team ${team} names neither`);
  }
  const kit = await openKit(runtime, team);
  const load = loadedConfig(kit);
  const roster = await rosterOf(runtime, kit, load.config);
  const owner = request.owner === undefined ? null : pastOrPresentIdOf(roster, request.owner);
  return { runtime, kit, config: load.config, roster, owner, warnings: configWarnings(load) };
}

/**
 * The revision a document's parts hash to. This teamrig's own version is hashed in beside them: a release may
 * change what the same files are served as with no new interface version (a fixed builder, a new secret shape), and
 * a reader must not be told `unchanged` across it.
 */
function revisionOf(parts: RevisionParts): string {
  return createHash('sha256').update(KIT_VERSION).update('\n').update(revisionText(parts)).digest('hex').slice(0, 16);
}

async function stampsOf(runtime: CliRuntime, paths: readonly string[]): Promise<(string | null)[]> {
  const stamps: (string | null)[] = [];
  for (const path of paths) {
    stamps.push((await runtime.files.stamp(path)) ?? null);
  }
  return stamps;
}

/**
 * `tasks`: the register's working set. It reads the config (the owner's marker, the secret shapes, the sessions),
 * the renames (a session's name), the register's snapshot and its events after it. The archive's segments count by
 * name, so one that went missing and came back changes the revision as it changes the answer: a segment is written
 * once, and a folder's own stamp does not move with its entries on every file system.
 */
function tasksSource(scope: ReadScope): DocumentSource {
  const { runtime, kit, config, roster } = scope;
  const layout = layoutPaths(kit.paths.events);
  return {
    async parts() {
      return {
        document: 'tasks',
        args: [
          ['team', kit.paths.team],
          ['owner', scope.owner],
        ],
        stamps: [
          ...(await stampsOf(runtime, [kit.load.path, kit.paths.renames, layout.snapshot, layout.tail])),
          (await runtime.files.list(layout.archive)).join(','),
        ],
      };
    },
    async build() {
      const register = await workingSetOf(runtime, layout);
      const body = tasksBody({
        tasks: register.tasks,
        owner: scope.owner,
        shapes: new SecretScanner(config.register.secretPatterns),
        connectors: CONNECTORS,
        names: { owner: config.register.ownerSource, connectors: CONNECTORS, nameOf: (session) => roster.nameOf(session) },
      });
      return { body, problems: register.problems };
    },
  };
}

interface WorkingSet {
  readonly tasks: Iterable<Task>;
  readonly problems: readonly string[];
}

/**
 * The register's tasks and what could not be read of them. An archive with a segment gone serves no task and says
 * why, where a text command refuses: one broken document must not take down the others asked in the same run.
 */
async function workingSetOf(runtime: CliRuntime, layout: LayoutPaths): Promise<WorkingSet> {
  try {
    const snapshot = await readWorkingSet(runtime.files, layout);
    return { tasks: snapshot.state.tasks.values(), problems: damageOf(snapshot, layout.tail) };
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      return { tasks: [], problems: [error.message] };
    }
    throw error;
  }
}

/** Damaged or newer lines never stop a read; each kind left out is one line, so a reader shows which it is. */
function damageOf(snapshot: RegisterSnapshot, path: string): string[] {
  const { unreadable, newer } = snapshot.read;
  const { orphans } = snapshot.state;
  return [
    ...(unreadable > 0 ? [`${path}: ${unreadable} unreadable line(s) left out`] : []),
    ...(newer > 0 ? [`${path}: ${newer} line(s) from a newer teamrig left out; update teamrig`] : []),
    ...(orphans > 0 ? [`${path}: ${orphans} event(s) naming no task left out`] : []),
  ];
}
