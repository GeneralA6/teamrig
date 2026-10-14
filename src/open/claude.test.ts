import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../core/home.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { findClaude, type ClaudeSearch } from './claude.ts';

const NODE = 'C:\\node\\node.exe';
/** The tail of the shim npm writes for a package's bin on Windows. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

function windows(env: Env, files: readonly string[], shims: Readonly<Record<string, string>> = {}): Promise<ClaudeSearch> {
  return findClaude({ env, platform: 'win32', probe: new FakePathProbe({ files: [...files, ...Object.keys(shims)] }), files: new MemoryFiles(shims), node: NODE });
}

describe('findClaude on Windows', () => {
  it('finds the native claude.exe on PATH, whatever case the variable has', async () => {
    const found = await windows({ Path: 'C:\\empty;"C:\\Users\\me\\.local\\bin";' }, ['C:\\Users\\me\\.local\\bin\\claude.exe']);
    assert.deepEqual(found, { kind: 'found', program: { command: 'C:\\Users\\me\\.local\\bin\\claude.exe', prefix: [] } });
  });

  it('runs the script behind an npm claude.cmd with Node.js, never through cmd.exe', async () => {
    const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const found = await windows({ PATH: 'C:\\npm' }, [script], { 'C:\\npm\\claude.cmd': NPM_SHIM });
    assert.deepEqual(found, { kind: 'found', program: { command: NODE, prefix: [script] } });
  });

  it('runs a program behind a shim directly, and takes the PATHEXT order', async () => {
    const shim = '@echo off\r\n"%~dp0\\bin\\claude.exe" %*\r\n';
    const found = await windows({ PATH: 'C:\\tools', PATHEXT: '.BAT;.EXE' }, ['C:\\tools\\bin\\claude.exe', 'C:\\tools\\claude.exe'], { 'C:\\tools\\claude.bat': shim });
    assert.deepEqual(found, { kind: 'found', program: { command: 'C:\\tools\\bin\\claude.exe', prefix: [] } });
  });

  it('skips a shim it cannot read safely and keeps looking', async () => {
    const found = await windows(
      { PATH: 'C:\\a;C:\\b;C:\\c;C:\\d' },
      ['C:\\b\\gone.txt', 'C:\\c\\other.ps1', 'C:\\d\\claude.exe'],
      {
        'C:\\a\\claude.cmd': '@echo off\r\nnode "%~dp0\\cli.js" %*\r\n',
        'C:\\b\\claude.cmd': '"%dp0%\\missing.js" %*',
        'C:\\c\\claude.cmd': '"%dp0%\\other.ps1" %*',
      },
    );
    assert.deepEqual(found, { kind: 'found', program: { command: 'C:\\d\\claude.exe', prefix: [] } });
    const missing = await windows({ PATH: 'C:\\a;C:\\b;C:\\c' }, ['C:\\c\\other.ps1'], {
      'C:\\a\\claude.cmd': 'claude-code %*',
      'C:\\b\\claude.cmd': '"%dp0%\\missing.js" %*',
      'C:\\c\\claude.cmd': '"%dp0%\\other.ps1" %*',
    });
    assert.deepEqual(missing, {
      kind: 'missing',
      skipped: [
        'C:\\a\\claude.cmd is not an npm launcher',
        'C:\\b\\claude.cmd starts C:\\b\\missing.js, which is not there',
        'C:\\c\\claude.cmd starts C:\\c\\other.ps1, which is neither a script nor a program',
      ],
    });
  });

  it('reports nothing found with no PATH, and ignores extensions it does not run', async () => {
    assert.deepEqual(await windows({}, []), { kind: 'missing', skipped: [] });
    assert.deepEqual(await windows({ PATH: 'C:\\x', PATHEXT: '.JS' }, ['C:\\x\\claude.js']), { kind: 'missing', skipped: [] });
  });
});

describe('findClaude elsewhere', () => {
  it('takes the first claude on PATH', async () => {
    const probe = new FakePathProbe({ files: ['/opt/claude/bin/claude', '/usr/local/bin/claude'] });
    const found = await findClaude({ env: { PATH: '/usr/bin::/opt/claude/bin:/usr/local/bin' }, platform: 'darwin', probe, files: new MemoryFiles(), node: '/n' });
    assert.deepEqual(found, { kind: 'found', program: { command: '/opt/claude/bin/claude', prefix: [] } });
  });

  it('reads PATH by its exact name, and reports nothing found', async () => {
    const probe = new FakePathProbe({ files: ['/bin/claude'] });
    const found = await findClaude({ env: { Path: '/bin' }, platform: 'linux', probe, files: new MemoryFiles(), node: '/n' });
    assert.deepEqual(found, { kind: 'missing', skipped: [] });
  });
});
