import { AUTO_RESTART_LEAD } from "./types.js";
/** Whether the automatic restart is on for session `id`: `lead` turns it on for the team's lead only. */
export function autoRestartOf(config, id) {
    const { autoRestart } = config.refresh;
    return autoRestart === AUTO_RESTART_LEAD ? config.roles.lead === id : autoRestart;
}
