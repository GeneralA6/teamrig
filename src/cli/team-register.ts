import type { KitConfig } from '../config/types.ts';
import type { SessionAddress } from '../core/address.ts';
import type { TeamPaths } from '../core/home.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { Register } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { SkillDir } from '../skills/store.ts';
import { teamZone } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { KitTreeNumbering } from './tree-numbering.ts';
import { KitTreeTasks } from './tree-tasks.ts';
import { fileLockOf } from './file-locks.ts';

/**
 * The team's register on disk: its event log under the team's lock, judged by the team's policy; `above` is the parent
 * team's lead, who approves the lead's own work (T1140), for the commands that judge a wait or an approval of it.
 */
export function teamRegister(runtime: CliRuntime, paths: TeamPaths, config: KitConfig, above?: SessionAddress): Register {
  const { files, clock } = runtime;
  return new Register({
    log: new JsonlEventLog(files, paths.events),
    mutex: fileLockOf(runtime, paths.eventsLock, config.lock),
    numbering: new KitTreeNumbering(runtime, paths.team, config.lock),
    elsewhere: new KitTreeTasks(runtime, paths.team),
    clock,
    policy: new RegisterPolicy(config, above),
    skills: new SkillDir(files, paths.skills),
    autoArchive: config.register.autoArchive,
    zone: teamZone(config, runtime),
  });
}
