import type { KitConfig } from '../../config/types.ts';
import { formatAddress, splitAddress, type SessionAddress } from '../../core/address.ts';
import { ENV, type Env, type TeamPaths } from '../../core/home.ts';
import { NAME_RULE } from '../../core/ids.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { formatRead, formatUnread, inboxStatus, postLine, readInbox, type InboxDeps } from '../../inbox/inbox.ts';
import { CLAUDE_SESSION_ID } from '../../inbox/marks.ts';
import { reachOf } from '../../inbox/reach.ts';
import { InboxDir, JsonlMarkLog } from '../../inbox/store.ts';
import { noPositionals, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf, sessionRef } from '../inputs.ts';
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';

export function inboxDepsOf(runtime: CliRuntime, paths: TeamPaths): InboxDeps {
  return { inboxes: new InboxDir(runtime.files, paths.inbox), marks: new JsonlMarkLog(runtime.files, paths.inboxMarks) };
}

/** The Claude Code session running the command, so the reminder hook can follow it; null outside one. */
function claudeSessionOf(env: Env): string | null {
  const id = env[ENV.claudeSession];
  return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}

/** `inbox read`: prints the caller's unread lines and marks them read. */
export async function read(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const area = sessionIdOf(await rosterOf(runtime, kit, requireConfig(kit, runtime, 'read')), caller);
  const now = new Date(runtime.clock.now());
  const result = await readInbox(inboxDepsOf(runtime, kit.paths), { area, claudeSession: claudeSessionOf(runtime.env), now });
  result.unread.lines.forEach((line) => runtime.out.stdout(line));
  runtime.out.stdout(formatRead(result));
  return EXIT.ok;
}

/** `inbox status`: unread counts per area, marking nothing. */
export async function status(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const only = args.flags.get('session');
  const ref = only === undefined ? undefined : sessionRef('--session', only);
  const kit = await openTeamKit(runtime);
  const roster = await rosterOf(runtime, kit, requireConfig(kit, runtime, 'read'));
  const area = ref === undefined ? undefined : pastOrPresentIdOf(roster, ref);
  const unread = await inboxStatus(inboxDepsOf(runtime, kit.paths), area);
  if (unread.length === 0) {
    runtime.out.stdout(`INBOX no inbox ${area === undefined ? 'files' : `for ${area}`} in ${kit.paths.inbox}`);
  }
  unread.forEach((item) => runtime.out.stdout(formatUnread(item)));
  return EXIT.ok;
}

/** Where a line goes: the recipient's team folder and config, its id, and how the line and the reply name it. */
interface Recipient {
  readonly paths: TeamPaths;
  readonly config: KitConfig;
  readonly id: string;
  /** `<id>` on the sender's own team, `<team>/<id>` on another. */
  readonly label: string;
}

function ownTeamRecipient(paths: TeamPaths, config: KitConfig, id: string): Recipient {
  return { paths, config, id, label: id };
}

/**
 * A session of another team of the sender's tree, when the sender may write to it: a member only to
 * its own team, a lead also to its parent team's lead and its child teams' leads.
 */
async function recipientInTree(runtime: CliRuntime, from: SessionAddress, team: string, session: string): Promise<Recipient> {
  const { tree, teams } = await loadTree(runtime);
  const target = teams.get(team);
  if (target === undefined) {
    throw new RefusedError(`no team ${team} with a config in this kit home`);
  }
  const to = { team, id: sessionIdOf(target.roster, session) };
  const reach = reachOf(tree, from, to);
  if (!reach.ok) {
    throw new RefusedError(reach.problem);
  }
  const kit = await openKit(runtime, team);
  return { paths: kit.paths, config: requireConfig(kit, runtime, 'write'), id: to.id, label: formatAddress(to) };
}

/**
 * `inbox add --to <id|name|team/id> --text "<line>"`: appends one dated line to a session's inbox. A
 * bare id or name is on the sender's team; `<team>/<id>` reaches another team of its tree, as far as
 * the sender's place allows, and the line names the sender `<team>/<id>`.
 */
export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const address = splitAddress(requiredFlag(args.flags, 'to'));
  if (address === undefined) {
    throw new UsageError(`--to "${args.flags.get('to') ?? ''}" is not a session id or name, or <team>/<id> (${NAME_RULE})`);
  }
  const text = requiredFlag(args.flags, 'text');
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'write');
  const roster = await rosterOf(runtime, kit, config);
  const from = sessionIdOf(roster, caller);
  const crossing = address.team !== undefined && address.team !== team;
  const recipient: Recipient = crossing
    ? await recipientInTree(runtime, { team, id: from }, address.team, address.session)
    : ownTeamRecipient(kit.paths, config, sessionIdOf(roster, address.session));
  const { inboxes } = inboxDepsOf(runtime, recipient.paths);
  const now = new Date(runtime.clock.now());
  const secrets = new SecretScanner([...config.register.secretPatterns, ...(crossing ? recipient.config.register.secretPatterns : [])]);
  const sender = crossing ? formatAddress({ team, id: from }) : from;
  const problem = await postLine(inboxes, secrets, { to: recipient.id, from: sender, text, now });
  if (problem !== undefined) {
    throw new RefusedError(problem);
  }
  runtime.out.stdout(`POSTED to ${recipient.label}; ${recipient.label} is reminded at its next prompt`);
  return EXIT.ok;
}
