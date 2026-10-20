import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import type { ClientCheck } from '../exec/client-integrity.ts';
import { execGuardOutput, type ExecGuardEnv, type TabIdentity } from './exec-guard.ts';

const SESSIONS: Readonly<Record<string, string>> = { alpha: 'alpha', 'app-alpha': 'alpha', bravo: 'bravo', lead: 'lead' };

const ALPHA: TabIdentity = { kind: 'bound', session: 'alpha', owner: 'owner', idOf: (name) => SESSIONS[name] };

const INTACT: ClientCheck = { kind: 'intact' };

/** An env whose identity and client reads count, so a test can show the guard reads each only for a line that needs it. */
function env(identity: TabIdentity = ALPHA, client: ClientCheck = INTACT): ExecGuardEnv & { readonly reads: () => number; readonly checks: () => number } {
  let reads = 0;
  let checks = 0;
  return {
    cwd: 'C:/w',
    home: 'C:/u',
    hookAsks: 'ask',
    identity: () => {
      reads += 1;
      return Promise.resolve(identity);
    },
    client: () => {
      checks += 1;
      return Promise.resolve(client);
    },
    reads: () => reads,
    checks: () => checks,
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
      'teamrig heavy -- teamrig exec approve R1 --session bravo',
      'C:/x/bin/teamrig.cmd exec approve R1 --session bravo',
      'node --disable-warning=ExperimentalWarning C:/x/dist/cli/main.js exec approve R1 --session bravo',
      'T=C:/x/bin/teamrig; $T exec approve R1 --session bravo',
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
    for (const line of ['teamrig exec approve R1 --session "$WHO"', 'teamrig exec "$ACTION" R1 --session alpha', 'node C:/x/dist/cli/main.js $(cat cmd) R1']) {
      assert.match((await verdict(bash(line)))?.reason ?? '', /cannot tell whether it reviews a request, or as whom/, line);
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
});
