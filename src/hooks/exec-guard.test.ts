import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../cli/args.ts';
import { COMMAND_EFFECTS, COMMAND_TABLE } from '../cli/run.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { settingsWriteRefusal } from '../core/settings-writers.ts';
import type { ClientCheck } from '../exec/client-integrity.ts';
import { ClientInstalls } from '../exec/client-launch.ts';
import { EXEC_COMMANDS, execGuardOutput, HOOK_COMMANDS, OWNER_COMMANDS, type ExecGuardEnv, type TabIdentity } from './exec-guard.ts';

const SESSIONS: Readonly<Record<string, string>> = { alpha: 'alpha', 'app-alpha': 'alpha', bravo: 'bravo', lead: 'lead' };

const ALPHA: TabIdentity = { kind: 'bound', session: 'alpha', owner: 'owner', idOf: (name) => SESSIONS[name] };

const INTACT: ClientCheck = { kind: 'intact' };

/** The plugin cache, the hook's own install in it, and an older version beside it that a tab keeps on PATH. */
const CACHE = 'C:/u/.claude/plugins/cache/teamrig/teamrig';
const INSTALL = `${CACHE}/0.156.0`;
const OLDER = `${CACHE}/0.152.0`;

/** Where the guard looks a client up besides the hook's own install: what the PATH search finds, and other installs' checks. */
interface Placing {
  /** The file the shell's PATH search finds for a bare name; none by default, so a bare `teamrig` is the plugin bin. */
  readonly found?: Readonly<Record<string, string>>;
  /** The check of each install root but the hook's own; intact by default. */
  readonly others?: Readonly<Record<string, ClientCheck>>;
}

/** An env whose identity reads and client checks are recorded, so a test can show the guard makes each only for a line that needs it. */
function env(
  identity: TabIdentity = ALPHA,
  client: ClientCheck = INTACT,
  placing: Placing = {},
): ExecGuardEnv & { readonly reads: () => number; readonly checks: () => number; readonly checked: () => readonly string[] } {
  let reads = 0;
  const checked: string[] = [];
  return {
    cwd: 'C:/w',
    home: 'C:/u',
    hookAsks: 'ask',
    identity: () => {
      reads += 1;
      return Promise.resolve(identity);
    },
    installs: new ClientInstalls(INSTALL, 'win32'),
    search: { find: (name) => Promise.resolve(placing.found?.[name]) },
    checkClient: (root) => {
      checked.push(root);
      return Promise.resolve(root === INSTALL ? client : (placing.others?.[root] ?? INTACT));
    },
    platform: 'linux',
    reads: () => reads,
    checks: () => checked.length,
    checked: () => checked,
  };
}

function bash(command: string): JsonRecord {
  return { tool_name: 'Bash', tool_input: { command }, cwd: 'C:/w' };
}

function powershell(command: string): JsonRecord {
  return { tool_name: 'PowerShell', tool_input: { command }, cwd: 'C:/w' };
}

