import { join } from 'node:path';
export const SKILL_FILE = 'SKILL.md';
/** A skill folder name; anything else (a path, `..`) is never looked up. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The skills folder: a skill is `<dir>/<name>/SKILL.md`; a folder without one (e.g. a sync cache) is not a skill. */
export class SkillDir {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    async exists(name) {
        return SKILL_NAME.test(name) && (await this.files.read(this.pathOf(name))) !== undefined;
    }
    async readAll() {
        const skills = [];
        for (const name of (await this.files.list(this.dir)).sort()) {
            const text = SKILL_NAME.test(name) ? await this.files.read(this.pathOf(name)) : undefined;
            if (text !== undefined) {
                skills.push({ name, text });
            }
        }
        return skills;
    }
    pathOf(name) {
        return join(this.dir, name, SKILL_FILE).replaceAll('\\', '/');
    }
}
