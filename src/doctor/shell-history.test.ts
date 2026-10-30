import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { powerShellProfiles, psReadLineHistory, readShellHistory, setsHistoryGate, type ShellHome } from './shell-history.ts';

const HOME = join('/', 'u');
const WINDOWS: ShellHome = { env: {}, userHome: HOME, platform: 'win32' };
const LINUX: ShellHome = { env: {}, userHome: HOME, platform: 'linux' };
const HANDLER = "Set-PSReadLineOption -AddToHistoryHandler {\n  param([string]$line)\n  return $line -notmatch 'token'\n}";

/** MemoryFiles that records each path read, to prove a file was only probed. */
class ReadLog extends MemoryFiles {
  readonly reads: string[] = [];

  override async read(path: string): Promise<string | undefined> {
    this.reads.push(path);
    return super.read(path);
  }
}

describe('psReadLineHistory', () => {
  it('is under %APPDATA% on Windows, else the roaming folder of the home', () => {
    const appData = join('/', 'roaming');
    assert.equal(psReadLineHistory({ ...WINDOWS, env: { APPDATA: ` ${appData} ` } }), join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'));
    assert.equal(psReadLineHistory({ ...WINDOWS, env: { APPDATA: ' ' } }), join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'));
  });

  it('is under $XDG_DATA_HOME elsewhere, else ~/.local/share', () => {
    const data = join('/', 'data');
    assert.equal(psReadLineHistory({ ...LINUX, env: { XDG_DATA_HOME: data } }), join(data, 'powershell', 'PSReadLine', 'ConsoleHost_history.txt'));
    assert.equal(psReadLineHistory(LINUX), join(HOME, '.local', 'share', 'powershell', 'PSReadLine', 'ConsoleHost_history.txt'));
  });
});

describe('powerShellProfiles', () => {
  it("lists both shells' profiles in Documents, then in each OneDrive's Documents, once each", () => {
    const work = join('/', 'od-work');
    const env = { OneDrive: join(HOME, 'OneDrive'), OneDriveConsumer: '', OneDriveCommercial: work };
    const folders = [join(HOME, 'Documents'), join(HOME, 'OneDrive', 'Documents'), join(work, 'Documents')];
    const expected = folders.flatMap((folder) =>
      ['PowerShell', 'WindowsPowerShell'].flatMap((shell) => ['Microsoft.PowerShell_profile.ps1', 'profile.ps1'].map((file) => join(folder, shell, file))),
    );
    assert.deepEqual(powerShellProfiles({ ...WINDOWS, env }), expected);
  });

  it('lists ~/OneDrive/Documents on Windows with no OneDrive variable set', () => {
    assert.ok(powerShellProfiles(WINDOWS).includes(join(HOME, 'OneDrive', 'Documents', 'WindowsPowerShell', 'profile.ps1')));
  });

  it('lists the profiles under $XDG_CONFIG_HOME elsewhere, else ~/.config', () => {
    const config = join('/', 'config');
    assert.deepEqual(powerShellProfiles({ ...LINUX, env: { XDG_CONFIG_HOME: config } }), [
      join(config, 'powershell', 'Microsoft.PowerShell_profile.ps1'),
      join(config, 'powershell', 'profile.ps1'),
    ]);
    assert.deepEqual(powerShellProfiles(LINUX), [join(HOME, '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1'), join(HOME, '.config', 'powershell', 'profile.ps1')]);
  });
});

describe('setsHistoryGate', () => {
  it('finds a history handler, or saving turned off however it is written', () => {
    assert.equal(setsHistoryGate(`try {\n  ${HANDLER}\n} catch {}`), true);
    assert.equal(setsHistoryGate('Set-PSReadLineOption -HistorySaveStyle SaveNothing'), true);
    assert.equal(setsHistoryGate('Set-PSReadLineOption -historysavestyle:"SaveNothing"'), true);
    assert.equal(setsHistoryGate("$options = @{ HistorySaveStyle = 'SaveNothing' }"), true);
    assert.equal(setsHistoryGate('Set-PSReadLineOption -HistorySaveStyle ([Microsoft.PowerShell.HistorySaveStyle]::SaveNothing)'), true);
  });

  it('reads a UTF-16 profile, as Windows PowerShell 5.1 writes one', () => {
    assert.equal(setsHistoryGate(`��${[...HANDLER].join('\0')}`), true);
  });

  it('skips commented-out lines and blocks, and a save style that still saves', () => {
    assert.equal(setsHistoryGate(`# ${HANDLER.split('\n').join('\n# ')}`), false);
    assert.equal(setsHistoryGate(`<#\n${HANDLER}\n#>\nSet-Location ~`), false);
    assert.equal(setsHistoryGate('Set-PSReadLineOption -HistorySaveStyle SaveIncrementally'), false);
    assert.equal(setsHistoryGate(''), false);
  });
});

describe('readShellHistory', () => {
  const history = psReadLineHistory(WINDOWS);
  const [first, second] = powerShellProfiles(WINDOWS);

  it('finds the history file by probing it, never reading it, and the profiles that exist', async () => {
    assert.ok(first !== undefined && second !== undefined);
    const files = new ReadLog({ [first]: 'Set-Location ~', [second]: HANDLER });
    const result = await readShellHistory(files, new FakePathProbe({ files: [history] }), WINDOWS);
    assert.deepEqual(result, { history, profiles: [first, second], gated: true });
    assert.ok(!files.reads.includes(history));
    assert.deepEqual(files.reads, powerShellProfiles(WINDOWS));
  });

  it('reports no history when its path is no file, and an ungated profile', async () => {
    assert.ok(first !== undefined);
    const files = new MemoryFiles({ [first]: 'Set-Location ~' });
    assert.deepEqual(await readShellHistory(files, new FakePathProbe({ folders: [history] }), WINDOWS), { history: undefined, profiles: [first], gated: false });
    assert.deepEqual(await readShellHistory(new MemoryFiles(), new FakePathProbe({ files: [history] }), WINDOWS), { history, profiles: [], gated: false });
  });
});
