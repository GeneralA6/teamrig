import { claudeProjectsDir, lastWriteOf } from '../../budget/discover.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import { errorMessage } from '../../core/guards.ts';
import { ENV, KIT_NAME, type Env, type TeamPaths } from '../../core/home.ts';
import { NAME_RULE } from '../../core/ids.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { SecretScanner } from '../../core/secrets.ts';
import type { TimeZone } from '../../core/zone.ts';
import { groupIds, parseTo, taskGroupOf, treeLeadsOf, type ToItem } from '../../inbox/groups.ts';
import { formatRead, formatStatus, inboxLineOf, inboxStatus, lineOnClock, postLines, readInbox, type InboxDeps } from '../../inbox/inbox.ts';
import { lineHash } from '../../inbox/line-hash.ts';
import { CLAUDE_SESSION_ID, RECEIVER_TABS, tabsOf, type InboxMark } from '../../inbox/marks.ts';
import { reachOf } from '../../inbox/reach.ts';
import { routeReminderOf } from '../../inbox/route.ts';
import { InboxDir, JsonlMarkLog } from '../../inbox/store.ts';
import { WAKE_AT_ONCE, WAKE_NOW, wakeByOf, wakeRefusal, wakesLine, type ReceiverWake, type WakeSender, type WakeTarget, type WakeWhen } from '../../inbox/wake-now.ts';
import { WakeAsks } from '../../wake/asks.ts';
import { wakeCost } from '../../wake/decide.ts';
import { noPositionals, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { hookLogOf } from '../hook-logs.ts';
import { callerOf, instantOf, sessionRef } from '../inputs.ts';
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readMeasuredTurns, readTodayWPerPct } from '../stored-week.ts';
import { TreeTasks, type TreeRegister } from '../tree-tasks.ts';
import { loadTree, type KitTree, type TreeTeam } from '../tree.ts';
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

/** Where a line goes: the recipient's team, its folder and config, its id, and how the line and the reply name it. */
interface Recipient {
  readonly team: string;
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
  return { team: own.from.team, paths: own.paths, config: own.config, id, label: id, sender: own.from.id, crossing: false };
}

function teamOf(loaded: KitTree, team: string): TreeTeam {
  const target = loaded.teams.get(team);
  if (target === undefined) {
    throw new RefusedError(`no team ${team} with a config in this kit home`);
  }
  return target;
}

/** A session of another team, when it is in the sender's tree (reachOf). */
function recipientInTree(runtime: CliRuntime, loaded: KitTree, from: SessionAddress, to: SessionAddress): Recipient {
  const target = teamOf(loaded, to.team);
  const reach = reachOf(loaded.tree, from, to);
  if (!reach.ok) {
    throw new RefusedError(reach.problem);
  }
  return {
    team: to.team,
    paths: target.kit.paths,
    config: requireConfig(target.kit, runtime, 'write'),
    id: to.id,
    label: formatAddress(to),
    sender: formatAddress(from),
    crossing: true,
  };
}

/** A session of the sender's tree as `{ team, id }`: the sender's own team takes the own-team form, the sender left out. */
function recipientsAt(runtime: CliRuntime, own: SenderTeam, loaded: KitTree, addresses: readonly SessionAddress[]): Recipient[] {
  return addresses
    .filter((to) => to.team !== own.from.team || to.id !== own.from.id)
    .map((to) => (to.team === own.from.team ? ownTeamRecipient(own, to.id) : recipientInTree(runtime, loaded, own.from, to)));
}

/** The sender's tree of teams, each part read at most once and only when a `--to` item needs it. */
class SenderTreeReads {
  private readonly runtime: CliRuntime;
  private readonly team: string;
  private loaded: Promise<KitTree> | undefined;
  private registers: Promise<TreeRegister[] | undefined> | undefined;

  constructor(runtime: CliRuntime, team: string) {
    this.runtime = runtime;
    this.team = team;
  }

  tree(): Promise<KitTree> {
    this.loaded ??= loadTree(this.runtime);
    return this.loaded;
  }

