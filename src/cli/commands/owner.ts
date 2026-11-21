import { formatAddress } from '../../core/address.ts';
import { ENV, KIT_NAME } from '../../core/home.ts';
import { isCardDigest } from '../../register/card-digest.ts';
import type { Task } from '../../register/fold.ts';
import { ownerAnswerWords, type OwnerAnswer } from '../../register/policy.ts';
import type { OwnerNextPreview } from '../../register/register.ts';
import { weekdayText } from '../../register/waits.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { underClaudeCode } from '../claude-code-env.ts';
import { deadlineOf, taskRefOf } from '../inputs.ts';
import { findTeam, openKit, type Access, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { postUrgentLine } from '../urgent-line.ts';
import { report } from './register.ts';
import { teamOf, tellLine, type Team } from './register-team.ts';

/** How an owner action's lines name a task and a session of the team that holds the task. */
export interface Names {
  readonly task: (id: string) => string;
  readonly session: (id: string) => string;
}

/** `T12` and `alpha` in the caller's own team; `web/T12` and `web/alpha` in team `web` (`label`). */
export function namesOf(label: string | undefined): Names {
  return label === undefined
    ? { task: (id) => id, session: (id) => id }
    : { task: (id) => `${label}/${id}`, session: (id) => formatAddress({ team: label, id }) };
}

/** The pane button that runs each owner action. */
const BUTTON = { note: 'Note', next: 'Next', wake: 'Wake', decide: 'Decide', later: 'Later' } as const;

/**
 * Refuses an owner action (note, next, wake, decide, later) where Claude Code set CLAUDECODE: an agent's tool call, a script one
 * runs, a hook command (T1780). The exec guard reads only the tool call's own line, so a script the agent writes slips past it; this
 * refusal holds there too. The pane's buttons and a typed `/teamrig owner ..` run through the plugin's mod with Claude
 * Code's own environment, which lacks the variable, so the owner's routes still write. A script that unsets it still
 * passes: every session runs as the same OS user as the owner.
 */
export function refuseUnderClaudeCode(runtime: CliRuntime, command: keyof typeof BUTTON): void {
  if (underClaudeCode(runtime)) {
    throw new RefusedError(
      `${KIT_NAME} owner ${command} acts as the owner, so it is refused where Claude Code runs it (${ENV.claudeCode} is set: an agent's tool call, a script it runs or a hook); the owner presses ${BUTTON[command]} in the pane or types /${KIT_NAME} owner ${command} in a tab`,
    );
  }
}

/** The register an owner action writes: the team that holds the task, its kit for wake asks, and how its lines name things. */
interface OwnerTarget {
  readonly kit: Kit;
  readonly team: Team;
  readonly id: string;
  /** The other team's id when the task is written `<team>/T<id>`; undefined for a task of the caller's own team. */
  readonly label: string | undefined;
  readonly names: Names;
}

/** The team holding the task `text` names: the caller's own for `T12`, another team of the tree for `web/T12`. */
async function targetOf(runtime: CliRuntime, text: string, access: Access): Promise<OwnerTarget> {
  const ref = taskRefOf(text);
  const { team: own } = await findTeam(runtime);
  const held = ref.team ?? own;
  const kit = await openKit(runtime, held);
  const label = held === own ? undefined : held;
  return { kit, team: await teamOf(runtime, kit, access), id: ref.id, label, names: namesOf(label) };
}

/**
 * Posts `text` from the owner to `to` with a wake ask, so its idle tab wakes with the line quoted. A line that cannot
 * be posted or woken is named on stderr, never thrown: the register write it follows stands.
 */
async function wakeLine(runtime: CliRuntime, target: OwnerTarget, to: string, text: string): Promise<void> {
  const { config } = target.team;
  const shown = target.names.session(to);
  const problem = await postUrgentLine(runtime, target.kit, config, { to, from: config.register.ownerSource, text });
  runtime.out.stderr(problem === undefined ? `NOTE ${shown} has an inbox line that wakes its idle tab: ${text}` : `WARN ${shown} was not woken: ${problem}`);
}

/** The line the task's session gets with the owner's Note. */
export function ownerNoteLine(owner: string, task: string, note: string): string {
  return `${owner}'s Note on ${task}: ${note}`;
}

/** The line that wakes the task's session to start it next. */
export function ownerNextLine(owner: string, task: string): string {
  return `${owner} put ${task} next: it is pinned above your other tasks; start it once the step in hand is done`;
}

/** The lead's line, posted without a wake, naming whose list the task tops now. */
export function ownerNextLeadLine(owner: string, task: Pick<Task, 'id' | 'owner' | 'title'>, names: Names): string {
  return `${owner} put ${names.task(task.id)} next on ${names.session(task.owner)}'s list: ${task.title}`;
}

/** The one line `owner next --preview` prints: where the task goes, the pin it moves down, who hears of it. */
export function ownerNextPreviewLine(owner: string, lead: string, { task, moves }: OwnerNextPreview, names: Names): string {
  const session = names.session(task.owner);
  const pins = moves.map((pinned) => names.task(pinned.id)).join(', ');
  const moved = moves.length === 0 ? '' : moves.length === 1 ? ` (the earlier pin on ${pins} moves down)` : ` (the earlier pins on ${pins} move down)`;
  const told = lead === task.owner ? '' : `, the lead (${names.session(lead)}) is told`;
  return `PREVIEW ${owner} next ${names.task(task.id)}: goes to the top of ${session}'s list${moved}, ${session} is woken${told}; nothing written`;
}

/**
 * `owner note <[team/]T<id>> --text ".."`: the owner's free text on a task, pressed in the pane (T1298). It is kept in
 * the task's history as the owner's (register.ownerSource), never as a session's, and sent to the task's session as an
 * inbox line that wakes it only while the task is in progress. Refused on a done or dropped task, and under CLAUDECODE.
 */
export async function ownerNote(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  refuseUnderClaudeCode(runtime, 'note');
  const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), 'write');
  const { team, names } = target;
  const owner = team.config.register.ownerSource;
  const note = args.flags.get('text');
  const written = await team.register.ownerNote(target.id, note);
  const code = report(runtime, written, 'NOTED', team, target.label);
  if (written.ok) {
    const { task } = written.value;
    const text = ownerNoteLine(owner, names.task(task.id), note?.trim() ?? '');
    if (task.status === 'in-progress') {
      await wakeLine(runtime, target, task.owner, text);
    } else {
      const shown = names.session(task.owner);
      await tellLine(runtime, team, owner, task.owner, text, `${shown} was not told of ${owner}'s Note`, shown);
    }
  }
  return code;
}

