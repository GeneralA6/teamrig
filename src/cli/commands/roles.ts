import { describeRole, granted, revoked, type RoleHolder, type ServiceRoles } from '../../config/service-role-edits.ts';
import type { JsonRecord } from '../../core/guards.ts';
import { isServiceCommand, SERVICE_COMMANDS, type ServiceCommand } from '../../permissions/service-commands.ts';
import type { Checked } from '../../setup/team-create.ts';
import { noPositionals, onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { listOf } from '../inputs.ts';
import { checkedNextConfig, configFileJson, configLockOf, openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `roles grant`, `roles revoke` and `roles list` (T2984): the team's service roles, each the teamrig commands for an
 * outside service its holders may run past every permission check from their own tab. A grant is a permission change,
 * an owner gate: teamrig's guard asks the owner before a session's call of grant or revoke whatever `--yes` says, so
 * the owner runs them, from their own terminal or prompt. Without --yes each only shows the change; with it the old
 * config is kept in the backups folder and `serviceRoles` is rewritten, read again by the next call.
 */

/** The backup names of a config before `roles grant` or `roles revoke` changed it. */
export const GRANT_BACKUP_NAME = 'config.roles-grant';
export const REVOKE_BACKUP_NAME = 'config.roles-revoke';

/** The file with `serviceRoles` replaced, or gone once no role is left. */
function withRoles(file: JsonRecord, roles: ServiceRoles): JsonRecord {
  const rest = Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'serviceRoles'));
  return Object.keys(roles).length === 0 ? rest : { ...rest, serviceRoles: roles };
}

/** `--commands a,b`: names from the table, else a usage error naming them all. */
function commandsOf(text: string | undefined): ServiceCommand[] {
  if (text === undefined) {
    return [];
  }
  return listOf('--commands', text).map((name) => {
    if (!isServiceCommand(name)) {
      throw new UsageError(`--commands: "${name}" is no command a service role may hold; one of: ${SERVICE_COMMANDS.join(', ')}`);
    }
    return name;
  });
}

/** One change of `serviceRoles`, planned on the file as it is under the config lock. */
interface RolesChange {
  readonly verb: 'grant' | 'revoke';
  readonly backupName: string;
  plan(roles: ServiceRoles): Checked<ServiceRoles>;
}

async function changeRoles(args: ParsedArgs, runtime: CliRuntime, name: string, change: RolesChange): Promise<ExitCode> {
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  return configLockOf(runtime, kit, config).run(async (writer) => {
    const file = await configFileJson(runtime, kit.load.path);
    const current = checkedNextConfig(file);
    const planned = change.plan(current.serviceRoles);
    if (!planned.ok) {
      throw new RefusedError(planned.problem);
    }
    const next = withRoles(file, planned.value);
    checkedNextConfig(next);
    const what = describeRole(name, planned.value[name]);
    if (!args.switches.has('yes')) {
      runtime.out.stdout(`PREVIEW roles ${change.verb} ${what}; nothing written (add --yes to write)`);
      return EXIT.ok;
    }
    const backup = await writer.write(next, change.backupName);
    runtime.out.stdout(`${change.verb === 'grant' ? 'GRANTED' : 'REVOKED'} ${what}; the old config is at ${backup}`);
    return EXIT.ok;
  });
}

/** `roles grant <role> --holder <id|name|team> [--commands <a,b>] [--yes]`. */
export async function grant(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const name = onePositional(args, 'role');
  const holderText = args.flags.get('holder');
  if (holderText === undefined) {
    throw new UsageError('roles grant needs --holder <id|name|team>: the session that will hold the role, or team for every session');
  }
  const commands = commandsOf(args.flags.get('commands'));
  let holder: RoleHolder = { kind: 'team' };
  if (holderText !== 'team') {
    const kit = await openTeamKit(runtime);
    const roster = await rosterOf(runtime, kit, requireConfig(kit, runtime, 'write'));
    holder = { kind: 'session', id: sessionIdOf(roster, holderText) };
  }
  return changeRoles(args, runtime, name, { verb: 'grant', backupName: GRANT_BACKUP_NAME, plan: (roles) => granted(roles, name, holder, commands) });
}

/** `roles revoke <role> [--holder <id|name>] [--yes]`. */
export async function revoke(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const name = onePositional(args, 'role');
  const holderText = args.flags.get('holder');
  let holder: string | undefined;
  if (holderText !== undefined) {
    const kit = await openTeamKit(runtime);
    holder = sessionIdOf(await rosterOf(runtime, kit, requireConfig(kit, runtime, 'write')), holderText);
  }
  return changeRoles(args, runtime, name, { verb: 'revoke', backupName: REVOKE_BACKUP_NAME, plan: (roles) => revoked(roles, name, holder) });
}

/** `roles list`: each role, who holds it and what it runs. */
export async function list(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const roles = Object.entries(requireConfig(kit, runtime, 'read').serviceRoles);
  if (roles.length === 0) {
    runtime.out.stdout('no service roles; the owner grants one with `teamrig roles grant <role> --holder <id> --commands <a,b> --yes`');
    return EXIT.ok;
  }
  for (const [name, role] of roles) {
    runtime.out.stdout(describeRole(name, role));
  }
  return EXIT.ok;
}