  /** The working set of every register of the sender's tree, in its walk order; undefined when its parents go round a loop. */
  treeRegisters(): Promise<TreeRegister[] | undefined> {
    this.registers ??= this.tree().then((loaded) => new TreeTasks(this.runtime, loaded).registersFor(this.team));
    return this.registers;
  }
}

function loopRefusal(team: string, what: string): RefusedError {
  return new RefusedError(`the parent teams above ${team} go round a loop, so its tree has no ${what}: teamrig doctor names the loop`);
}

/** `tree:leads`: every team's lead in the sender's tree, root first; refused when the tree has no root. */
function treeLeadRecipients(runtime: CliRuntime, own: SenderTeam, loaded: KitTree): Recipient[] {
  const leads = treeLeadsOf(loaded.tree, own.from.team);
  if (leads === undefined) {
    throw loopRefusal(own.from.team, 'leads to list');
  }
  return recipientsAt(runtime, own, loaded, leads);
}

/**
 * `task:T<n>`: the sessions working the task across the sender's tree ({@link taskGroupOf}), but an owner no longer
 * a session of its team; refused when no register of the tree holds the task, or the tree has no root.
 */
async function taskRecipients(runtime: CliRuntime, own: SenderTeam, reads: SenderTreeReads, id: string): Promise<Recipient[]> {
  const registers = await reads.treeRegisters();
  if (registers === undefined) {
    throw loopRefusal(own.from.team, 'registers to read');
  }
  const group = taskGroupOf(registers.map(({ team, snapshot }) => ({ team, tasks: snapshot.state.tasks })), own.from.team, id);
  if (!group.ok) {
    throw new RefusedError(group.problem);
  }
  const loaded = await reads.tree();
  return recipientsAt(runtime, own, loaded, group.sessions.filter((session) => teamOf(loaded, session.team).config.sessions.includes(session.id)));
}

/** The recipients one `--to` item names: a group of the sender's team or of its tree, or one session of its tree. */
async function recipientsOfItem(runtime: CliRuntime, own: SenderTeam, item: ToItem, reads: SenderTreeReads): Promise<Recipient[]> {
  if (item.kind === 'session') {
    const { team, session } = item.address;
    if (team === undefined || team === own.from.team) {
      return [ownTeamRecipient(own, sessionIdOf(own.roster, session))];
    }
    const loaded = await reads.tree();
    return [recipientInTree(runtime, loaded, own.from, { team, id: sessionIdOf(teamOf(loaded, team).roster, session) })];
  }
  if (item.kind === 'team') {
    const loaded = await reads.tree();
    return recipientsAt(runtime, own, loaded, teamOf(loaded, item.team).config.sessions.map((id) => ({ team: item.team, id })));
  }
  if (item.kind === 'tree-leads') {
    return treeLeadRecipients(runtime, own, await reads.tree());
  }
  if (item.kind === 'task') {
    return taskRecipients(runtime, own, reads, item.id);
  }
  const group = item.kind === 'group' ? { kind: item.kind, leader: sessionIdOf(own.roster, item.leader) } : item;
  const ids = groupIds(own.config, group, own.from.id);
  if (!ids.ok) {
    throw new RefusedError(ids.problem);
  }
  return ids.ids.map((id) => ownTeamRecipient(own, id));
}