/**
 * `owner next <[team/]T<id>> [--preview]`: the owner puts a task next, pressed in the pane (T1298). It pins the task
 * above every other task on its session's list (moving that session's earlier pin), wakes the session to start it once
 * the step in hand is done, and tells the team's lead without a wake. `--preview` prints what it would do and writes
 * nothing, for the pane's confirm step. Refused on a done, dropped or in-progress task, or one the owner put next already,
 * and, but for `--preview`, under CLAUDECODE.
 */
export async function ownerNext(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const preview = args.switches.has('preview');
  if (!preview) {
    refuseUnderClaudeCode(runtime, 'next');
  }
  const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), preview ? 'read' : 'write');
  const { team, names } = target;
  const owner = team.config.register.ownerSource;
  const lead = team.config.roles.lead;
  if (preview) {
    const seen = await team.register.ownerNextPreview(target.id);
    if (!seen.ok) {
      throw new RefusedError(seen.error);
    }
    runtime.out.stdout(ownerNextPreviewLine(owner, lead, seen.value, names));
    return EXIT.ok;
  }
  const written = await team.register.ownerNext(target.id);
  const code = report(runtime, written, 'NEXT', team, target.label);
  if (written.ok) {
    const { task } = written.value;
    await wakeLine(runtime, target, task.owner, ownerNextLine(owner, names.task(task.id)));
    if (lead !== task.owner) {
      const shownLead = names.session(lead);
      await tellLine(runtime, team, owner, lead, ownerNextLeadLine(owner, task, names), `${shownLead} was not told ${owner} put ${names.task(task.id)} next`, shownLead);
    }
  }
  return code;
}

