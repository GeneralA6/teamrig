import { KIT_NAME } from './home.ts';

/**
 * The commands whose write changes a permission: Claude Code's settings (the permission and auto-mode rules, the
 * status line), the settings a backup restores, the team config's own format, or what runs at login (T3083;
 * core rule 6 makes permissions an owner gate). Each previews without `--yes` and writes with it. Their write is
 * refused where an agent's host runs it (a mark of the host's is set: an agent's tool call, a script it runs, a hook)
 * and on a host that tells no such run from the person's, and the exec guard refuses a tool call that runs one; a
 * typed `/teamrig <command> --yes`, which the plugin's mod runs with the host's own environment, and the owner's own
 * terminal still write. Keyed by the command's group, then its actions.
 */
export const SETTINGS_WRITERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['automode', new Set(['install', 'uninstall'])],
  ['config', new Set(['migrate'])],
  ['permissions', new Set(['trim'])],
  ['restore', new Set(['install'])],
  ['setup', new Set(['restore'])],
  ['statusline', new Set(['install'])],
]);

/** The switch that turns a settings writer's preview into its write. */
export const WRITE_SWITCH = 'yes';

/** True when the command (its words joined, `permissions trim`) is a settings writer. */
export function isSettingsWriter(command: string): boolean {
  const [group, action, ...more] = command.split(' ');
  return group !== undefined && action !== undefined && more.length === 0 && (SETTINGS_WRITERS.get(group)?.has(action) ?? false);
}

/**
 * Why a settings writer's write is refused where Claude Code runs it, and the routes the owner runs it by. `mark` is
 * the host's variable that showed the run to be an agent's; the exec guard, which refuses the tool call itself, names
 * none where its own run shows none.
 */
export function settingsWriteRefusal(command: string, mark: string | undefined): string {
  const line = `${KIT_NAME} ${command} --${WRITE_SWITCH}`;
  const shown = mark === undefined ? '' : `${mark} is set: `;
  return (
    `\`${line}\` changes Claude Code's settings, the team config's format or what runs at login, permissions only the ` +
    `owner changes, so it is refused where Claude Code runs it (${shown}an agent's tool call, a script it ` +
    `runs or a hook); run it without --${WRITE_SWITCH} for its preview, and the owner types \`/${line}\` in a tab or ` +
    'runs it in their own terminal.'
  );
}
