import { FileLock } from "../core/lock.js";
import { RegisterPolicy } from "../register/policy.js";
import { Register } from "../register/register.js";
import { JsonlEventLog } from "../register/store.js";
import { SkillDir } from "../skills/store.js";
import { teamZone } from "./kit.js";
import { KitTreeNumbering } from "./tree-numbering.js";
import { KitTreeTasks } from "./tree-tasks.js";
/** The team's register on disk: its event log under the team's lock, judged by the team's policy. */
export function teamRegister(runtime, paths, config) {
    const { files, clock, sleep, pid } = runtime;
    return new Register({
        log: new JsonlEventLog(files, paths.events),
        mutex: new FileLock(paths.eventsLock, config.lock, { files, clock, sleep, pid }),
        numbering: new KitTreeNumbering(runtime, paths.team, config.lock),
        elsewhere: new KitTreeTasks(runtime, paths.team),
        clock,
        policy: new RegisterPolicy(config),
        skills: new SkillDir(files, paths.skills),
        autoArchive: config.register.autoArchive,
        zone: teamZone(config, runtime),
    });
}
