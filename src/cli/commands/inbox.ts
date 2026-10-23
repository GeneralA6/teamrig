import { LeadTree } from '../../config/lead-tree.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import { ENV, KIT_NAME, type Env, type TeamPaths } from '../../core/home.ts';
import { NAME_RULE } from '../../core/ids.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { groupIds, parseTo, type ToItem } from '../../inbox/groups.ts';
import { formatRead, formatStatus, inboxStatus, lineOnClock, postLines, readInbox, type InboxDeps } from '../../inbox/inbox.ts';
import { CLAUDE_SESSION_ID } from '../../inbox/marks.ts';
import { reachOf } from '../../inbox/reach.ts';
import { routeReminderOf } from '../../inbox/route.ts';
import { InboxDir, JsonlMarkLog } from '../../inbox/store.ts';
import { noPositionals, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { hookLogOf } from '../hook-logs.ts';
import { callerOf, sessionRef } from '../inputs.ts';
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree, type KitTree } from '../tree.ts';
import { verifyNoteOf } from './verify-queue.ts';

export function inboxDepsOf(runtime: CliRuntime, paths: TeamPaths): InboxDeps {
  return {
    inboxes: new InboxDir(runtime.files, paths.inbox),
    marks: new JsonlMarkLog(new PlainLogFile(runtime.files, paths.inboxMarks)),
    shown: new JsonlMarkLog(hookLogOf(runtime, paths, 'inbox-shown')),
  };
}

/** The Claude Code session running the command, so the reminder hook can follow it; null outside one. */
function claudeSessionOf(env: Env): string | null {
  const id = env[ENV.claudeSession];
  return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}

/**
 * `inbox read`: prints the caller's unread lines, but those the prompt hook showed this Claude Code
 * session, and marks them all read; then, when the caller holds verifying tasks, its verify queue in one line.
 */
export async function read(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const area = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  const now = new Date(runtime.clock.now());
  const result = await readInbox(inboxDepsOf(runtime, kit.paths), { area, claudeSession: claudeSessionOf(runtime.env), now });
  const zone = teamZone(config, runtime);
  result.lines.forEach((line) => runtime.out.stdout(lineOnClock(line, zone)));
  runtime.out.stdout(formatRead(result));
  const verify = await verifyNoteOf(runtime, kit.paths, area);
  if (verify !== undefined) {
    runtime.out.stdout(verify);
  }
  return EXIT.ok;
}

/** `inbox status`: unread counts per area, marking nothing. */
export async function status(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const only = args.flags.get('session');
  const ref = only === undefined ? undefined : sessionRef('--session', only);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const area = ref === undefined ? undefined : pastOrPresentIdOf(roster, ref);
  const statuses = await inboxStatus(inboxDepsOf(runtime, kit.paths), area);
  if (statuses.length === 0) {
    runtime.out.stdout(`INBOX no inbox ${area === undefined ? 'files' : `for ${area}`} in ${kit.paths.inbox}`);
  }
  const zone = teamZone(config, runtime);
  statuses.forEach((item) => runtime.out.stdout(formatStatus(item, zone)));
  return EXIT.ok;
}

/** Where a line goes: the recipient's team folder and config, its id, and how the line and the reply name it. */
interface Recipient {
  readonly paths: TeamPaths;
  readonly config: KitConfig;
  readonly id: string;
  /** `<id>` on the sender's own team, `<team>/<id>` on another. */
  readonly label: string;
  /** How the recipient's line names the sender: `<id>` on the sender's own team, `<team>/<id>` on another. */
  readonly sender: string;
  readonly crossing: boolean;
}

/** The sender's own team, as the recipients on it are resolved. */
interface SenderTeam {
  readonly from: SessionAddress;
  readonly paths: TeamPaths;
  readonly config: KitConfig;
  readonly roster: Roster;
}

function ownTeamRecipient(own: SenderTeam, id: string): Recipient {
  return { paths: own.paths, config: own.config, id, label: id, sender: own.from.id, crossing: false };
}

/**
 * A session of another team of the sender's tree, when the sender may write to it: a member only to
 * its own team, a lead also to its parent team's lead and its child teams' leads.
 */
async function recipientInTree(runtime: CliRuntime, loaded: KitTree, from: SessionAddress, team: string, session: string): Promise<Recipient> {
  const { tree, teams } = loaded;
  const target = teams.get(team);
  if (target === undefined) {
    throw new RefusedError(`no team ${team} with a config in this kit home`);
  }
  const to = { team, id: sessionIdOf(target.roster, session) };
  const own = teams.get(from.team);
  const reach = reachOf(tree, from, to, own === undefined ? undefined : new LeadTree(own.config).leaderOf(from.id));
  if (!reach.ok) {
    throw new RefusedError(reach.problem);
  }
  const kit = await openKit(runtime, team);
  return { paths: kit.paths, config: requireConfig(kit, runtime, 'write'), id: to.id, label: formatAddress(to), sender: formatAddress(from), crossing: true };
}

