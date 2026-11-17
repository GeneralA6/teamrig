import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { JsonlEventLog } from '../register/store.ts';
import { lineFrontPath, LineFrontStore } from './line-front-store.ts';
import { lineRequestOf, type LineTask, type RequestFocus, type RequestSource } from './process-request.ts';

/**
 * The line requests of one team's steps as they stand at each read (T4082): the priority and class of the task each
 * names, by `taskOf`, and the team's front, read from `front` every time, so a task raised, or put at the front, while
 * its step waits moves that step at its next read.
 */
export function requestSourceOf(taskOf: (id: string) => Promise<LineTask | undefined>, front: LineFrontStore, focus: RequestFocus): RequestSource {
  return {
    async current(request) {
      return lineRequestOf(request, taskOf, focus, await front.read());
    },
  };
}

/**
 * The line requests of the team at `paths`: its register's tasks, read again at each call, and the front its lead put
 * in its state folder (`teamrig pipeline front`). Each team reads only its own register and front, so a lead fronts
 * only its own team's tasks.
 */
export function teamRequestsOf(files: Files, paths: Pick<TeamPaths, 'events' | 'state'>, focus: RequestFocus): RequestSource {
  const register = new JsonlEventLog(files, paths.events);
  return requestSourceOf(async (id) => (await register.read()).state.tasks.get(id), new LineFrontStore(files, lineFrontPath(paths.state)), focus);
}
