import type { SecretGuardConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { jsonObjectOf } from '../doctor/settings-env.ts';
import type { SettingsFile } from '../permissions/settings-scope.ts';
import type { UnownedWarning } from './unowned.ts';

/** What every SECRET-GUARD-OFF warning ends with: who decides it. */
const OWNER_CALL = "Turning a secret check off is the owner's call: set it back unless the owner chose it.";

function warning(key: string, text: string): UnownedWarning {
  return { key: `secret-guard-off ${key}`, source: 'the secret guard check [secretGuard]', text: `SECRET-GUARD-OFF ${text} ${OWNER_CALL}` };
}

/** The team's secret guard keys set to let a secret through, each with what it then lets through. */
function keysOff(config: SecretGuardConfig): UnownedWarning[] {
  const keys: readonly { readonly key: string; readonly off: boolean; readonly text: string }[] = [
    { key: 'secretGuard.secretReads', off: config.secretReads === 'allow', text: 'is allow: a call that would print a secret into a session runs unasked.' },
    { key: 'secretGuard.writes', off: config.writes === 'allow', text: 'is allow: a command line or a written file that holds a secret as text runs unasked.' },
    { key: 'secretGuard.redact', off: !config.redact, text: 'is false: a secret a call prints reaches the session unredacted.' },
  ];
  return keys.filter(({ off }) => off).map(({ key, text }) => warning(key, `${key} ${text}`));
}

/** Whether the settings file sets `disableAllHooks`; a missing or unreadable file does not. */
async function disablesHooks(files: Files, path: string): Promise<boolean> {
  const text = await files.read(path);
  return text !== undefined && jsonObjectOf(text)?.['disableAllHooks'] === true;
}

/**
 * SECRET-GUARD-OFF (T1369), for `check`: each key of the team's secret guard set to let a secret through
 * (`secretReads` or `writes` at `allow`, `redact` at `false`), and each Claude Code settings file a team session runs
 * under that sets `disableAllHooks`, which stops every teamrig hook, the secret guard's included. Turning a check off is
 * the owner's call, not one session's area, so it is a warning no session owns and goes to the lead. Reads only.
 */
export async function secretGuardOffWarnings(files: Files, config: SecretGuardConfig, settings: readonly SettingsFile[]): Promise<UnownedWarning[]> {
  const unhooked: UnownedWarning[] = [];
  for (const { path } of settings) {
    if (await disablesHooks(files, path)) {
      unhooked.push(warning(`disableAllHooks ${path}`, `${path} sets disableAllHooks: no teamrig hook runs for a session under it, the secret guard included.`));
    }
  }
  return [...keysOff(config), ...unhooked];
}
