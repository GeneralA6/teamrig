import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { secretDenyLines } from '../doctor/deny-lines.ts';
import { CliHarness, APP, USER_SETTINGS as USER, type RunOptions } from '../testing/cli-harness.ts';
import { NO_PATHS_HOST } from '../testing/host.ts';
import { EXIT } from './runtime.ts';

const LOCAL = join(APP, '.claude', 'settings.local.json');
const OPTIONS: RunOptions = { platform: 'linux' };
const SECRET_DENY_LINES = secretDenyLines('linux');
const MISSING = ['Bash(env)', 'Read(//**/*.pem)'];
const FLAG =
  `WARN deny-missing 2 of ${SECRET_DENY_LINES.length} secret deny line(s) are in no settings file a session reads (read: ${USER}, ${LOCAL}), ` +
  "so a hook's allow or auto mode can approve reading a credential file or printing the environment; a deny line beats both, and teamrig never writes permissions: " +
  `paste these into the permissions.deny list of ${USER} yourself: ${JSON.stringify(MISSING)}`;

/** Every secret deny line but two, split between the user's settings and the project's local ones. */
async function withMostLines(): Promise<CliHarness> {
  const kit = new CliHarness();
  const held = SECRET_DENY_LINES.filter((line) => !MISSING.includes(line));
  await kit.files.write(USER, formatConfig({ permissions: { deny: held.slice(0, 4) } }));
  await kit.files.write(LOCAL, formatConfig({ permissions: { deny: held.slice(4) } }));
  return kit;
}

describe('the deny-missing flag', () => {
  it('is a doctor finding naming the files read and the lines to paste', async () => {
    const doctor = await (await withMostLines()).run(['doctor'], OPTIONS);
    assert.ok(doctor.stdout.includes(FLAG), doctor.stdout.join('\n'));
  });

  it("is a warning no session owns in check, which the lead's start shows and another session's does not", async () => {
    const kit = await withMostLines();
    const row = `from the secret deny check of the Claude Code settings' permissions.deny: ${FLAG}`;
    const check = await kit.run(['check', '--all', '--session', 'lead'], OPTIONS);
    assert.ok(check.stdout.includes(row), check.stdout.join('\n'));
    const lead = await kit.run(['start', '--session', 'lead', '--all'], OPTIONS);
    assert.ok(lead.stdout.includes(row), lead.stdout.join('\n'));
    const alpha = await kit.run(['start', '--session', 'alpha', '--all'], OPTIONS);
    assert.ok(!alpha.stdout.some((line) => line.includes('deny-missing')), alpha.stdout.join('\n'));
  });

  it('is quiet on a host whose folders teamrig does not know: doctor and check go on with no settings file read or named', async () => {
    const kit = await withMostLines();
    const options: RunOptions = { ...OPTIONS, host: NO_PATHS_HOST };
    const doctor = await kit.run(['doctor'], options);
    const check = await kit.run(['check', '--all', '--session', 'lead'], options);
    assert.deepEqual([doctor.code, check.code], [EXIT.ok, EXIT.ok], [...doctor.stderr, ...check.stderr].join('\n'));
    assert.ok(![...doctor.stdout, ...check.stdout].some((line) => line.includes('deny-missing')), [...doctor.stdout, ...check.stdout].join('\n'));
  });

  it('is quiet once the settings hold every line', async () => {
    const kit = new CliHarness();
    await kit.holdSecretDeny();
    const doctor = await kit.run(['doctor'], OPTIONS);
    assert.ok(!doctor.stdout.some((line) => line.includes('deny-missing')), doctor.stdout.join('\n'));
    const check = await kit.run(['check', '--all', '--session', 'lead'], OPTIONS);
    assert.ok(!check.stdout.some((line) => line.includes('deny-missing')), check.stdout.join('\n'));
  });

  it("asks for gh's Windows hosts line on Windows, where the Linux one guards nothing, and never the reverse (T2038)", async () => {
    const kit = new CliHarness();
    await kit.files.write(USER, formatConfig({ permissions: { deny: [...SECRET_DENY_LINES] } }));
    const windows = await kit.run(['doctor'], { platform: 'win32' });
    const flag = windows.stdout.find((line) => line.includes('deny-missing'));
    assert.ok(flag?.endsWith(`yourself: ${JSON.stringify(['Read(~/AppData/Roaming/GitHub CLI/hosts.yml)'])}`), windows.stdout.join('\n'));
    const linux = await kit.run(['doctor'], OPTIONS);
    assert.ok(!linux.stdout.some((line) => line.includes('deny-missing')), linux.stdout.join('\n'));
  });
});
