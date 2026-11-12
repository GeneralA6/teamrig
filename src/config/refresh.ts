import { AUTO_RESTART_LEAD, type KitConfig } from './types.ts';

/** Whether the automatic restart is on for session `id`: `lead` turns it on for the team's lead only. */
export function autoRestartOf(config: Pick<KitConfig, 'refresh' | 'roles'>, id: string): boolean {
  const { autoRestart } = config.refresh;
  return autoRestart === AUTO_RESTART_LEAD ? config.roles.lead === id : autoRestart;
}
