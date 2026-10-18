import { join } from 'node:path';
/**
 * Where a recorded session's transcript is now: the path its hooks reported, else `<projects>/<folder>/<id>.jsonl`
 * in any project folder, since Claude Code keeps a session's transcript under the folder it started in and a
 * moved or renamed project leaves the stored path stale. The project folders are listed once, on first need.
 */
export class TranscriptFinder {
    files;
    probe;
    projectsDir;
    folders;
    constructor(files, probe, projectsDir) {
        this.files = files;
        this.probe = probe;
        this.projectsDir = projectsDir;
    }
    async find(entry) {
        if (entry.transcriptPath !== undefined && (await this.probe.kind(entry.transcriptPath)) === 'file') {
            return entry.transcriptPath;
        }
        this.folders ??= this.files.list(this.projectsDir);
        for (const folder of await this.folders) {
            const path = join(this.projectsDir, folder, `${entry.claudeSession}.jsonl`);
            if ((await this.probe.kind(path)) === 'file') {
                return path;
            }
        }
        return undefined;
    }
}
