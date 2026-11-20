import { createHash } from 'node:crypto';
import { ENV, type Env } from '../../core/home.ts';
import { ID_PATTERN, ID_RULE } from '../../core/ids.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { KIT_VERSION } from '../../core/version.ts';
import { GITHUB_CONNECTOR } from '../../github/connector.ts';
import { lineHash } from '../../inbox/line-hash.ts';
import { indexMarks } from '../../inbox/marks.ts';
import { InboxDir, JsonlMarkLog } from '../../inbox/store.ts';
import { unreadOf } from '../../inbox/unread.ts';
import {
  answerOf,
  checkInterfaceRange,
  DOCUMENTS,
  inboxBody,
  isDocumentName,
  parseInterfaceVersion,
  revisionText,
  tasksBody,
  unchangedAnswer,
  type Connector,
  type DocumentName,
  type InterfaceVersion,
  type RevisionParts,
} from '../../interface/index.ts';
import type { Roster } from '../../config/roster.ts';
import type { Task } from '../../register/fold.ts';
import { layoutPaths, MissingSegmentError, readWorkingSet, type LayoutPaths } from '../../register/layout.ts';
import type { RegisterSnapshot } from '../../register/snapshot.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { sessionRef } from '../inputs.ts';
import { foundTeamOf, loadedConfig, lookForTeam, openKit, pastOrPresentIdOf, rosterOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { configSource, teamlessConfigSource } from './read-config.ts';
import { meetingsSource } from './read-meetings.ts';
import { selfOf, sessionsSource } from './read-sessions.ts';
import { configProblemsOf, once, servedPathOf, skippedOf, stampsOf, type DocumentSource, type ReadScope, type ServedFolder } from './read-source.ts';

/** The trackers a document names a ref or a source by; a second one is one more entry here. */
const CONNECTORS: readonly Connector[] = [GITHUB_CONNECTOR];

/** How far back `inbox` serves the lines already read, when `--since` names no other reach. */
const READ_LINES_HOURS = 24;
const HOUR_MS = 3_600_000;

/** What one run of `read` was asked for, checked as far as the command line and the environment alone allow. */
interface ReadRequest {
  readonly documents: readonly DocumentName[];
  readonly team: string | undefined;
  readonly owner: string | undefined;
  /** Who is asking, by id or name: a label for whose inbox to serve, as `inbox status` takes it, never a proof. */
  readonly session: string | undefined;
  /** The host's own id of the conversation asking, which `sessions` answers `self` by; a label too. */
  readonly conversation: string | undefined;
  readonly sinceHours: number;
  /** The revision the reader already holds of a document, for each it named with `--unless`. */
  readonly unless: ReadonlyMap<DocumentName, string>;
  readonly speaks: InterfaceVersion | undefined;
}

/** A revision as `read` serves one ({@link revisionOf}); `--unless` takes no other text. */
const REVISION_PATTERN = /^[0-9a-f]{16}$/;
const UNLESS_FORM = '--unless takes <document>=<revision>[,<document>=<revision>...], a revision being the 16 hex characters read answered';

/** A host's conversation id is opaque; this only keeps one a shell or a path could misread out of the run. */
const CONVERSATION_PATTERN = /^[\w.:-]{1,128}$/;

/** How each document of interface 1 is built for a team; a new document is one more entry. */
const SOURCES: Record<DocumentName, (scope: ReadScope) => DocumentSource> = {
  tasks: tasksSource,
  inbox: inboxSource,
  sessions: sessionsSource,
  meetings: meetingsSource,
  config: configSource,
};

/** The documents a run with no team is still answered: what a setup screen reads before there is a team to read. */
const TEAMLESS: Partial<Record<DocumentName, (runtime: CliRuntime) => DocumentSource>> = {
  config: teamlessConfigSource,
};

/**
 * `teamrig read <document>... --json`: the read side of the public interface (docs/design/public-interface.md).
 * Each document asked is answered as one JSON line on stdout, in the order asked, and nothing else is ever written
 * there: a refusal goes to stderr, where every other command writes it to stdout, so a reader parses every stdout
 * line without telling answers from words. A run answers every document it was asked or none. It writes no file,
 * no mark and no lock.
 */
export async function read(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const request = requestOf(args, runtime.env);
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

function requestOf(args: ParsedArgs, env: Env): ReadRequest {
  const documents = documentsOf(args.positionals);
  if (!args.switches.has('json')) {
    throw new UsageError('read answers only as JSON in interface 1: add --json');
  }
  const typed = args.flags.get('interface');
  const speaks = typed === undefined ? undefined : parseInterfaceVersion(typed);
  if (typed !== undefined && speaks === undefined) {
    throw new UsageError(`--interface takes <major.minor>, such as 1.0; got "${typed}"`);
  }
  return {
    documents,
    team: teamOf(args.flags.get('team')),
    owner: ownerOf(args.flags.get('owner')),
    session: askerOf(args.flags.get('session'), env),
    conversation: conversationOf(args.flags.get('conversation')),
    sinceHours: sinceHoursOf(args.flags.get('since')),
    unless: unlessOf(args.flags.get('unless'), documents),
    speaks,
  };
}

/**
 * `--unless`: the revision the reader holds of each document it names, one flag with a comma list since a flag is
 * taken once. An entry is refused unless it names a document this run asks, once, with a revision of the shape
 * `read` serves: a typo then fails loudly, where a revision that could never match would only cost the full answer
 * on every run.
 */
function unlessOf(typed: string | undefined, documents: readonly DocumentName[]): ReadonlyMap<DocumentName, string> {
  const held = new Map<DocumentName, string>();
  if (typed === undefined) {
    return held;
  }
  for (const entry of typed.split(',')) {
    const [name, revision, ...rest] = entry.split('=');
    if (name === undefined || revision === undefined || rest.length > 0 || !REVISION_PATTERN.test(revision)) {
      throw new UsageError(`${UNLESS_FORM}; got "${entry}"`);
    }
    if (!isDocumentName(name)) {
      throw new UsageError(`--unless names an unknown document "${name}"; the documents are ${DOCUMENTS.join(', ')}`);
    }
    if (!documents.includes(name)) {
      throw new UsageError(`--unless names ${name}, which this run does not ask for`);
    }
    if (held.has(name)) {
      throw new UsageError(`--unless names ${name} twice`);
    }
    held.set(name, revision);
  }
  return held;
}

/** `--team` names a folder of the kit home, so it is held to an id's shape before the tree is asked about it. */
function teamOf(typed: string | undefined): string | undefined {
  if (typed !== undefined && !ID_PATTERN.test(typed)) {
    throw new UsageError(`--team "${typed}" is not a team id (${ID_RULE})`);
  }
  return typed;
}

/** `--owner` only filters the tasks served, and is held to a session's shape all the same, as `--session` is. */
function ownerOf(typed: string | undefined): string | undefined {
  return typed === undefined ? undefined : sessionRef('--owner', typed);
}

function conversationOf(typed: string | undefined): string | undefined {
  if (typed !== undefined && !CONVERSATION_PATTERN.test(typed)) {
    throw new UsageError('--conversation takes the host\'s conversation id: 1 to 128 letters, digits, "_", ".", ":" or "-"');
  }
  return typed;
}

/** Who is asking: `--session`, else the session variable; undefined with neither, which only `inbox` minds. */
function askerOf(flag: string | undefined, env: Env): string | undefined {
  const name = flag ?? env[ENV.session]?.trim();
  return name === undefined || name === '' ? undefined : sessionRef('--session', name);
}

function sinceHoursOf(typed: string | undefined): number {
  if (typed === undefined) {
    return READ_LINES_HOURS;
  }
  if (!/^\d{1,5}$/.test(typed)) {
    throw new UsageError(`--since takes whole hours, such as ${READ_LINES_HOURS}; got "${typed}"`);
  }
  return Number(typed);
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
    documents.push(name);
  }
  return documents;
}

async function answersOf(request: ReadRequest, runtime: CliRuntime): Promise<object[]> {
  const range = checkInterfaceRange(request.speaks);
  if (!range.served) {
    throw new RefusedError(range.reason);
  }
  const { sources, warnings } = await sourcesOf(request, runtime);
  const answers: object[] = [];
  for (const [name, source] of sources) {
    const revision = revisionOf(await source.parts());
    if (request.unless.get(name) === revision) {
      // The reader holds this revision: its files' stamps were read to know it, and nothing is folded or built.
      answers.push(unchangedAnswer(name, revision));
      continue;
    }
    const built = await source.build();
    answers.push(answerOf(name, revision, [...warnings, ...built.problems], built.body));
  }
  return answers;
}

/** What one run answers from: each document asked with its source, in the order asked. */
interface ReadSources {
  readonly sources: ReadonlyMap<DocumentName, DocumentSource>;
  /** What every document of the run carries in its problems. */
  readonly warnings: readonly string[];
}

/**
 * The sources of the documents asked. A run with no team is answered only when every document asked has an answer
 * for one ({@link TEAMLESS}) and no `--team` is named; any other is refused as every command with no team is, since
 * a run answers every document it was asked or none.
 */
async function sourcesOf(request: ReadRequest, runtime: CliRuntime): Promise<ReadSources> {
  const found = await lookForTeam(runtime);
  if (found.kind === 'none' && request.team === undefined) {
    const teamless = new Map<DocumentName, DocumentSource>();
    for (const name of request.documents) {
      const source = TEAMLESS[name]?.(runtime);
      if (source !== undefined) {
        teamless.set(name, source);
      }
    }
    if (teamless.size === request.documents.length) {
      return { sources: teamless, warnings: [] };
    }
  }
  const scope = await scopeOf(request, runtime, foundTeamOf(found).team);
  return { sources: new Map(request.documents.map((name) => [name, SOURCES[name](scope)])), warnings: scope.warnings };
}

/**
 * The team a run reads: the caller's own, or with `--team` one above it in its tree, whose work the caller's team
 * is part of. Any other team is refused, a team below too: what a team shows the ones above it is its own call.
 * With `--conversation` and no session named, the asker is the session of the caller's team that conversation runs
 * in, so a host that knows only its conversation still reads its own inbox.
 */
async function scopeOf(request: ReadRequest, runtime: CliRuntime, own: string): Promise<ReadScope> {
  const tree = once(() => loadTree(runtime));
  const team = request.team ?? own;
  if (team !== own && !(await tree()).tree.ancestorsOf(own).includes(team)) {
    throw new RefusedError(`read serves your own team (${own}) and the teams above it; --team ${team} names neither`);
  }
  const kit = await openKit(runtime, team);
  const load = loadedConfig(kit);
  const roster = await rosterOf(runtime, kit, load.config);
  const conversation = request.conversation ?? null;
  const self = conversation === null ? null : await selfOf(runtime, await tree(), own, conversation);
  return {
    runtime,
    own,
    kit,
    config: load.config,
    roster,
    owner: request.owner === undefined ? null : pastOrPresentIdOf(roster, request.owner),
    asker: request.session ?? (self?.team === own ? self.session : null),
    conversation,
    self,
    tree,
    sinceHours: request.sinceHours,
    warnings: configProblemsOf(kit.paths, load),
  };
}

/**
 * The revision a document's parts hash to. This teamrig's own version is hashed in beside them: a release may
 * change what the same files are served as with no new interface version (a fixed builder, a new secret shape), and
 * a reader must not be told `unchanged` across it.
 */
function revisionOf(parts: RevisionParts): string {
  return createHash('sha256').update(KIT_VERSION).update('\n').update(revisionText(parts)).digest('hex').slice(0, 16);
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
      const register = await workingSetOf(runtime, kit.paths, layout);
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

/**
 * `inbox`: the asking session's own inbox, its unread lines and the read ones of the last `--since` hours. It reads
 * the config (the secret shapes, the session's name), the renames, the session's inbox file and the read marks, and
 * never `readInbox`, which marks the lines read. The clock is no part of its revision: a line leaves the window with
 * no file changing, so a reader holding an unchanged revision applies the window again over the `at` it holds.
 */
function inboxSource(scope: ReadScope): DocumentSource {
  const { runtime, kit, config, roster } = scope;
  if (kit.paths.team !== scope.own) {
    throw new UsageError(`inbox is the asking session's own, in its own team (${scope.own}): ask for it without --team`);
  }
  if (scope.asker === null) {
    const held = scope.conversation === null ? '' : `no session of team ${scope.own} holds conversation ${scope.conversation}; `;
    throw new UsageError(`inbox is one session's: ${held}name it with --session (or $${ENV.session})`);
  }
  const session = inboxSessionOf(roster, scope.asker);
  const inboxes = new InboxDir(runtime.files, kit.paths.inbox);
  const marks = new JsonlMarkLog(new PlainLogFile(runtime.files, kit.paths.inboxMarks));
  return {
    async parts() {
      return {
        document: 'inbox',
        args: [
          ['team', kit.paths.team],
          ['session', session],
          ['since', String(scope.sinceHours)],
        ],
        stamps: await stampsOf(runtime, [kit.load.path, kit.paths.renames, inboxes.pathOf(session), kit.paths.inboxMarks]),
      };
    },
    async build() {
      const lines = (await inboxes.lines(session)) ?? [];
      const log = await marks.read();
      const mark = indexMarks(log.marks).byArea.get(session) ?? null;
      const body = inboxBody({
        session: { id: session, name: roster.nameOf(session) ?? session },
        lines,
        unread: mark === null ? null : unreadOf(session, lines, mark, lineHash).lines.length,
        readSince: runtime.clock.now() - scope.sinceHours * HOUR_MS,
        keyOf: lineHash,
        connectors: CONNECTORS,
        shapes: new SecretScanner(config.register.secretPatterns),
      });
      return { body, problems: skippedOf(kit.paths, kit.paths.inboxMarks, log) };
    },
  };
}

/**
 * The session whose inbox is served: one the team has now, by id or by any name it has had. Any other is refused
 * before its inbox file is named, a session the team once had too: the id becomes a file's name, so only an id the
 * config holds may be one, where `--owner`, which builds no path, also takes an id the team no longer has.
 */
function inboxSessionOf(roster: Roster, asker: string): string {
  const found = roster.lookup(asker);
  if (!found.ok) {
    throw new RefusedError(found.error);
  }
  return found.id;
}

interface WorkingSet {
  readonly tasks: Iterable<Task>;
  readonly problems: readonly string[];
}

/**
 * The register's tasks and what could not be read of them. An archive with a segment gone serves no task and says
 * why, where a text command refuses: one broken document must not take down the others asked in the same run.
 */
async function workingSetOf(runtime: CliRuntime, folder: ServedFolder, layout: LayoutPaths): Promise<WorkingSet> {
  try {
    const snapshot = await readWorkingSet(runtime.files, layout);
    return { tasks: snapshot.state.tasks.values(), problems: damageOf(snapshot, folder, layout.tail) };
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      const segment = servedPathOf(folder, error.path);
      return { tasks: [], problems: [`${segment}: missing, so the register's archive is incomplete and its tasks cannot be read`] };
    }
    throw error;
  }
}

/** Damaged or newer lines never stop a read; each kind left out is one line, so a reader shows which it is. */
function damageOf(snapshot: RegisterSnapshot, folder: ServedFolder, path: string): string[] {
  const { orphans } = snapshot.state;
  const unowned = orphans > 0 ? [`${servedPathOf(folder, path)}: ${orphans} event(s) naming no task left out`] : [];
  return [...skippedOf(folder, path, snapshot.read), ...unowned];
}
