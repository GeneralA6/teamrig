import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { SkillCatalog } from '../register/register.ts';
import type { SkillFile } from './lint.ts';

export const SKILL_FILE = 'SKILL.md';

/** A skill folder name; anything else (a path, `..`) is never looked up. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The skills folder: a skill is `<dir>/<name>/SKILL.md`; a folder without one (e.g. a sync cache) is not a skill. */
export class SkillDir implements SkillCatalog {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  async exists(name: string): Promise<boolean> {
    return SKILL_NAME.test(name) && (await this.files.read(this.pathOf(name))) !== undefined;
  }

  async readAll(): Promise<SkillFile[]> {
    const skills: SkillFile[] = [];
    for (const name of (await this.files.list(this.dir)).sort()) {
      const text = SKILL_NAME.test(name) ? await this.files.read(this.pathOf(name)) : undefined;
      if (text !== undefined) {
        skills.push({ name, text });
      }
    }
    return skills;
  }

  pathOf(name: string): string {
    return join(this.dir, name, SKILL_FILE).replaceAll('\\', '/');
  }
}