/** Every recipient the `--to` items name, each once, in the order first named; refused when none is left. */
async function recipientsOf(runtime: CliRuntime, own: SenderTeam, items: readonly ToItem[], to: string, reads: SenderTreeReads): Promise<Recipient[]> {
  const byLabel = new Map<string, Recipient>();
  for (const item of items) {
    for (const recipient of await recipientsOfItem(runtime, own, item, reads)) {
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
 * (`all`, `leads`, `group:<leader>`, `team:<team>`, `tree:leads`, `task:T<n>`) is a broadcast, not work handed past a
 * sub-lead, so it gets none.
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

/** The sender as the `--wake now` / `--wake-by` gate reads it; the teams below its own are read only when a recipient is on another team. */
async function wakeSenderOf(own: SenderTeam, recipients: readonly Recipient[], reads: SenderTreeReads): Promise<WakeSender> {
  const leads = new LeadTree(own.config);
  const below = recipients.some((recipient) => recipient.crossing) ? (await reads.tree()).tree.descendantsOf(own.from.team) : [];
  return { team: own.from.team, id: own.from.id, leader: leads.isLeader(own.from.id), teamLead: leads.lead === own.from.id, below };
}

/**
 * A recipient as the wake gate reads it: whether it leads its team, and whether the sender's team config names it in
 * `roles` (deliveryOwner, securityReviewer hold `<team>/<id>` when the holder sits on a team above).
 */
function wakeTargetOf(own: SenderTeam, recipient: Recipient): WakeTarget {
  const { deliveryOwner, securityReviewer } = own.config.roles;
  const named = recipient.crossing ? formatAddress({ team: recipient.team, id: recipient.id }) : recipient.id;
  return {
    label: recipient.label,
    team: recipient.team,
    teamLead: recipient.config.roles.lead === recipient.id,
    servesSender: [deliveryOwner, securityReviewer].includes(named),
  };
}

/**
 * Posts a wake ask beside each recipient's posted line, so its tab's wake check wakes it, and returns what that
 * prints: a WAKE FAILED line for each ask that could not be posted (its line stays posted), then the WAKES line. A
 * recipient whose team has `wake.enabled` false gets no ask. A `--wake-by` ask carries its time and the hash of the
 * line posted at `now`, so it wakes only while that line is unseen. Each wake's cost runs from the recipient's last
 * write to its latest tabs' transcripts until the wake, as the wake check reckons it.
 */
async function postWakes(runtime: CliRuntime, own: SenderTeam, recipients: readonly Recipient[], text: string, now: number, when: WakeWhen): Promise<string[]> {
  const wPerPct = await readTodayWPerPct(runtime, own.paths, own.config, now);
  const projects = claudeProjectsDir(runtime.env, runtime.userHome);
  const marksByTeam = new Map<string, Promise<readonly InboxMark[]>>();
  const marksOf = (recipient: Recipient): Promise<readonly InboxMark[]> => {
    const read = marksByTeam.get(recipient.team) ?? inboxDepsOf(runtime, recipient.paths).marks.read().then((log) => log.marks);
    marksByTeam.set(recipient.team, read);
    return read;
  };
  const wakeAt = when.kind === 'by' ? when.at : now;
  const failed: string[] = [];
  const off: string[] = [];
  const wakes: ReceiverWake[] = [];
  for (const recipient of recipients) {
    if (!recipient.config.wake.enabled) {
      off.push(recipient.label);
      continue;
    }
    const by = when.kind === 'by' ? { by: { at: when.at, line: lineHash(inboxLineOf(new Date(now), recipient.sender, text)) } } : {};
    try {
      await new WakeAsks(runtime.files, recipient.paths.wakeAsks).post(recipient.id, { from: recipient.sender, text, at: now, ...by });
    } catch (error) {
      failed.push(`WAKE FAILED for ${recipient.label}: ${errorMessage(error)}; its line is posted`);
      continue;
    }
    const last = await lastWriteOf(runtime.transcripts, projects, tabsOf(await marksOf(recipient), recipient.id, RECEIVER_TABS));
    const measured = await readMeasuredTurns(runtime, recipient.paths, recipient.id, recipient.config.sessions, now);
    const cost = wakeCost(last === undefined ? undefined : wakeAt - last, recipient.config.messages.coldAfterMinutes, wPerPct, measured);
    wakes.push({ label: recipient.label, team: recipient.team, batchSeconds: recipient.config.wake.batchSeconds, cost });
  }
  return wakes.length === 0 && off.length === 0 ? failed : [...failed, wakesLine(wakes, off, when)];
}

/** The wake `--wake now` or `--wake-by <time>` asks; undefined with neither. A `--wake-by` time not after now is refused. */
function wakeWhenOf(wake: string | undefined, wakeBy: string | undefined, now: number, zone: TimeZone): WakeWhen | undefined {
  if (wakeBy === undefined) {
    return wake === undefined ? undefined : WAKE_AT_ONCE;
  }
  const at = instantOf('--wake-by', wakeBy, { nowMs: now, zone });
  if (at <= now) {
    throw new UsageError(`--wake-by "${wakeBy}" is past (${zone.shortMinute(new Date(at))}); --wake now wakes each receiver at once`);
  }
  return wakeByOf(at, now, zone);
}

const TO_FORMS = 'a session id or name, <team>/<id>, all, leads, group:<leader>, team:<team>, tree:leads, task:T<n>, or a comma-separated list of them';

/**
 * `inbox add --to <to> --text "<line>" [--wake now]`: appends one dated line to each receiver's inbox, all of them
 * or, when one is refused, none. A bare id or name is on the sender's team; `<team>/<id>` reaches any session of
 * another team of its tree, and that line names the sender `<team>/<id>`. `all`, `leads` and `group:<leader>` are
 * groups of the sender's team, `team:<team>` (every session of a team of its tree), `tree:leads` (every team's lead
 * of its tree) and `task:T<n>` (the owner of that task and of each active task of its tree whose ref is T<n>, T1151)
 * groups of its tree; a group leaves the sender out, and a comma-separated list names each receiver once.
 * A line to a session named on the sender's team that skips a sub-lead below the sender is posted, then a further line
 * tells the sender to route such work via that sub-lead (T783). `--wake now` (T1147) also wakes each receiver idle at
 * its prompt within about 3 minutes (`wake.batchSeconds`), and says what that costs; `--wake-by <time>` (T1148) wakes
 * it at that time instead, and only if it has not seen the line by then. A group is woken only by a leader, another
 * team only by a team lead (a team below its own, any team's lead, a role holder its config names), else nothing is
 * posted.
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
  const wake = args.flags.get('wake');
  if (wake !== undefined && wake !== WAKE_NOW) {
    throw new UsageError(`--wake takes ${WAKE_NOW}, to wake each receiver as soon as its tab's wake check may, not "${wake}"`);
  }
  const wakeBy = args.flags.get('wake-by');
  if (wake !== undefined && wakeBy !== undefined) {
    throw new UsageError(`--wake ${WAKE_NOW} and --wake-by are one or the other: --wake ${WAKE_NOW} wakes each receiver at once, --wake-by at a time`);
  }
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'write');
  const now = runtime.clock.now();
  const when = wakeWhenOf(wake, wakeBy, now, teamZone(config, runtime));
  const roster = await rosterOf(runtime, kit, config);
  const own: SenderTeam = { from: { team, id: sessionIdOf(roster, caller) }, paths: kit.paths, config, roster };
  const reads = new SenderTreeReads(runtime, team);
  const recipients = await recipientsOf(runtime, own, items, to, reads);
  if (when !== undefined) {
    const refusal = wakeRefusal(
      await wakeSenderOf(own, recipients, reads),
      items.some((item) => item.kind !== 'session'),
      recipients.map((recipient) => wakeTargetOf(own, recipient)),
      when,
    );
    if (refusal !== undefined) {
      throw new RefusedError(refusal);
    }
  }
  const secrets = new SecretScanner([
    ...config.register.secretPatterns,
    ...recipients.filter((recipient) => recipient.crossing).flatMap((recipient) => recipient.config.register.secretPatterns),
  ]);
  const targets = recipients.map((recipient) => ({ inboxes: inboxDepsOf(runtime, recipient.paths).inboxes, to: recipient.id, from: recipient.sender }));
  const problem = await postLines(targets, secrets, { text, now: new Date(now) });
  if (problem !== undefined) {
    throw new RefusedError(problem);
  }
  runtime.out.stdout(postedLine(recipients));
  if (when !== undefined) {
    for (const line of await postWakes(runtime, own, recipients, text.trim(), now, when)) {
      runtime.out.stdout(line);
    }
  }
  for (const reminder of routeRemindersOf(own, items, text)) {
    runtime.out.stdout(reminder);
  }
  return EXIT.ok;
}
