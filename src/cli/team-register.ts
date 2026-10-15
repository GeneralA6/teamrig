import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { FileLock } from '../core/lock.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { Register } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { SkillDir } from '../skills/store.ts';
import type { CliRuntime } from './runtime.ts';

/** The team's register on disk: its event log under the team's lock, judged by the team's policy. */
export function teamRegister(runtime: CliRuntime, paths: TeamPaths, config: KitConfig): Register {
  const { files, clock, sleep, pid } = runtime;
  return new Register({
    log: new JsonlEventLog(files, paths.events),
    mutex: new FileLock(paths.eventsLock, config.lock, { files, clock, sleep, pid }),
    clock,
    policy: new RegisterPolicy(config),
    skills: new SkillDir(files, paths.skills),
    autoArchive: config.register.autoArchive,
  });
}
