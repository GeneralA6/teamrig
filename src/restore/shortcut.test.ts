import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProgramRequest, ProgramResult, ProgramRunner } from '../github/credentials.ts';
import {
  parseShortcutScan,
  RESTORE_SHORTCUT_DESCRIPTION,
  RESTORE_SHORTCUT_NAME,
  restoreShortcut,
  sameStart,
  shortcutLine,
  shortcutsToRemove,
  shortcutsToWrite,
  systemShortcutPlace,
  WINDOWS_SCAN_SCRIPT,
  type FoundShortcut,
  type ShortcutPlace,
  type ShortcutScan,
} from './shortcut.ts';

const HOME = 'D:\\homes\\Zoë';
const LAUNCHER = `${HOME}\\.teamrig\\bin\\restore-run.mjs`;
const START_MENU = `${HOME}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\${RESTORE_SHORTCUT_NAME}`;
const PIN = `${HOME}\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\${RESTORE_SHORTCUT_NAME}`;
const DESKTOP = `${HOME}\\Desktop\\${RESTORE_SHORTCUT_NAME}`;
const WANTED = restoreShortcut('C:\\nodejs\\node.exe', LAUNCHER, HOME);
/** The shortcut an older stopgap wrote: Windows Terminal running another script. */
const OLD = { target: `${HOME}\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe`, arguments: '-w claude-restore new-tab "C:\\nodejs\\node.exe" "C:\\old\\restore-now.mjs"', folder: HOME, description: 'old' };

function at(path: string, shortcut: typeof WANTED): FoundShortcut {
  return { path, ...shortcut };
}

function exited(code: number, stdout = '', stderr = ''): ProgramResult {
  return { end: { kind: 'exited', code }, stdout, stderr };
}

function recordingRunner(results: ProgramResult[] = []): { readonly run: ProgramRunner; readonly ran: ProgramRequest[] } {
  const ran: ProgramRequest[] = [];
  return {
    ran,
    run: async (request) => {
      ran.push(request);
      return results.shift() ?? exited(0);
    },
  };
}

function scriptOf(request: ProgramRequest | undefined): string {
  assert.ok(request !== undefined);
  assert.equal(request.program, 'powershell.exe');
  return Buffer.from(request.args[request.args.length - 1] ?? '', 'base64').toString('utf16le');
}

/** The text a script carries as UTF-8 base64. */
function carriedIn(script: string): string {
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1];
  assert.ok(encoded !== undefined, 'the script carries base64 text');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function windowsPlace(run: ProgramRunner): ShortcutPlace {
  const place = systemShortcutPlace('win32', run);
  assert.ok(place !== undefined);
  return place;
}

function printedScan(scan: unknown): string {
  return `${Buffer.from(JSON.stringify(scan), 'utf8').toString('base64')}\r\n`;
}

describe('restore shortcut', () => {
  it('runs the run launcher under Node from the home folder, and reads as what it runs and where', () => {
    assert.deepEqual(WANTED, { target: 'C:\\nodejs\\node.exe', arguments: `"${LAUNCHER}"`, folder: HOME, description: RESTORE_SHORTCUT_DESCRIPTION });
    assert.equal(shortcutLine(WANTED), `"C:\\nodejs\\node.exe" "${LAUNCHER}" (in "${HOME}")`);
  });

  it('starts the same when program, arguments and folder match, whatever its tip', () => {
    assert.ok(sameStart(WANTED, { ...WANTED, description: 'another tip' }));
    for (const change of [{ target: 'C:\\other\\node.exe' }, { arguments: '"C:\\x.mjs"' }, { folder: 'C:\\' }]) {
      assert.ok(!sameStart(WANTED, { ...WANTED, ...change }), JSON.stringify(change));
    }
  });
});

describe('shortcutsToWrite', () => {
  it('writes the Start-menu shortcut when it is missing', () => {
    assert.deepEqual(shortcutsToWrite({ startMenu: START_MENU, found: [] }, WANTED), [{ path: START_MENU, before: undefined }]);
  });

  it('repoints every one found that starts something else, the Start-menu one first, and leaves the rest', () => {
    const scan: ShortcutScan = { startMenu: START_MENU, found: [at(PIN, OLD), at(START_MENU, OLD), at(DESKTOP, WANTED)] };
    assert.deepEqual(shortcutsToWrite(scan, WANTED), [
      { path: START_MENU, before: at(START_MENU, OLD) },
      { path: PIN, before: at(PIN, OLD) },
    ]);
    assert.deepEqual(shortcutsToWrite({ startMenu: START_MENU, found: [at(START_MENU, WANTED), at(PIN, OLD)] }, WANTED), [{ path: PIN, before: at(PIN, OLD) }]);
    assert.deepEqual(shortcutsToWrite({ startMenu: START_MENU, found: [at(START_MENU, WANTED), at(PIN, WANTED)] }, WANTED), []);
  });
});

