import type { KitConfig } from '../config/types.ts';
import { errorMessage } from '../core/guards.ts';
import { SecretScanner } from '../core/secrets.ts';
import { postLine } from '../inbox/inbox.ts';
import { WakeAsks } from '../wake/asks.ts';
import { inboxDepsOf } from './commands/inbox.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/** An inbox line that wakes its receiver: the session it is for, who posts it, and what it says. */
export interface UrgentLine {
  readonly to: string;
  readonly from: string;
  readonly text: string;
}

/**
 * Posts the line to its receiver's inbox, which stays the record, then a wake ask (src/wake/asks.ts), so the
 * receiver's next wake check wakes its idle tab with the line quoted; why it was not posted, or undefined once it is
 * both. A line the inbox refuses (a secret pattern, not one line) gets no ask either.
 */
export async function postUrgentLine(runtime: CliRuntime, kit: Kit, config: KitConfig, line: UrgentLine): Promise<string | undefined> {
  const at = runtime.clock.now();
  const text = line.text.trim();
  const secrets = new SecretScanner(config.register.secretPatterns);
  try {
    const refused = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, secrets, { to: line.to, from: line.from, text, now: new Date(at) });
    if (refused !== undefined) {
      return refused;
    }
  } catch (error) {
    return `not posted: ${errorMessage(error)}`;
  }
  try {
    await new WakeAsks(runtime.files, kit.paths.wakeAsks).post(line.to, { from: line.from, text, at });
  } catch (error) {
    return `posted to the inbox, but it does not wake ${line.to}: ${errorMessage(error)}`;
  }
  return undefined;
}