/** The decision and reason the output carries, or undefined for no output. */
function verdictOf(output: string): { readonly decision: string | undefined; readonly reason: string } | undefined {
  if (output === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(output);
  const hook = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  assert.ok(isRecord(hook));
  assert.equal(stringField(hook, 'hookEventName'), 'PreToolUse');
  return { decision: stringField(hook, 'permissionDecision'), reason: stringField(hook, 'permissionDecisionReason') ?? '' };
}

async function verdict(payload: JsonRecord, guardEnv: ExecGuardEnv = env()): Promise<ReturnType<typeof verdictOf>> {
  return verdictOf(await execGuardOutput(payload, guardEnv));
}

describe('execGuardOutput', () => {
  it('lets a review through that names the tab’s own session, by id or by a name it has had', async () => {
    assert.equal(await verdict(bash('teamrig exec approve R1 --session alpha')), undefined);
    assert.equal(await verdict(bash('teamrig exec refuse R1 --note "use the read key" --session app-alpha')), undefined);
    assert.equal(await verdict(powershell('teamrig exec escalate R2 --session alpha --note "owner-gated"')), undefined);
  });

  it('refuses a review as another session, wherever the line runs it', async () => {
    for (const line of [
      'teamrig exec approve R1 --session bravo',
      'git status && teamrig exec approve R1 --session bravo',
      "bash -c 'teamrig exec approve R1 --session bravo'",
      'teamrig queue -- teamrig exec approve R1 --session bravo',
      `${INSTALL}/bin/teamrig.cmd exec approve R1 --session bravo`,
      `node --disable-warning=ExperimentalWarning ${INSTALL}/dist/cli/main.js exec approve R1 --session bravo`,
      `T=${INSTALL}/bin/teamrig; $T exec approve R1 --session bravo`,
    ]) {
      const found = await verdict(bash(line));
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', /^teamrig exec guard: `teamrig exec approve` names --session bravo, but this tab is alpha's; a session reviews only as itself \(--session alpha\)\.$/, line);
    }
  });

  it('refuses a review as the owner, naming the routes the owner reviews by', async () => {
    const found = await verdict(bash('teamrig exec approve R1 --session owner'));
    assert.equal(found?.decision, 'deny');
    assert.match(found?.reason ?? '', /names the owner \(--session owner\); the owner reviews in their own terminal, or types `\/teamrig exec approve R<n> --session owner` in a tab/);
  });

  it('refuses a review that names no --session, as a variable on the line cannot show who runs it', async () => {
    for (const line of ['teamrig exec approve R1', 'TEAMRIG_SESSION=owner teamrig exec approve R1', 'teamrig exec approve R1 --note --session']) {
      assert.match((await verdict(bash(line)))?.reason ?? '', /names no --session; name this tab's own \(--session alpha\)/, line);
    }
  });

  it('refuses a review that names --session twice, or a session the team does not have', async () => {
    assert.match((await verdict(bash('teamrig exec approve R1 --session alpha --session bravo')))?.reason ?? '', /names --session more than once/);
    assert.match((await verdict(bash('teamrig exec approve R1 --session zulu')))?.reason ?? '', /names --session zulu, no session of the team/);
  });

  it('refuses a teamrig call whose command or session is only known when it runs', async () => {
    for (const line of ['teamrig exec approve R1 --session "$WHO"', 'teamrig exec "$ACTION" R1 --session alpha', `node ${INSTALL}/dist/cli/main.js $(cat cmd) R1`]) {
      assert.match((await verdict(bash(line)))?.reason ?? '', /cannot tell whether it reviews a request, or as whom/, line);
    }
  });

  it('refuses a line whose shell reads its commands from a pipe, as they may review a request or act as the owner', async () => {
    const quiet = env();
    for (const payload of [
      bash('echo "teamrig exec approve R1 --session owner" | bash'),
      bash("printf 'teamrig owner next T1\\n' | sh"),
      bash('echo dGVhbXJpZw== | base64 -d | bash'),
      bash('cat cmd.txt | bash -s'),
      bash('echo "teamrig owner next T1" | env TERM=dumb bash'),
      bash('echo "teamrig owner next T1" | bash -c bash'),
      bash("bash -c 'echo x | sh'"),
      powershell("'teamrig owner next T1' | pwsh -Command -"),
      powershell("'teamrig owner next T1' | iex"),
      powershell("'teamrig owner next T1' | cmd"),
    ]) {
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.equal(
        found?.reason,
        'teamrig exec guard: a shell here reads its commands from a pipe, so the guard cannot tell whether they review a request or act as the owner; run them directly, or hand the shell a heredoc, which the guard reads.',
      );
    }
    assert.equal(quiet.reads(), 0);
    assert.equal(quiet.checks(), 0);
  });

  it('leaves a shell no pipe feeds, a pipe into a script file and a heredoc it reads to the normal flow', async () => {
    for (const line of ['bash --version', 'sh', 'git log | head -5', 'bash script.sh', 'echo x | bash script.sh', 'echo x | bash -c "cat"', 'bash <<EOF\nteamrig list\nEOF', 'cat <<EOF | bash\nteamrig list\nEOF']) {
      assert.equal(await verdict(bash(line)), undefined, line);
    }
    assert.equal(await verdict(powershell('iex')), undefined);
    assert.equal(await verdict(powershell('pwsh --version')), undefined);
    assert.match((await verdict(bash('cat <<EOF | bash\nteamrig exec approve R1 --session owner\nEOF')))?.reason ?? '', /names the owner \(--session owner\)/);
  });

  it('refuses a teamrig call whose first word is only known when it runs, as it may review as the owner or act as them', async () => {
    const quiet = env();
    for (const payload of [
      bash('teamrig "$G" approve R1 --session owner'),
      bash('teamrig $(echo exec) approve R1 --session owner'),
      bash('f(){ teamrig "$@"; }; f exec approve R1 --session owner'),
      bash('f(){ teamrig "$@"; }; f owner next T1'),
      bash('git status && TEAMRIG.cmd "$G" next T1'),
      powershell('teamrig $G approve R1 --session owner'),
      powershell('function f { teamrig @args }; f exec approve R1 --session owner'),
    ]) {
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      // A function's own words may start the CLI too, so `f exec approve ... --session owner` adds its review's reason (T3069).
      assert.ok(
        found?.reason.startsWith(
          'teamrig exec guard: a teamrig call here has a word only known when it runs (a variable or a substitution), so the guard cannot tell whether it reviews a request, or as whom; write the words out.',
        ),
        found?.reason,
      );
    }
    // Only the two calls of a function f, read as a possible CLI that reviews as the owner (T3069), read the tab and check f.
    assert.equal(quiet.reads(), 2);
    assert.equal(quiet.checks(), 2);
    for (const line of ['teamrig list --session "$S"', 'teamrig show "$T"', '$G list', 'git "$G" status', 'npm "$X" test', 'docker "$C" exec ctr ls', 'node "$S" list']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    for (const line of ['git $G status', '& $G list', 'npm $X test']) {
      assert.equal(await verdict(powershell(line), quiet), undefined, line);
    }
  });

  it('refuses every review from a tab bound to no session, saying why', async () => {
    const found = await verdict(bash('teamrig exec approve R1 --session alpha'), env({ kind: 'unbound', why: 'this tab is not bound to a session of the team' }));
    assert.equal(found?.decision, 'deny');
    assert.match(found?.reason ?? '', /reviews a request, and this tab is not bound to a session of the team, so the guard cannot tell who reviews\.$/);
  });

  it('refuses under asks off too, as a refusal is never a question', async () => {
    const asksOff = { ...env(), hookAsks: 'refuse' as const };
    assert.equal((await verdict(bash('teamrig exec approve R1 --session bravo'), asksOff))?.decision, 'deny');
  });

  it('reads the tab’s session only for a line that reviews', async () => {
    const quiet = env();
    for (const line of ['git status', 'teamrig exec request --session alpha --file r.json', 'teamrig exec status R1', 'teamrig exec run R1 --session alpha', 'teamrig list']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.equal(quiet.reads(), 0);
    assert.equal(await execGuardOutput({ tool_name: 'Read', tool_input: { file_path: 'x' } }, quiet), '');
    assert.equal(await execGuardOutput('not a payload', quiet), '');
  });

  it('refuses every exec call, whatever its command, while the client differs from its build, naming at most five files', async () => {
    const paths = ['bin/teamrig', 'dist/cli/main.js', 'dist/exec/exec.js', 'dist/exec/run.js', 'dist/hooks/exec-guard.js', 'hooks/hooks.json', 'dist/core/files.js'];
    const patched = env(ALPHA, { kind: 'changed', paths });
    for (const line of ['teamrig exec status R1', 'teamrig exec run R1 --session alpha', 'teamrig exec', 'teamrig exec approve R1 --session alpha']) {
      const found = await verdict(bash(line), patched);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', /the teamrig client was changed after its build \(bin\/teamrig, dist\/cli\/main\.js, dist\/exec\/exec\.js, dist\/exec\/run\.js, dist\/hooks\/exec-guard\.js and 2 more\); reinstall the teamrig plugin or ask security\./, line);
    }
    const unlisted = await verdict(bash('teamrig exec request --session alpha --file r.json'), env(ALPHA, { kind: 'no-manifest', why: 'dist/integrity.json is missing' }));
    assert.match(unlisted?.reason ?? '', /the teamrig client cannot be checked against its build \(dist\/integrity\.json is missing\), so it may have been changed/);
  });

  it('gives both reasons when a changed client runs a review as another session, and checks the client once per line', async () => {
    const patched = env(ALPHA, { kind: 'changed', paths: ['bin/teamrig'] });
    const found = await verdict(bash('teamrig exec status R1 && teamrig exec approve R1 --session bravo'), patched);
    assert.match(found?.reason ?? '', /changed after its build \(bin\/teamrig\);.* names --session bravo, but this tab is alpha's/);
    assert.equal(patched.checks(), 1);
  });

  it('checks the client only for a line that runs teamrig exec', async () => {
    const quiet = env(ALPHA, { kind: 'changed', paths: ['bin/teamrig'] });
    for (const line of ['git status', 'teamrig list', 'teamrig start --session alpha']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.match((await verdict(bash('teamrig exec "$ACTION" R1'), quiet))?.reason ?? '', /cannot tell whether it reviews a request/);
    assert.equal(quiet.checks(), 0);
  });

  it('checks the hook’s own install for a bare teamrig the shell’s PATH search finds nowhere, as the Bash tool appends its bin last', async () => {
    const quiet = env();
    assert.equal(await verdict(bash('teamrig exec status R1'), quiet), undefined);
    assert.deepEqual(quiet.checked(), [INSTALL]);
  });

  it('refuses an exec call that starts a file no install of the plugin has, naming the file and the plugin’s own client', async () => {
    const own = `run the plugin's own \\(${INSTALL.replaceAll('.', '\\.')}/bin/teamrig\\)\\.`;
    for (const [line, file] of [
      ['C:/kit/bin/teamrig exec status R1', 'C:[\\\\/]kit[\\\\/]bin[\\\\/]teamrig'],
      ['/c/kit/bin/teamrig exec status R1', 'C:[\\\\/]kit[\\\\/]bin[\\\\/]teamrig'],
      ['node C:/kit/dist/cli/main.js exec approve R1 --session alpha', 'C:[\\\\/]kit[\\\\/]dist[\\\\/]cli[\\\\/]main\\.js'],
      ['cd C:/kit && ./bin/teamrig exec status R1', 'C:[\\\\/]kit[\\\\/]bin[\\\\/]teamrig'],
      [`${CACHE}/patched/bin/teamrig exec status R1`, 'C:[\\\\/]u[\\\\/].*[\\\\/]patched[\\\\/]bin[\\\\/]teamrig'],
    ] as const) {
      const quiet = env();
      const found = await verdict(bash(line), quiet);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', new RegExp(`^teamrig exec guard: \`teamrig exec\` here starts ${file}, no install of the teamrig plugin; ${own}$`), line);
      assert.equal(quiet.checks(), 0, line);
    }
    const ps1 = await verdict(powershell(`& '${INSTALL}/bin/teamrig.ps1' exec status R1`));
    assert.match(ps1?.reason ?? '', /teamrig\.ps1, no install of the teamrig plugin/, 'a launcher the build does not hash');
  });

  it('takes the Git Bash spelling of the hook’s own install as that install', async () => {
    const quiet = env();
    assert.equal(await verdict(bash('/c/u/.claude/plugins/cache/teamrig/teamrig/0.156.0/bin/teamrig exec status R1'), quiet), undefined);
    assert.deepEqual(quiet.checked(), [INSTALL]);
  });

  it('refuses the teamrig the shell finds on PATH when no install of the plugin has it', async () => {
    const shadowed = env(ALPHA, INTACT, { found: { teamrig: 'C:/u/bin/teamrig' } });
    const found = await verdict(bash('teamrig exec approve R1 --session alpha'), shadowed);
    assert.equal(found?.decision, 'deny');
    assert.match(found?.reason ?? '', /the `teamrig` this line's shell finds on PATH is C:\/u\/bin\/teamrig, no install of the teamrig plugin; remove it from PATH, or run the plugin's own \(.*0\.156\.0\/bin\/teamrig\)\./);
    assert.equal(await verdict(bash('teamrig list'), shadowed), undefined, 'only exec calls are pinned');
  });

  it('checks an older version the shell finds on PATH as its own install, naming it when it was changed', async () => {
    const older = env(ALPHA, INTACT, { found: { teamrig: `${OLDER}/bin/teamrig` } });
    assert.equal(await verdict(bash('teamrig exec status R1'), older), undefined);
    assert.deepEqual(older.checked(), [OLDER]);
    const patched = env(ALPHA, INTACT, { found: { teamrig: `${OLDER}/bin/teamrig` }, others: { [OLDER]: { kind: 'changed', paths: ['bin/teamrig'] } } });
    const found = await verdict(bash('teamrig exec status R1'), patched);
    assert.match(
      found?.reason ?? '',
      /the teamrig client at C:\/u\/\.claude\/plugins\/cache\/teamrig\/teamrig\/0\.152\.0 was changed after its build \(bin\/teamrig\); run the plugin's own \(.*0\.156\.0\/bin\/teamrig\), or ask security\./,
    );
  });

  it('checks each install a line starts once', async () => {
    const quiet = env();
    const line = `teamrig exec status R1 && ${INSTALL}/bin/teamrig exec status R2 && ${OLDER}/bin/teamrig.cmd exec status R3 && teamrig exec status R4`;
    assert.equal(await verdict(bash(line), quiet), undefined);
    assert.deepEqual(quiet.checked(), [INSTALL, OLDER]);
  });

  it('refuses a relative client path from a folder only known when the line runs', async () => {
    const found = await verdict(bash('cd "$KIT" && ./bin/teamrig exec status R1'));
    assert.match(found?.reason ?? '', /starts its client by a relative path \(\.\/bin\/teamrig\) from a folder only known when the line runs; write its full path\./);
  });

  it('refuses an exec call through a program only known when it runs, and no other command such a program runs', async () => {
    const quiet = env();
    for (const [line, word] of [
      ['$T exec approve R1 --session alpha', '\\$T'],
      ['"$KIT/bin/teamrig" exec status R1', '\\$KIT/bin/teamrig'],
      ['$T exec "$ACTION" R1', '\\$T'],
      ['node $SCRIPT exec run R1', '\\$SCRIPT'],
      ['node "$KIT/dist/cli/main.js" exec status R1', '\\$KIT/dist/cli/main\\.js'],
      ['npx "$P" exec status R1', '\\$P'],
      ['pnpm dlx --silent $P exec approve R1', '\\$P'],
    ] as const) {
      const found = await verdict(bash(line), quiet);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', new RegExp(`here starts a program only known when it runs \\(${word}\\), so the guard cannot tell which client runs it; write it out`), line);
    }
    for (const line of ['$DOCKER exec ctr ls', '$T list', '$T exec', 'node $SCRIPT build', 'node $SCRIPT exec', 'npx "$P" build', 'npm run "$S"']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.equal(quiet.checks(), 0);
  });

  it('knows every teamrig exec command the CLI has, so a call through an unknown program reads as one', () => {
    const commands = Object.keys(COMMAND_EFFECTS).filter((name) => name.startsWith('exec ')).map((name) => name.slice('exec '.length));
    assert.deepEqual([...EXEC_COMMANDS].sort(), commands.sort());
  });

  it('refuses every teamrig owner call from a tool call, wherever the line runs it, without reading the tab or checking a client', async () => {
    const quiet = env();
    for (const [payload, command] of [
      [bash('teamrig owner note T1 --text "drop it"'), 'teamrig owner note'],
      [bash('git status && teamrig owner next T1'), 'teamrig owner next'],
      [bash("bash -c 'teamrig owner next T1'"), 'teamrig owner next'],
      [bash('teamrig queue -- teamrig owner note T1 --text go'), 'teamrig owner note'],
      [bash(`node ${INSTALL}/dist/cli/main.js owner next T1 --preview`), 'teamrig owner next'],
      [bash('C:/kit/bin/teamrig owner next T1'), 'teamrig owner next'],
      [powershell('teamrig owner next web/T1'), 'teamrig owner next'],
      [bash('teamrig owner wake web/front'), 'teamrig owner wake'],
      [bash('teamrig owner "$ACTION" T1'), 'teamrig owner'],
      [bash('teamrig owner'), 'teamrig owner'],
    ] as const) {
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', command);
      assert.equal(
        found?.reason,
        `teamrig exec guard: \`${command}\` acts as the owner; the owner runs it from the pane or their own terminal, or types \`/${command} ...\` in a tab, never through a tool call.`,
      );
    }
    assert.equal(quiet.reads(), 0);
    assert.equal(quiet.checks(), 0);
  });

  it('refuses a teamrig owner call through a program only known when it runs, and no other command such a program runs', async () => {
    const quiet = env();
    for (const [line, command] of [
      ['$T owner note T1 --text go', 'teamrig owner note'],
      ['"$KIT/bin/teamrig" owner next T1', 'teamrig owner next'],
      ['$T owner "$ACTION" T1', 'teamrig owner'],
      ['node $SCRIPT owner next T1', 'teamrig owner next'],
      ['$T owner wake alpha', 'teamrig owner wake'],
    ] as const) {
      assert.match((await verdict(bash(line), quiet))?.reason ?? '', new RegExp(`^teamrig exec guard: \`${command}\` acts as the owner;`), line);
    }
    for (const line of ['$T owner', '$X owner list', 'node $SCRIPT owner', 'teamrig help owner note', 'teamrig list --owner alpha']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.equal(quiet.checks(), 0);
  });

  it('refuses a teamrig owner call through a Windows shim, in any case, by PowerShell’s call operator, or in a line a shell evaluates', async () => {
    const quiet = env();
    for (const [payload, command] of [
      [bash('teamrig.cmd owner next T1'), 'teamrig owner next'],
      [bash('TEAMRIG owner next T1'), 'teamrig owner next'],
      [bash('eval "teamrig owner next T1"'), 'teamrig owner next'],
      [bash('eval teamrig owner note T1 --text go'), 'teamrig owner note'],
      [powershell('teamrig.cmd owner next T1'), 'teamrig owner next'],
      [powershell('Teamrig.Cmd owner next T1'), 'teamrig owner next'],
      [powershell('& teamrig owner next T1'), 'teamrig owner next'],
      [powershell('& "C:/kit/bin/teamrig.ps1" owner next T1'), 'teamrig owner next'],
      [powershell('& C:/kit/bin/teamrig.cmd owner note T1 --text go'), 'teamrig owner note'],
      [powershell('Invoke-Expression "teamrig owner next T1"'), 'teamrig owner next'],
      [powershell("iex 'teamrig owner next T1'"), 'teamrig owner next'],
    ] as const) {
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.match(found?.reason ?? '', new RegExp(`^teamrig exec guard: \`${command}\` acts as the owner;`), JSON.stringify(payload));
    }
    assert.equal(quiet.checks(), 0);
  });

  it('reads the command where the CLI does: a flag before it, or a command line after exec request, is a line the CLI refuses', async () => {
    const parse = (argv: readonly string[]): unknown => parseArgs(argv, COMMAND_TABLE.flags, COMMAND_TABLE.switches, COMMAND_TABLE.renamed, COMMAND_TABLE.rest);
    for (const line of ['teamrig --session alpha owner next T1', 'teamrig --session owner exec approve R1', 'teamrig exec request -- teamrig owner next T1']) {
      assert.throws(() => parse(line.split(' ').slice(1)), UsageError, line);
      assert.equal(await verdict(bash(line)), undefined, line);
    }
  });

  it('refuses every settings writer run with --yes from a tool call, whatever its client, without reading the tab or checking a client (T3083)', async () => {
    const quiet = env();
    for (const [payload, command] of [
      [bash('teamrig permissions trim --yes'), 'permissions trim'],
      [bash('teamrig permissions trim --all --yes'), 'permissions trim'],
      [bash('teamrig automode install --yes'), 'automode install'],
      [bash('teamrig automode uninstall --yes'), 'automode uninstall'],
      [bash('git status && teamrig statusline install --yes'), 'statusline install'],
      [bash('teamrig setup restore --yes --remove-new'), 'setup restore'],
      [bash('teamrig config migrate --yes'), 'config migrate'],
      [bash('teamrig restore install --yes'), 'restore install'],
      [bash("bash -c 'teamrig automode install --yes'"), 'automode install'],
      [bash(`node ${INSTALL}/dist/cli/main.js permissions trim --yes`), 'permissions trim'],
      [powershell('teamrig.cmd statusline install --yes'), 'statusline install'],
      [bash('teamrig permissions trim "$FLAG"'), 'permissions trim'],
      [bash('teamrig automode "$WHAT" --yes'), 'automode'],
      [bash('$T permissions trim --yes'), 'permissions trim'],
      [bash('$T --verbose permissions trim --yes'), 'permissions trim'],
      [bash('echo teamrig permissions trim --yes'), 'permissions trim'],
      [bash('node $SCRIPT automode install --yes'), 'automode install'],
    ] as const) {
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.equal(found?.reason, `teamrig exec guard: ${settingsWriteRefusal(command)}`, JSON.stringify(payload));
    }
    assert.equal(quiet.reads(), 0);
    assert.equal(quiet.checks(), 0);
  });

  it("leaves a settings writer's preview, and the commands beside the writers, to the normal flow", async () => {
    const quiet = env();
    for (const line of [
      'teamrig permissions trim',
      'teamrig permissions trim --all',
      'teamrig statusline install',
      'teamrig automode status',
      'teamrig config get roles',
      'teamrig config validate',
      'teamrig setup backup',
      '$T permissions trim',
      'echo "teamrig permissions trim --yes"',
    ]) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
  });

  it('reads teamrig started through its guard entry, any script host or a package runner as the CLI (T3069)', async () => {
    const quiet = env();
    for (const line of [
      `node ${INSTALL}/dist/cli/guard-main.js owner next T1`,
      'npx tsx src/cli/main.ts owner next T1',
      'tsx src/cli/main.ts owner next T1',
      'bun src/cli/main.ts owner next T1',
      'npx teamrig owner next T1',
      'npx --yes teamrig@latest owner next T1',
      'pnpm exec teamrig owner next T1',
      'pnpm dlx teamrig owner next T1',
      'yarn teamrig owner next T1',
      'bunx teamrig owner next T1',
      'npm exec -- teamrig owner next T1',
    ]) {
      assert.equal((await verdict(bash(line), quiet))?.decision, 'deny', line);
    }
    const runner = await verdict(bash('npx teamrig exec status R1'), quiet);
    assert.equal(runner?.decision, 'deny');
    assert.match(runner?.reason ?? '', /runs through a package runner \(npx\)/);
    for (const line of ['npx tsc --noEmit', 'npm run check', 'pnpm exec teamrig list', 'yarn add teamrig', 'git log -- src/cli/main.ts']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
  });

  it('refuses teamrig that a package runner or a version manager starts, in a shell it starts too, as its PATH finds it (T3069)', async () => {
    const quiet = env();
    for (const [line, runner] of [
      ['npx -c "teamrig exec approve R1 --session alpha"', 'npx'],
      ['npx --call="teamrig exec approve R1 --session alpha"', 'npx'],
      ['npm exec -c "teamrig exec status R1"', 'npm'],
      ['npm x --call "teamrig exec status R1"', 'npm'],
      ['npx bash -c "teamrig exec approve R1 --session alpha"', 'npx'],
      ['C:/nodejs/npx.cmd sh -c "teamrig exec status R1"', 'C:/nodejs/npx\\.cmd'],
      ['pnpm exec sh -c "teamrig exec status R1"', 'pnpm'],
      ['pnpm exec -c teamrig exec status R1', 'pnpm'],
      ['pnpm dlx -c "teamrig exec status R1"', 'pnpm'],
      ['pnpx --shell-mode "teamrig exec status R1"', 'pnpx'],
      ['yarn exec bash -c "teamrig exec status R1"', 'yarn'],
      ['yarn run bash -c "teamrig exec status R1"', 'yarn'],
      ['pnpm sh -c "teamrig exec status R1"', 'pnpm'],
      ['bunx bash -c "teamrig exec status R1"', 'bunx'],
      ['corepack npx teamrig exec status R1', 'corepack'],
      ['corepack pnpm@9 exec sh -c "teamrig exec status R1"', 'corepack'],
      ['volta run --node 20 teamrig exec status R1', 'volta'],
      ['fnm exec --using 20 teamrig exec status R1', 'fnm'],
      ['nvm exec 20 teamrig exec status R1', 'nvm'],
    ] as const) {
      const found = await verdict(bash(line), quiet);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', new RegExp(`runs through a package runner \\(${runner}\\), which may find or fetch a teamrig other than`), line);
    }
    assert.equal((await verdict(bash('npx -c "teamrig owner next T1"'), quiet))?.decision, 'deny');
    assert.equal((await verdict(powershell('npx.cmd -c "teamrig exec status R1"'), quiet))?.decision, 'deny');
    for (const line of ['npx -c "tsc --noEmit"', 'npx bash -c "teamrig list"', 'volta run node -v', 'nvm exec 20 node -v', 'pnpm sh -c "npm test"']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.equal(quiet.checks(), 0);
  });

  it("reads a package runner's shell line in every shell the line or an .npmrc may pick for it", async () => {
    const quiet = env();
    for (const line of [
      `npx --script-shell=bash -c "teamrig e''xec approve R1 --session alpha"`,
      `npm_config_script_shell=bash npx -c "teamrig e''xec approve R1 --session alpha"`,
      `npm --script-shell bash exec -c "teamrig e''xec status R1"`,
      'npx -c "teamrig e^xec approve R1 --session alpha"',
      `pnpm exec -c "teamrig e''xec status R1"`,
      'yarn exec "teamrig exec status R1"',
      'bun exec "teamrig exec status R1"',
    ]) {
      const found = await verdict(bash(line), quiet);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', /runs through a package runner/, line);
    }
    assert.equal(quiet.checks(), 0);
  });

  it('refuses a package runner whose shell line goes to a shell the line names that the guard cannot read', async () => {
    const quiet = env();
    for (const line of ['npx --script-shell=node -c "x"', 'npm_config_script_shell=python3 npx -c "x"', 'ComSpec=C:/tools/run.exe npm exec -c "x"', 'npx --script-shell "$S" -c "x"']) {
      const found = await verdict(bash(line), quiet);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', /hands its command line to a shell the line names/, line);
    }
    for (const line of ['npx --script-shell=bash -c "tsc --noEmit"', 'ComSpec=C:/Windows/System32/cmd.exe npx -c "tsc"', 'npx --script-shell=pwsh -c "tsc"']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.equal(quiet.checks(), 0);
  });

  it('reads an entry script named without its extension, or with a module one, as the CLI (T3069)', async () => {
    const quiet = env();
    for (const line of [
      `node ${INSTALL}/dist/cli/main owner next T1`,
      `node ${INSTALL}/dist/cli/guard-main owner next T1`,
      `node ${INSTALL}/dist/cli/main.mjs owner next T1`,
      `node ${INSTALL}/dist/cli/main.cjs owner next T1`,
    ]) {
      assert.equal((await verdict(bash(line), quiet))?.decision, 'deny', line);
    }
    // Even as the tab itself: the file named is no entry the install hashed (CLIENT_ENTRIES), so it is refused.
    for (const session of ['bravo', 'alpha']) {
      const review = await verdict(bash(`node ${INSTALL}/dist/cli/main exec approve R1 --session ${session}`), quiet);
      assert.equal(review?.decision, 'deny', session);
      assert.match(review?.reason ?? '', /dist\\cli\\main, no install of the teamrig plugin/, session);
    }
    assert.equal(await verdict(bash(`node ${INSTALL}/dist/cli/main.js exec approve R1 --session alpha`), quiet), undefined);
    assert.equal(await verdict(bash('git log -- src/cli/main'), quiet), undefined);
  });

  it('reads any program whose later words start a guarded command as the CLI, whatever it is named (T3069)', async () => {
    const quiet = env();
    for (const line of [
      'node C:/tmp/x.js exec approve R1 --session alpha',
      './x exec approve R1 --session alpha',
      'python run.py exec status R1',
      '$K x exec approve R1 --session alpha',
    ]) {
      const found = await verdict(bash(line), quiet);
      assert.equal(found?.decision, 'deny', line);
      assert.match(found?.reason ?? '', /no install of the teamrig plugin|only known when it runs/, line);
    }
    const fetched = await verdict(bash('npx git+https://x/teamrig.git exec status R1'), quiet);
    assert.match(fetched?.reason ?? '', /runs through a package runner \(npx\)/);
    for (const line of ['node C:/tmp/x.js owner next T1', './x owner note T1 --text x']) {
      assert.match((await verdict(bash(line), quiet))?.reason ?? '', /acts as the owner/, line);
    }
    assert.match((await verdict(powershell('& C:/tmp/x.ps1 exec approve R1 --session alpha'), quiet))?.reason ?? '', /no install of the teamrig plugin/);
    // A subcommand known only when it runs counts only after teamrig's own name, so other programs' exec stays theirs.
    for (const line of ['kubectl exec "$POD" -- ls', 'docker compose exec "$S" sh', 'kubectl exec pod -- ls', 'npm exec "$X"', 'echo hi', 'git grep "exec approve"']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
  });

  it('knows every teamrig owner command the CLI has, so a call through an unknown program reads as one', () => {
    const commands = Object.keys(COMMAND_EFFECTS).filter((name) => name.startsWith('owner ')).map((name) => name.slice('owner '.length));
    assert.deepEqual([...OWNER_COMMANDS].sort(), commands.sort());
  });

  it('refuses every teamrig hook call from a tool call, however it starts the CLI, without reading the tab or checking a client (T3081)', async () => {
    const quiet = env();
    const typed = `echo '{"origin":"composer","args":"exec approve R1 --session lead"}' | `;
    for (const [payload, command] of [
      [bash(`${typed}teamrig hook slash-command`), 'teamrig hook slash-command'],
      [bash(`${typed}env -u TERM teamrig hook slash-command`), 'teamrig hook slash-command'],
      [bash('teamrig hook session-start < start.json'), 'teamrig hook session-start'],
      [bash('git status && teamrig hook inbox-reminder < prompt.json'), 'teamrig hook inbox-reminder'],
      [bash("bash -c 'teamrig hook slash-command < typed.json'"), 'teamrig hook slash-command'],
      [bash('teamrig queue -- teamrig hook slash-command'), 'teamrig hook slash-command'],
      [bash(`node ${INSTALL}/dist/cli/guard-main.js hook slash-command < typed.json`), 'teamrig hook slash-command'],
      [bash(`node ${INSTALL}/dist/cli/main.js hook picker-guard < payload.json`), 'teamrig hook picker-guard'],
      [bash('npx teamrig hook session-start'), 'teamrig hook session-start'],
      [powershell("'{}' | teamrig.cmd hook slash-command"), 'teamrig hook slash-command'],
      [powershell('& "C:/kit/bin/teamrig.ps1" hook session-start'), 'teamrig hook session-start'],
      [bash('teamrig hook "$H"'), 'teamrig hook'],
      [bash('teamrig hook'), 'teamrig hook'],
    ] as const) {
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.equal(
        found?.reason,
        `teamrig exec guard: \`${command}\` takes the tab and who typed the line from its stdin, which a tool call writes, so only Claude Code's hooks ` +
          `and the teamrig mod run it, never a tool call; prove a hook in a test, or by a script on a scratch kit home.`,
        JSON.stringify(payload),
      );
    }
    assert.equal(quiet.reads(), 0);
    assert.equal(quiet.checks(), 0);
    const cleared = await verdict(bash(`${typed}env -u CLAUDECODE teamrig hook slash-command`), quiet);
    assert.equal(cleared?.decision, 'deny');
    assert.match(cleared.reason, /changes \$CLAUDECODE.*`teamrig hook slash-command` takes the tab/);
  });

  it('refuses a teamrig hook call through a program only known when it runs, and no other hook command such a program runs', async () => {
    const quiet = env();
    for (const [line, command] of [
      ['$T hook slash-command', 'teamrig hook slash-command'],
      ['node $SCRIPT hook session-start', 'teamrig hook session-start'],
      ['npx "$P" hook inbox-reminder', 'teamrig hook inbox-reminder'],
      ['$T hook "$H"', 'teamrig hook'],
    ] as const) {
      assert.match((await verdict(bash(line), quiet))?.reason ?? '', new RegExp(`^teamrig exec guard: \`${command}\` takes the tab`), line);
    }
    for (const line of ['$GIT hook run pre-commit', 'git hook run pre-commit', 'node $SCRIPT hook', 'teamrig help hook', 'teamrig doctor --hooks']) {
      assert.equal(await verdict(bash(line), quiet), undefined, line);
    }
    assert.equal(quiet.checks(), 0);
  });

  it('knows every teamrig hook command the CLI has, so a call through an unknown program reads as one', () => {
    const commands = Object.keys(COMMAND_EFFECTS).filter((name) => name.startsWith('hook ')).map((name) => name.slice('hook '.length));
    assert.deepEqual([...HOOK_COMMANDS].sort(), commands.sort());
  });
});

describe('execGuardOutput: a Bash line on Windows (T2319)', () => {
  /** A run of n backslashes; on Windows bash receives each run not before a double quote halved, rounded up. */
  const bs = (n: number): string => '\\'.repeat(n);
  const windows = (): ReturnType<typeof env> => ({ ...env(), platform: 'win32' });
  const hiddenSeparator = (command: string): string => `echo a${bs(3)}; ${command}`;
  const hiddenBacktick = (command: string): string => `echo "p${bs(3)}\`${command}; echo ${bs(3)}\`q"`;

  it('refuses an owner call, a review as another session and a fed shell that bash runs behind what the line as written escapes', async () => {
    const owner = 'teamrig exec guard: `teamrig owner note` acts as the owner';
    const review = "teamrig exec guard: `teamrig exec approve` names --session bravo, but this tab is alpha's";
    const fed = 'teamrig exec guard: a shell here reads its commands from a pipe';
    for (const [line, reason] of [
      [hiddenBacktick('teamrig owner note T1 --text x'), owner],
      [hiddenBacktick('teamrig exec approve R1 --session bravo'), review],
    ] as const) {
      const found = await verdict(bash(line), windows());
      assert.equal(found?.decision, 'deny', line);
      assert.ok(found?.reason.startsWith(reason), `${line}: ${found?.reason ?? ''}`);
      assert.equal(await verdict(bash(line)), undefined, `off Windows bash runs the line as written: ${line}`);
    }
    // As written, echo takes the words of these as its own, which the guard reads as a possible CLI too (T3069).
    for (const [line, reason] of [
      [hiddenSeparator('teamrig owner note T1 --text x'), owner],
      [hiddenSeparator('teamrig exec approve R1 --session bravo'), review],
      [`echo teamrig owner next T1 ${bs(3)}| bash`, fed],
    ] as const) {
      const found = await verdict(bash(line), windows());
      assert.equal(found?.decision, 'deny', line);
      // The guard joins its reasons after one prefix, so each reason is found by what follows it.
      assert.ok(found?.reason.includes(reason.replace('teamrig exec guard: ', '')), `${line}: ${found?.reason ?? ''}`);
    }
  });

  it('leaves a line whose readings run no guarded call, or review only as the tab, and checks its client and reads the tab once', async () => {
    for (const line of [`grep 'a${bs(4)}b' f`, hiddenSeparator('git status'), hiddenBacktick('teamrig exec approve R1 --session alpha')]) {
      assert.equal(await verdict(bash(line), windows()), undefined, line);
    }
    const quiet = windows();
    assert.equal(await verdict(bash(`teamrig exec approve R1 --session alpha --note 'a${bs(2)}b'`), quiet), undefined);
    assert.equal(quiet.reads(), 1);
    assert.deepEqual(quiet.checked(), [INSTALL]);
  });
});

describe('execGuardOutput, binding the tab to a session', () => {
  const UNBOUND: TabIdentity = { kind: 'unbound', why: 'this tab is not bound to a session of the team' };

  it('refuses a start or inbox read naming another session of the team, through any client', async () => {
    for (const payload of [
      bash('teamrig start --session bravo'),
      bash('teamrig inbox read --session bravo'),
      bash('teamrig inbox read --session lead --wait'),
      bash('npx teamrig start --session bravo'),
      bash('node ./copy/main.js inbox read --session bravo'),
      bash('bash -c "teamrig start --session bravo"'),
      powershell('& teamrig.cmd start --session bravo'),
    ]) {
      const found = await verdict(payload);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.match(found.reason, /names --session (bravo|lead), but this tab is alpha's/);
    }
  });

  it("passes the tab's own session, by id or by a name it has had, and a session the team has not", async () => {
    for (const command of ['teamrig start --session alpha', 'teamrig inbox read --session app-alpha', 'teamrig start --session nobody']) {
      assert.equal(await verdict(bash(command)), undefined, command);
    }
  });

  it('refuses another session with the Claude Code variable cleared, for both reasons', async () => {
    for (const payload of [
      bash('env -u CLAUDECODE teamrig inbox read --session bravo'),
      bash('CLAUDECODE= teamrig start --session bravo'),
      bash('env -i PATH=/usr/bin teamrig inbox read --session bravo'),
      powershell("$env:CLAUDECODE=''; teamrig start --session bravo"),
    ]) {
      const found = await verdict(payload);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.match(found.reason, /changes \$CLAUDECODE.*names --session bravo, but this tab is alpha's/);
    }
  });

  it('lets a tab no mark binds yet bind to any session', async () => {
    assert.equal(await verdict(bash('teamrig start --session bravo'), env(UNBOUND)), undefined);
  });

  it('refuses a bind whose session is only known when it runs, or that a changed session variable steers', async () => {
    for (const payload of [
      bash('teamrig start --session "$S"'),
      bash('teamrig inbox "$C" --session bravo'),
      bash('TEAMRIG_SESSION=bravo teamrig start'),
      bash('export TEAMRIG_SESSION=bravo; teamrig inbox read'),
      bash('env CLAUDE_CODE_SESSION_ID=00000000-0000-0000-0000-000000000000 teamrig start'),
      powershell("$env:TEAMRIG_SESSION = 'bravo'; teamrig start"),
    ]) {
      assert.equal((await verdict(payload))?.decision, 'deny', JSON.stringify(payload));
    }
  });

  it('reads the identity only for a bind that names a session or runs on a line that steers one', async () => {
    const quiet = env();
    assert.equal(await verdict(bash('teamrig start'), quiet), undefined);
    assert.equal(await verdict(bash('teamrig inbox read'), quiet), undefined);
    assert.equal(await verdict(bash('teamrig inbox add --to bravo --text hi'), quiet), undefined);
    assert.equal(quiet.reads(), 0);
    assert.equal(await verdict(bash('teamrig start --session alpha'), quiet), undefined);
    assert.equal(quiet.reads(), 1);
  });

  it('passes a line that only mentions the words', async () => {
    assert.equal(await verdict(bash('echo "teamrig start --session bravo"')), undefined);
    assert.equal(await verdict(bash('npm start')), undefined);
  });
});

describe('execGuardOutput, the variable Claude Code marks its tool calls with', () => {
  it('refuses a line that clears CLAUDECODE, in any shell, without reading the identity', async () => {
    for (const payload of [
      bash('env -u CLAUDECODE teamrig inbox read'),
      bash('CLAUDECODE= teamrig start'),
      bash('env -i PATH=/usr/bin teamrig list'),
      bash('unset CLAUDECODE'),
      bash('export -n CLAUDECODE && teamrig list'),
      powershell("$env:CLAUDECODE=''; teamrig start"),
      powershell('Remove-Item Env:CLAUDECODE'),
      powershell("[Environment]::SetEnvironmentVariable('CLAUDECODE', $null)"),
    ]) {
      const quiet = env();
      const found = await verdict(payload, quiet);
      assert.equal(found?.decision, 'deny', JSON.stringify(payload));
      assert.match(found.reason, /changes \$CLAUDECODE/);
      assert.equal(quiet.reads(), 0);
    }
  });

  it('passes a line that reads it', async () => {
    assert.equal(await verdict(bash('echo "$CLAUDECODE"')), undefined);
    assert.equal(await verdict(powershell('Write-Output $env:CLAUDECODE')), undefined);
  });
});