/** The recipients one `--to` item names: a group of the sender's team, or one session of its tree. */
async function recipientsOfItem(runtime: CliRuntime, own: SenderTeam, item: ToItem, tree: () => Promise<KitTree>): Promise<Recipient[]> {
  if (item.kind === 'session') {
    const { team, session } = item.address;
    return [team === undefined || team === own.from.team
      ? ownTeamRecipient(own, sessionIdOf(own.roster, session))
      : await recipientInTree(runtime, await tree(), own.from, team, session)];
  }
  const group = item.kind === 'group' ? { kind: item.kind, leader: sessionIdOf(own.roster, item.leader) } : item;
  const ids = groupIds(own.config, group, own.from.id);
  if (!ids.ok) {
    throw new RefusedError(ids.problem);
  }
  return ids.ids.map((id) => ownTeamRecipient(own, id));
}

/** Every recipient the `--to` items name, each once, in the order first named; refused when none is left. */
async function recipientsOf(runtime: CliRuntime, own: SenderTeam, items: readonly ToItem[], to: string): Promise<Recipient[]> {
  let loaded: Promise<KitTree> | undefined;
  const tree = (): Promise<KitTree> => (loaded ??= loadTree(runtime));
  const byLabel = new Map<string, Recipient>();
  for (const item of items) {
    for (const recipient of await recipientsOfItem(runtime, own, item, tree)) {
      if (!byLabel.has(recipient.label)) {
        byLabel.set(recipient.label, recipient);
      }
    }
  }
  if (byLabel.size === 0) {
    throw new RefusedError(`--to ${to} names no session but the sender ${own.from.id}`);
  }
  return [...byLabel.values()];
}

function postedLine(recipients: readonly Recipient[]): string {
  const [only] = recipients;
  if (recipients.length === 1 && only !== undefined) {
    return `POSTED to ${only.label}; ${only.label} is reminded at its next prompt`;
  }
  return `POSTED to ${recipients.length} sessions (${recipients.map((recipient) => recipient.label).join(', ')}); each is reminded at its next prompt`;
}

/**
 * The route reminders (T783) for the sessions of the sender's team that `--to` names one by one, each once. A group
 * (`all`, `leads`, `group:<leader>`) is a broadcast, not work handed past a sub-lead, so it gets none.
 */
function routeRemindersOf(own: SenderTeam, items: readonly ToItem[], text: string): string[] {
  const tree = new LeadTree(own.config);
  const reminders = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'session' || (item.address.team !== undefined && item.address.team !== own.from.team)) {
      continue;
    }
    const to = sessionIdOf(own.roster, item.address.session);
    const reminder = routeReminderOf(tree, { from: own.from.id, to, text }, (id) => id, KIT_NAME);
    if (reminder !== undefined) {
      reminders.add(reminder);
    }
  }
  return [...reminders];
}

const TO_FORMS = 'a session id or name, <team>/<id>, all, leads, group:<leader>, or a comma-separated list of them';

/**
 * `inbox add --to <to> --text "<line>"`: appends one dated line to each receiver's inbox, all of them or, when one is
 * refused, none. A bare id or name is on the sender's team; `<team>/<id>` reaches another team of its tree, as far as
 * the sender's place allows, and that line names the sender `<team>/<id>`. `all`, `leads` and `group:<leader>` are
 * groups of the sender's team that leave the sender out; a comma-separated list names each receiver once. A line to a
 * session named on the sender's team that skips a sub-lead below the sender is posted, then a further line tells the
 * sender to route such work via that sub-lead (T783).
 */
export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const to = requiredFlag(args.flags, 'to');
  const items = parseTo(to);
  if (items === undefined) {
    throw new UsageError(`--to "${to}" is not ${TO_FORMS} (${NAME_RULE})`);
  }
  const text = requiredFlag(args.flags, 'text');
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  const own: SenderTeam = { from: { team, id: sessionIdOf(roster, caller) }, paths: kit.paths, config, roster };
  const recipients = await recipientsOf(runtime, own, items, to);
  const secrets = new SecretScanner([
    ...config.register.secretPatterns,
    ...recipients.filter((recipient) => recipient.crossing).flatMap((recipient) => recipient.config.register.secretPatterns),
  ]);
  const targets = recipients.map((recipient) => ({ inboxes: inboxDepsOf(runtime, recipient.paths).inboxes, to: recipient.id, from: recipient.sender }));
  const problem = await postLines(targets, secrets, { text, now: new Date(runtime.clock.now()) });
  if (problem !== undefined) {
    throw new RefusedError(problem);
  }
  runtime.out.stdout(postedLine(recipients));
  for (const reminder of routeRemindersOf(own, items, text)) {
    runtime.out.stdout(reminder);
  }
  return EXIT.ok;
}
