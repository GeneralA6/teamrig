import { Roster } from '../../config/roster.ts';
import { KIT_NAME } from '../../core/home.ts';
import { doctorFindings, formatFinding } from '../../doctor/doctor.ts';
import { inboxStatus } from '../../inbox/inbox.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * `doctor`: the team's health checks (names, the rename log, inboxes, rules.md). It reads only and
 * exits 0 like `check`: a finding is advice, and each line says the fix.
 */
export async function doctor(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { paths } = kit;
  const renameLog = await new JsonlRenameLog(runtime.files, paths.renames).read();
  const rules = await runtime.files.read(paths.teamRules);
  const findings = doctorFindings({
    roster: new Roster(config, paths.team, renameLog.renames),
    configNames: config.names,
    renameLog: { ...renameLog, path: paths.renames },
    inboxes: await inboxStatus(inboxDepsOf(runtime, paths)),
    teamRules: rules === undefined ? undefined : { path: paths.teamRules, chars: rules.trim().length },
    now: new Date(runtime.clock.now()),
    command: KIT_NAME,
  });
  runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
  findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
  return EXIT.ok;
}
