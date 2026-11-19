import type { ServiceRoleConfig } from '../config/types.ts';
import { TEAM_HELD_COMMANDS, type ServiceCommand } from './service-commands.ts';

/**
 * Who holds a service role's command (T2984): read by the role allow, which lets the holder's call run with no prompt,
 * and by the register, which lets the holder of `issue migrate` link another session's task to its issue (T4606).
 */

/** True when the role gives `command` to `holder`: a holder it names, or every session for a command that checks its own caller. */
function holds(role: ServiceRoleConfig, command: ServiceCommand, holder: string): boolean {
  if (!role.commands.includes(command)) {
    return false;
  }
  return role.holders === 'team' ? TEAM_HELD_COMMANDS.has(command) : role.holders.includes(holder);
}

/** The role, by name, that gives `holder` the command; the first by name when two do, so the cap counts one; else undefined. */
export function roleHolding(roles: Readonly<Record<string, ServiceRoleConfig>>, command: ServiceCommand, holder: string): string | undefined {
  return Object.keys(roles)
    .sort()
    .find((name) => {
      const role = roles[name];
      return role !== undefined && holds(role, command, holder);
    });
}
