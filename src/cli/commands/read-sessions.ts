import { basename } from 'node:path';
import { describeLaunch, launchOf } from '../../config/launch.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import { Roster } from '../../config/roster.ts';
import type { TeamTree } from '../../config/tree.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { HiringLog } from '../../hiring/log.ts';
import { activeHires, rehiredFrom, retiredSessions } from '../../hiring/record.ts';
import { lineHash } from '../../inbox/line-hash.ts';
import { indexMarks } from '../../inbox/marks.ts';
import { InboxDir, JsonlMarkLog } from '../../inbox/store.ts';
import { unreadOf } from '../../inbox/unread.ts';
import { sessionsBody, type MemberInput, type ServedHost, type SessionPlace, type TeamFailure, type TeamInput, type TeamReach } from '../../interface/index.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import { TabNeedStore } from '../../tabs/need.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamsFolderOf, type KitTree, type TreeTeam } from '../tree.ts';
import { servedPathOf, skippedOf, stampsOf, type DocumentSource, type ReadScope } from './read-source.ts';

/** The one program a session runs in, until a team's config names each session's host. */
const HOST: ServedHost = { id: 'claude-code', name: 'Claude Code' };

/** The loaded teams of the tree `own` is in, the root first, then each team's children by id, depth first. */
function treeTeamsOf(loaded: KitTree, own: string): TreeTeam[] {
  const teams: TreeTeam[] = [];
  for (const { team } of loaded.tree.walk(loaded.tree.rootOf(own) ?? own)) {
    const found = loaded.teams.get(team);
    if (found !== undefined) {
      teams.push(found);
    }
  }
  return teams;
}

/**
 * The session a host's conversation runs in: the one of the tree's teams whose record of its last start names it,
 * and the newest such start when two records do (a conversation resumed under another session). Null when no
 * record names it. The id is a label, as `--session` is: it proves nothing about who asks.
 */
export async function selfOf(runtime: CliRuntime, loaded: KitTree, own: string, conversation: string): Promise<SessionPlace | null> {
  let newest: { readonly place: SessionPlace; readonly at: number } | undefined;
  for (const { kit, config } of treeTeamsOf(loaded, own)) {
    const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(config.sessions);
    for (const [session, record] of records) {
      const at = record?.claudeSession === conversation ? Date.parse(record.at) : undefined;
      if (at !== undefined && (newest === undefined || at > newest.at)) {
        newest = { place: { team: kit.paths.team, session }, at };
      }
    }
  }
  return newest?.place ?? null;
}

/** The files one team's sessions are read from, apart from its config: each one's stamp is part of the revision. */
function teamFilesOf(runtime: CliRuntime, { kit, config }: TreeTeam): string[] {
  const inboxes = new InboxDir(runtime.files, kit.paths.inbox);
  const tabs = new TabNeedStore(runtime.files, kit.paths);
  const records = new SessionRecordStore(runtime.files, kit.paths);
  return [
    kit.paths.renames,
    kit.paths.hires,
    kit.paths.inboxMarks,
    ...config.sessions.flatMap((id) => [inboxes.pathOf(id), tabs.pathOf(id), records.pathOf(id)]),
  ];
}

interface TeamRead {
  readonly input: TeamInput;
  readonly problems: readonly string[];
}

/** Where `team` stands to the caller's `own`: only its own team's and the ones above it serve their words. */
function reachOf(tree: TeamTree, own: string, team: string): TeamReach {
  if (team === own) {
    return 'own';
  }
  return tree.ancestorsOf(own).includes(team) ? 'above' : 'other';
}

