import { formatAddress } from '../../core/address.ts';
import { shortSha256 } from '../../register/hand-step.ts';
import type { AuditSubject, Verdict } from '../../register/policy.ts';
import type { WriteResult } from '../../register/register.ts';
import { onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { handStepPin } from '../hand-step-file.ts';
import { callerOf, taskIdOf } from '../inputs.ts';
import { findTeam, openKit, sessionIdOf } from '../kit.ts';
import { RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { report } from './register.ts';
import { openTeam, teamOf, tellLine, type Team } from './register-team.ts';
import { treeCallerOf } from './team-ask.ts';

/**
 * The line the task's owner reads: who audited which file at which sha256, and that an edit to it needs a new audit;
 * or who gave which security verdict on the card, and that an edit to what the card asks needs a new one.
 */
function auditedNotice(by: string, id: string, subject: AuditSubject): string {
  if (subject.kind === 'file') {
    return `${by} audited the hand step ${subject.pin.path} for ${id} at sha256 ${shortSha256(subject.pin.sha256)}; an edit to it needs a new audit (core rule 11)`;
  }
  return `${by} gave the security verdict on ${id}'s card: ${subject.text.trim()}; an edit to its question, options or recommendation needs a new verdict (core rule 9)`;
}

/**
 * Prints the written audit and tells the task's owner from `by`, the auditor as the owner's inbox names it (tellLine
 * names that line, with the pin, on stderr); `label` names another team's register, whose ids then read `<label>/T12`
 * and `<label>/<owner>`.
 */
async function reportAudit(runtime: CliRuntime, written: Verdict<WriteResult>, team: Team, by: string, subject: AuditSubject, label?: string): Promise<ExitCode> {
  const code = report(runtime, written, 'AUDITED', team, label);
  if (!written.ok) {
    return code;
  }
  const { task } = written.value;
  const id = label === undefined ? task.id : `${label}/${task.id}`;
  if (task.owner !== by) {
    const shown = label === undefined ? task.owner : formatAddress({ team: label, id: task.owner });
    await tellLine(runtime, team, by, task.owner, auditedNotice(by, id, subject), `${shown} was not told of the audit on ${id}`, shown);
  }
  return code;
}

/**
 * `audit T<n> --file <path>|--verdict ".." [--team <child>]`: an auditor of a team below audits one of its tasks'
 * hand steps (T2312) or cards (T2761). The caller's team must sit above `child` in the tree; the audit lands in
 * `child`'s register as an event by the caller's `<team>/<id>`, the form `child`'s roles.securityReviewer names a
 * reviewer above it by, and its policy judges it.
 */
async function auditBelow(runtime: CliRuntime, caller: string, child: string, id: string, subject: AuditSubject, note: string | undefined): Promise<ExitCode> {
  const { team } = await findTeam(runtime);
  if (team === child) {
    throw new UsageError(`--team ${child} is your own team: audit ${id} without --team`);
  }
  const { from: address, tree } = await treeCallerOf(runtime, team, caller, child);
  if (!tree.ancestorsOf(child).includes(team)) {
    throw new RefusedError(`team ${child} is not below team ${team}: --team names a team below yours`);
  }
  const from = formatAddress(address);
  const target = await teamOf(runtime, await openKit(runtime, child), 'write');
  return reportAudit(runtime, await target.register.auditFrom(from, id, subject, note), target, from, subject, child);
}

/** What the audit reads: `--file`, a hand step file read and hashed now, or `--verdict`, the reviewer's verdict on the task's card; one of them. */
async function subjectOf(args: ParsedArgs, runtime: CliRuntime): Promise<AuditSubject> {
  const file = args.flags.get('file');
  const verdict = args.flags.get('verdict');
  if ((file === undefined) === (verdict === undefined)) {
    throw new UsageError('audit takes one of --file <the hand step file> or --verdict "<the security verdict on the task\'s card>"');
  }
  return file === undefined ? { kind: 'verdict', text: verdict ?? '' } : { kind: 'file', pin: await handStepPin(runtime, 'file', file) };
}

/**
 * `audit T<n> --file <path>|--verdict ".." [--note ".."] [--team <child>]`: the security reviewer read a hand step
 * file for the task's owner to hand the human, and pins it at the sha256 of its bytes now, so a card may carry it
 * (T2312, core rule 11); or read the task's card and gives its verdict on it, pinned with the card parts read, so a
 * security-related card may reach the owner (T2761, core rule 9). The policy names who may (never the task's own
 * owner); a missing file is refused here. The owner gets one inbox line naming the pin.
 */
export async function audit(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const note = args.flags.get('note');
  const child = args.flags.get('team');
  const subject = await subjectOf(args, runtime);
  if (child !== undefined) {
    return auditBelow(runtime, caller, child, id, subject, note);
  }
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  return reportAudit(runtime, await team.register.audit(by, id, subject, note), team, by, subject);
}
