import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { readContextFiles } from './context-files.ts';

const AT = { claudeDir: '/u/.claude', project: '/w/app', skills: '/u/.claude/skills' };

describe('readContextFiles', () => {
  it('measures the CLAUDE.md files, the memory index and the skill listing of a project', async () => {
    const files = new MemoryFiles({
      '/u/.claude/CLAUDE.md': 'u'.repeat(10),
      '/w/app/CLAUDE.md': 'a'.repeat(30),
      '/w/app/.claude/CLAUDE.md': 'c'.repeat(5),
      '/w/CLAUDE.local.md': 'l'.repeat(7),
      '/u/.claude/projects/-w-app/memory/MEMORY.md': 'm'.repeat(40),
      '/u/.claude/projects/-w-other/memory/MEMORY.md': 'o'.repeat(99),
      '/u/.claude/skills/app-deploy/SKILL.md': '---\nname: app-deploy\ndescription: Ship it.\n---\nbody',
      '/u/.claude/skills/notes/README.md': 'not a skill',
      '/w/app/.claude/skills/team-notes/SKILL.md': '---\ndescription: >\n  Keep notes\n  short.\n---\n',
    });
    assert.deepEqual(await readContextFiles(files, AT), {
      claudeMd: [
        { path: join('/u/.claude', 'CLAUDE.md'), chars: 10 },
        { path: join('/w/app', 'CLAUDE.md'), chars: 30 },
        { path: join('/w/app', '.claude', 'CLAUDE.md'), chars: 5 },
        { path: join('/w', 'CLAUDE.local.md'), chars: 7 },
      ],
      memoryIndex: { path: join('/u/.claude', 'projects', '-w-app', 'memory', 'MEMORY.md'), chars: 40 },
      // "- app-deploy: Ship it.\n" is 23 characters, "- team-notes: Keep notes short.\n" 32.
      skills: { folders: [join('/u/.claude/skills'), join('/w/app', '.claude', 'skills')], count: 2, chars: 55 },
    });
  });

  it('counts the user CLAUDE.md once when the project sits in the user folder, and the skills folder once when the team uses the project one', async () => {
    const files = new MemoryFiles({ '/u/.claude/CLAUDE.md': 'u'.repeat(10), '/u/.claude/skills/x-y/SKILL.md': '---\ndescription: d\n---\n' });
    const read = await readContextFiles(files, { claudeDir: '/u/.claude', project: '/u', skills: '/u/.claude/skills' });
    assert.deepEqual(read.claudeMd, [{ path: join('/u/.claude', 'CLAUDE.md'), chars: 10 }]);
    assert.deepEqual(read.skills, { folders: [join('/u/.claude/skills')], count: 1, chars: '- x-y: d\n'.length });
  });

  it('finds nothing in a project with no CLAUDE.md, memory or skills', async () => {
    assert.deepEqual(await readContextFiles(new MemoryFiles(), AT), {
      claudeMd: [],
      memoryIndex: undefined,
      skills: { folders: [join('/u/.claude/skills'), join('/w/app', '.claude', 'skills')], count: 0, chars: 0 },
    });
  });
});