/** One team's sessions as its files hold them now, and the lines of its logs that could not be read. */
async function teamInputOf(runtime: CliRuntime, tree: TeamTree, own: string, { kit, config }: TreeTeam): Promise<TeamRead> {
  const { files } = runtime;
  const team = kit.paths.team;
  const { renames } = await new JsonlRenameLog(files, kit.paths.renames).read();
  const hiring = await new HiringLog(files, kit.paths.hires).read();
  const retired = retiredSessions(hiring.records).filter((retire) => !config.sessions.includes(retire.session));
  // A retired session is on no roster; one built over its id too gives it the name it left with.
  const roster = new Roster({ ...config, sessions: [...config.sessions, ...retired.map((retire) => retire.session)] }, team, renames);
  const leads = new LeadTree(config);
  const hires = new Map(activeHires(hiring.records).map((hire) => [hire.session, hire]));
  const markLog = await new JsonlMarkLog(new PlainLogFile(files, kit.paths.inboxMarks)).read();
  const marks = indexMarks(markLog.marks).byArea;
  const inboxes = new InboxDir(files, kit.paths.inbox);
  const tabs = new TabNeedStore(files, kit.paths);
  const records = await new SessionRecordStore(files, kit.paths).readEach(config.sessions);
  const members: MemberInput[] = [];
  for (const id of config.sessions) {
    const mark = marks.get(id);
    const launch = launchOf(config, id);
    members.push({
      id,
      name: roster.nameOf(id) ?? id,
      formerNames: roster.formerNamesOf(id),
      roles: roster.rolesOf(id),
      leader: leads.leaderOf(id) ?? null,
      ledBy: leads.chainOf(id),
      leads: leads.membersOf(id).length,
      launch: { model: launch.model ?? null, effort: launch.effort ?? null, text: describeLaunch(launch) },
      hire: hires.get(id) ?? null,
      rehiredFrom: rehiredFrom(hiring.records, id) ?? null,
      unread: mark === undefined ? null : unreadOf(id, (await inboxes.lines(id)) ?? [], mark, lineHash).lines.length,
      tab: (await tabs.read(id)) ?? null,
      host: HOST,
      conversation: records.get(id)?.claudeSession ?? null,
    });
  }
  const input: TeamInput = {
    id: team,
    parent: tree.node(team)?.parent ?? null,
    reach: reachOf(tree, own, team),
    members,
    retired: retired.map((retire) => ({
      id: retire.session,
      name: roster.nameOf(retire.session) ?? retire.session,
      formerNames: roster.formerNamesOf(retire.session),
      retire,
    })),
  };
  const skipped = hiring.skipped > 0 ? [`${servedPathOf(kit.paths, kit.paths.hires)}: ${hiring.skipped} damaged or newer line(s) left out`] : [];
  return { input, problems: [...skippedOf(kit.paths, kit.paths.inboxMarks, markLog), ...skipped] };
}

/**
 * The team folders whose config cannot be read. A folder with no config is no team, and is not one of them. The
 * reason is the same text for each: why the file did not parse is the parser's message, which quotes the file.
 */
function failuresOf(loaded: KitTree): TeamFailure[] {
  return [...loaded.leftOut].flatMap(([team, load]) =>
    load.status === 'unreadable' ? [{ team, reason: `${team}/${basename(load.path)} cannot be read as a team config` }] : [],
  );
}

/**
 * `sessions`: every session of the tree the caller's team is in, as `teamrig who` and `teamrig team tree` show them
 * to any session, so `--team` changes nothing here. It reads every team's config, renames, hire log, read marks and
 * each session's inbox, tab file and start record; no process is listed. A team folder whose config cannot be read
 * has no known parent, so each one of the kit home is a `failures` row, whichever tree it belonged to. A text is cut
 * by any tree team's secret shapes, so what one team would cut is cut whoever asks. A team beside or below the
 * caller's is served without its own words, and only the caller's own team with its conversation ids (`TeamReach`).
 */
export function sessionsSource(scope: ReadScope): DocumentSource {
  const { runtime, own } = scope;
  return {
    async parts() {
      const loaded = await scope.tree();
      const configs = [...[...loaded.teams.values()].map(({ kit }) => kit.load.path), ...[...loaded.leftOut.values()].map((load) => load.path)];
      const files = treeTeamsOf(loaded, own).flatMap((team) => teamFilesOf(runtime, team));
      return {
        document: 'sessions',
        args: [
          ['team', own],
          ['conversation', scope.conversation],
        ],
        // A team folder added or removed moves no file the tree read: the folder's own listing tells.
        stamps: [(await runtime.files.list(teamsFolderOf(runtime))).join(','), ...(await stampsOf(runtime, [...configs, ...files]))],
      };
    },
    async build() {
      const loaded = await scope.tree();
      const teams = treeTeamsOf(loaded, own);
      const inputs: TeamInput[] = [];
      const problems: string[] = [];
      for (const team of teams) {
        const read = await teamInputOf(runtime, loaded.tree, own, team);
        inputs.push(read.input);
        problems.push(...read.problems);
      }
      const failures = failuresOf(loaded);
      const broken = loaded.tree.problemsOf(own).length;
      const body = sessionsBody({
        self: scope.self,
        teams: inputs,
        failures,
        shapes: new SecretScanner(teams.flatMap(({ config }) => config.register.secretPatterns)),
      });
      return {
        body,
        problems: [
          ...failures.map((failure) => failure.reason),
          ...problems,
          ...(broken > 0 ? [`the tree has ${broken} problem(s); run: teamrig doctor`] : []),
        ],
      };
    },
  };
}
