import { formatAddress } from '../../core/address.ts';
import { ENV, KIT_NAME } from '../../core/home.ts';
import { LATER_FORMS, MAX_LATER_HOURS, namedLaterTime } from '../../core/later-time.ts';
import { storedDeadline, storedText, typedTimeHint } from '../../core/time.ts';
import type { Task } from '../../register/fold.ts';
import type { OwnerAnswer } from '../../register/policy.ts';
import type { OwnerNextPreview } from '../../register/register.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { underClaudeCode } from '../claude-code-env.ts';
import { taskRefOf, type TypedTimes } from '../inputs.ts';
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
const BUTTON = { note: 'Note', next: 'Next', wake: 'Wake', decide: 'an option, Approve or Decline', later: 'Later' } as const;

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

/** The line that wakes the task's session with the owner's answer to its card. */
export function ownerDecideLine(owner: string, task: string, answer: string): string {
  return `${owner} answered your card on ${task}: ${answer}; it waits on ${owner} no more, so go on from the answer`;
}

/** The line, with no wake, that tells the task's session the owner put its card off. */
export function ownerLaterLine(owner: string, task: string, until: string): string {
  return `${owner} put off your card on ${task} until ${until}: it comes back to ${owner} then, and waits on ${owner} until answered`;
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

/** An option's number as typed: digits only. */
const OPTION_NUMBER = /^\d+$/;

/** `--option <n>`, `--approve` or `--decline`: the owner's one answer to a card. */
function answerOf(args: ParsedArgs): OwnerAnswer {
  const option = args.flags.get('option');
  const approve = args.switches.has('approve');
  const decline = args.switches.has('decline');
  if ([option !== undefined, approve, decline].filter((given) => given).length !== 1) {
    throw new UsageError('owner decide takes one answer: --option <n>, --approve or --decline');
  }
  if (option !== undefined) {
    const number = option.trim();
    if (!OPTION_NUMBER.test(number)) {
      throw new UsageError(`--option "${option}" is not an option's number, like 2`);
    }
    return { kind: 'option', option: Number(number) };
  }
  return approve ? { kind: 'approve' } : { kind: 'decline' };
}

/** `--until in-1h|tomorrow|monday|<time>`: when a card put off comes back, in the stored form of a deadline. */
function untilOf(text: string, times: TypedTimes): string {
  const until = namedLaterTime(text, times.nowMs, times.zone) ?? storedDeadline(text, times.nowMs, times.zone);
  if (until === undefined) {
    throw new UsageError(`--until "${text}" is not ${LATER_FORMS} (n from 1 to ${MAX_LATER_HOURS}) or a time: ${typedTimeHint(times.zone, times.nowMs)}`);
  }
  return until;
}

/**
 * `owner decide <[team/]T<id>> --option <n>|--approve|--decline`: the owner answers a card from the pane's Decisions tab
 * (T4078). It is kept in the task's history as the owner's Decided, naming the option chosen or yes or no, which drops
 * the task's waits on the owner, and wakes the task's session to go on from it. Refused on a task that waits on no
 * decision or approval of the owner, on an option the card lacks, on yes or no to a decision or an option to an
 * approval, and under CLAUDECODE.
 */
export async function ownerDecide(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  refuseUnderClaudeCode(runtime, 'decide');
  const answer = answerOf(args);
  const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), 'write');
  const { team, names } = target;
  const written = await team.register.ownerDecide(target.id, answer);
  const code = report(runtime, written, 'DECIDED', team, target.label);
  if (written.ok) {
    const { task } = written.value;
    const owner = team.config.register.ownerSource;
    await wakeLine(runtime, target, task.owner, ownerDecideLine(owner, names.task(task.id), task.decided?.note ?? ''));
  }
  return code;
}

/**
 * `owner later <[team/]T<id>> --until in-<n>h|tomorrow|monday|<time>`: the owner puts a card off from the pane's
 * Decisions tab (T4078), to n hours from now, 09:00 on the team's clock tomorrow or next Monday, or a typed time. It
 * is kept in the task's history as the owner's Later, and the task's session is told without a wake, as nothing waits
 * on it to act. Refused on a task that waits on no decision or approval of the owner, on a time gone by, and under
 * CLAUDECODE.
 */
export async function ownerLater(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  refuseUnderClaudeCode(runtime, 'later');
  const text = requiredFlag(args.flags, 'until');
  const target = await targetOf(runtime, onePositional(args, '[team/]T<id>'), 'write');
  const { team, names } = target;
  const until = untilOf(text, { nowMs: runtime.clock.now(), zone: team.zone });
  const written = await team.register.ownerLater(target.id, until);
  const code = report(runtime, written, 'LATER', team, target.label);
  if (written.ok) {
    const { task } = written.value;
    const owner = team.config.register.ownerSource;
    const shown = names.session(task.owner);
    const line = ownerLaterLine(owner, names.task(task.id), storedText(until, team.zone));
    await tellLine(runtime, team, owner, task.owner, line, `${shown} was not told ${owner} put off ${names.task(task.id)}`, shown);
  }
  return code;
}