/** The line that wakes the task's session with the owner's answer to its card. */
export function ownerDecideLine(owner: string, task: string, words: string): string {
  return `${owner} decided ${task}: ${words}; the wait on ${owner} is gone, so go on as decided`;
}

/** The line the task's session gets, without a wake, when the owner puts its card off. */
export function ownerLaterLine(owner: string, task: string, until: string): string {
  return `${owner} put off the card on ${task} until ${until}; it comes back to ${owner} then`;
}

/** The answer `owner decide` was given: exactly one of --option <n>, --approve and --decline. */
function ownerAnswerOf(args: ParsedArgs): OwnerAnswer {
  const option = args.flags.get('option');
  const given = [option !== undefined, args.switches.has('approve'), args.switches.has('decline')].filter(Boolean).length;
  if (given !== 1) {
    throw new UsageError('owner decide takes exactly one answer: --option <n>, --approve or --decline');
  }
  if (option !== undefined) {
    if (!/^\d+$/.test(option)) {
      throw new UsageError(`--option takes the number of one of the card's options, not "${option}"`);
    }
    return { kind: 'option', option: Number(option) };
  }
  return { kind: args.switches.has('approve') ? 'approve' : 'decline' };
}

/** The card digest `owner decide --read` was given (cardDigest), if any. */
function readDigestOf(args: ParsedArgs): string | undefined {
  const read = args.flags.get('read');
  if (read !== undefined && !isCardDigest(read)) {
    throw new UsageError(`--read takes the digest of the card that was read, 64 hex characters (cardDigest in teamrig's read entry), not "${read}"`);
  }
  return read;
}

/**
 * `owner decide <[team/]T<id>> --option <n>|--approve|--decline [--read <digest>] [--note ".."]`: the owner answers a card from the
 * pane's Decisions tab (#1517). Written as the owner (register.ownerSource), as a Decided (`update --decided`): the
 * task's wait on the owner goes and it is marked decided, its note saying what was chosen and the owner's own words.
 * The session gets an inbox line that wakes it to go on. Refused on a task not waiting on the owner, an option its
 * card lacks, an approval's answer on a task with no approval wait of the owner's, a `--read` digest the card no
 * longer has, a security-related card without its current verdict, and under CLAUDECODE.
 */
export async function ownerDecide(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  refuseUnderClaudeCode(runtime, 'decide');
  const answer = ownerAnswerOf(args);
  const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), 'write');
  const { team, names } = target;
  const owner = team.config.register.ownerSource;
  const note = args.flags.get('note');
  const written = await team.register.ownerDecide(target.id, answer, note, readDigestOf(args));
  const code = report(runtime, written, 'DECIDED', team, target.label);
  if (written.ok) {
    const { task } = written.value;
    const own = note?.trim() ?? '';
    const words = ownerAnswerWords(answer, task.card);
    await wakeLine(runtime, target, task.owner, ownerDecideLine(owner, names.task(task.id), own === '' ? words : `${words}; ${own}`));
  }
  return code;
}

/**
 * `owner later <[team/]T<id>> --until <time> [--note ".."]`: the owner puts a card off from the pane's Decisions tab
 * (#1517). Written as the owner, as a Later (`update --later`): a time wait beside the wait on the owner, so the card
 * comes back then. The session gets an inbox line without a wake, as it has nothing to do until then. Refused on a
 * task not waiting on the owner, a time gone by, and under CLAUDECODE.
 */
export async function ownerLater(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  refuseUnderClaudeCode(runtime, 'later');
  const typed = requiredFlag(args.flags, 'until');
  const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), 'write');
  const { team, names } = target;
  const owner = team.config.register.ownerSource;
  const until = deadlineOf('--until', typed, { nowMs: runtime.clock.now(), zone: team.zone });
  const written = await team.register.ownerDefer(target.id, until, args.flags.get('note'));
  const code = report(runtime, written, 'LATER', team, target.label);
  if (written.ok) {
    const { task } = written.value;
    const shown = names.session(task.owner);
    const text = ownerLaterLine(owner, names.task(task.id), weekdayText(until, team.zone));
    await tellLine(runtime, team, owner, task.owner, text, `${shown} was not told ${owner} put off the card on ${names.task(task.id)}`, shown);
  }
  return code;
}
