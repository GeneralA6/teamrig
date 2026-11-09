import { resolve } from 'node:path';
import { formatAddress } from '../../core/address.ts';
import { sha256Hex, type AuditPin } from '../../register/hand-step.ts';
import type { Verdict } from '../../register/policy.ts';
import type { WriteResult } from '../../register/register.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf, taskIdOf } from '../inputs.ts';
import { findTeam, openKit, sessionIdOf } from '../kit.ts';
import { RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { report } from './register.ts';
import { openTeam, teamOf, tellLine, type Team } from './register-team.ts';
import { treeCallerOf } from './team-ask.ts';

/** How many characters of a pin's sha256 the lines about it show, as the card's run line does (T2312). */
const SHORT_SHA256 = 8;

/** The pin of the hand step file `--file` names, read from the caller's folder: its absolute path and the sha256 of its bytes. */
async function pinOf(args: ParsedArgs, runtime: CliRuntime): Promise<AuditPin> {
  const path = resolve(runtime.cwd, requiredFlag(args.flags, 'file'));
  const bytes = await runtime.fileBytes.read(path);
  if (bytes === undefined) {
    throw new RefusedError(`no file ${path}`);
  }
  return { path, sha256: sha256Hex(bytes) };
}

/** The line the task's owner reads: who audited which file at which sha256, and that an edit to it needs a new audit. */
function auditedNotice(by: string, id: string, pin: AuditPin): string {
  return `${by} audited the hand step ${pin.path} for ${id} at sha256 ${pin.sha256.slice(0, SHORT_SHA256)}; an edit to it needs a new audit (core rule 11)`;
}

/**
 * Prints the written audit and tells the task's owner from `by`, the auditor as the owner's inbox names it (tellLine
 * names that line, with the pin, on stderr); `label` names another team's register, whose ids then read `<label>/T12`
 * and `<label>/<owner>`.
 */
async function reportAudit(runtime: CliRuntime, written: Verdict<WriteResult>, team: Team, by: string, pin: AuditPin, label?: string): Promise<ExitCode> {
  const code = report(runtime, written, 'AUDITED', team, label);
  if (!written.ok) {
    return code;
  }
  const { task } = written.value;
  const id = label === undefined ? task.id : `${label}/${task.id}`;
  if (task.owner !== by) {
    const shown = label === undefined ? task.owner : formatAddress({ team: label, id: task.owner });
    await tellLine(runtime, team, by, task.owner, auditedNotice(by, id, pin), `${shown} was not told of the audit on ${id}`, shown);
  }
  return code;
}

/**
 * `audit T<n> --file <path> [--team <child>]`: an auditor of a team below audits one of its tasks' hand steps (T2312).
 * The caller's team must sit above `child` in the tree; the audit lands in `child`'s register as an event by the
 * caller's `<team>/<id>`, the form `child`'s roles.securityReviewer names a reviewer above it by, and its policy judges it.
 */
async function auditBelow(runtime: CliRuntime, caller: string, child: string, id: string, pin: AuditPin, note: string | undefined): Promise<ExitCode> {
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
  return reportAudit(runtime, await target.register.auditFrom(from, id, pin, note), target, from, pin, child);
}

/**
 * `audit T<n> --file <path> [--note ".."] [--team <child>]` (T2312, core rule 11): the security reviewer read a hand
 * step file for the task's owner to hand the human, and pins it at the sha256 of its bytes now, so a card may carry
 * it. The policy names who may (never the task's own owner) and the file kinds with a run line; a missing file is
 * refused here. The owner gets one inbox line naming the pin.
 */
export async function audit(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const note = args.flags.get('note');
  const child = args.flags.get('team');
  const pin = await pinOf(args, runtime);
  if (child !== undefined) {
    return auditBelow(runtime, caller, child, id, pin, note);
  }
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  return reportAudit(runtime, await team.register.audit(by, id, pin, note), team, by, pin);
}