describe('shortcutsToRemove', () => {
  it('is each one found that runs the run launcher, never one that runs something else', () => {
    const scan: ShortcutScan = { startMenu: START_MENU, found: [at(START_MENU, WANTED), at(PIN, OLD), at(DESKTOP, WANTED)] };
    assert.deepEqual(shortcutsToRemove(scan, LAUNCHER), [at(START_MENU, WANTED), at(DESKTOP, WANTED)]);
  });
});

describe('parseShortcutScan', () => {
  it('reads the UTF-8 base64 JSON, so every character of a path survives', () => {
    const scan = { startMenu: START_MENU, found: [at(PIN, OLD)] };
    assert.deepEqual(parseShortcutScan(printedScan(scan)), scan);
    assert.deepEqual(parseShortcutScan(printedScan({ startMenu: START_MENU, found: [] })), { startMenu: START_MENU, found: [] });
  });

  it('throws on anything else, a shortcut missing a field among them', () => {
    const noArguments = { path: PIN, target: OLD.target, folder: OLD.folder, description: OLD.description };
    for (const printed of ['not base64 json', printedScan({ found: [] }), printedScan({ startMenu: START_MENU, found: at(PIN, OLD) }), printedScan({ startMenu: START_MENU, found: [noArguments] })]) {
      assert.throws(() => parseShortcutScan(printed), /^Error: the shortcut scan printed no list of shortcuts: /, printed);
    }
  });
});

describe('systemShortcutPlace', () => {
  it('has no place off Windows', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      assert.equal(systemShortcutPlace(platform, recordingRunner().run), undefined);
    }
  });

  it('scans the Start menu, the desktop and the taskbar pins for the shortcut by its name', async () => {
    const scan = { startMenu: START_MENU, found: [at(START_MENU, WANTED)] };
    const { run, ran } = recordingRunner([exited(0, printedScan(scan))]);
    assert.deepEqual(await windowsPlace(run).scan(), scan);
    assert.equal(scriptOf(ran[0]), WINDOWS_SCAN_SCRIPT);
    assert.match(WINDOWS_SCAN_SCRIPT, new RegExp(`\\$name = '${RESTORE_SHORTCUT_NAME}'`));
    for (const folder of ["GetFolderPath('Programs')", "GetFolderPath('Desktop')", "'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'"]) {
      assert.ok(WINDOWS_SCAN_SCRIPT.includes(folder), folder);
    }
  });

  it('writes a shortcut in place through WScript.Shell, its fields carried as base64, quotes and all', async () => {
    const { run, ran } = recordingRunner();
    await windowsPlace(run).write(PIN, WANTED);
    const script = scriptOf(ran[0]);
    assert.deepEqual(JSON.parse(carriedIn(script)), { path: PIN, ...WANTED });
    for (const line of ['$link = (New-Object -ComObject WScript.Shell).CreateShortcut($s.path)', '$link.TargetPath = $s.target', '$link.Arguments = $s.arguments', '$link.WorkingDirectory = $s.folder', '$link.Description = $s.description', '$link.Save()']) {
      assert.ok(script.includes(line), line);
    }
    assert.match(script, /^\$ErrorActionPreference = 'Stop'/);
  });

  it('removes a shortcut only when it is there', async () => {
    const { run, ran } = recordingRunner();
    await windowsPlace(run).remove(DESKTOP);
    const script = scriptOf(ran[0]);
    assert.equal(carriedIn(script), DESKTOP);
    assert.match(script, /if \(Test-Path -LiteralPath \$path\) \{ Remove-Item -LiteralPath \$path -Force \}/);
  });

  it('throws with the first line PowerShell printed when it fails', async () => {
    const { run } = recordingRunner([exited(1, '', 'Access is denied.'), exited(1, '', 'The system cannot find the path specified.'), exited(0, 'garbage')]);
    const place = windowsPlace(run);
    await assert.rejects(place.write(PIN, WANTED), /PowerShell ended with exit 1: Access is denied\.$/);
    await assert.rejects(place.remove(PIN), /PowerShell ended with exit 1: The system cannot find the path specified\.$/);
    await assert.rejects(place.scan(), /the shortcut scan printed no list of shortcuts: garbage$/);
  });
});
