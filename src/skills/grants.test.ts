import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { grantGaps, grantsMadeBy, grantsOf, isSkillScript } from './grants.ts';

function made(text: string): string[] {
  return grantsMadeBy({ name: 'run.ts', text });
}

describe('grantsMadeBy', () => {
  it('sees kubectl exec written inline or as an argv item', () => {
    assert.deepEqual(made('kubectl -n pipeline exec deploy/worker -- ls'), ['pod-exec']);
    assert.deepEqual(made("execFileSync('kubectl', [\n  'exec', '-n', 'x', 'deploy/metrics', '--', 'wget', url,\n]);"), ['pod-exec']);
  });

  it('passes an exec that is not kubectl: a local container, the child_process function', () => {
    assert.deepEqual(made("execFileSync('docker', ['exec', CONTAINER, 'nginx', '-t']);"), []);
    assert.deepEqual(made("import { exec } from 'node:child_process';\nexec('kubectl get pods');"), []);
  });

  it('sees a credential read: a cluster secret, or an env variable named like one, in each language', () => {
    assert.deepEqual(made('kubectl get secret api-env -o json'), ['secret-read']);
    assert.deepEqual(made("spawnSync('kubectl', ['get', 'secrets', '-n', 'x'])"), ['secret-read']);
    for (const read of ['echo "$API_TOKEN"', 'echo "${DB_PASSWORD}"', '$env:CLIENT_SECRET', 'process.env.DATABASE_URI_LOCAL', "process.env['GITHUB_TOKEN']", "os.environ['AWS_SECRET_ACCESS_KEY']", "os.getenv('REDIS_PASS')"]) {
      assert.deepEqual(made(read), ['secret-read'], read);
    }
  });

  it('passes env variables that hold no credential and lower-case template values', () => {
    assert.deepEqual(made('process.env.HOME; $PATH; ${PWD}; process.env.TEAMRIG_TEAM; `${key}`; $env:BYPASS_COUNT'), []);
  });

  it('sees a credential header in any spelling', () => {
    for (const header of ['-H "Authorization: Bearer x"', "headers: { authorization: token }", '--header "x-api-key: k"', "{ 'X-Auth-Token': t }"]) {
      assert.deepEqual(made(header), ['auth-header'], header);
    }
  });

  it('lists the kinds in their fixed order', () => {
    assert.deepEqual(made('wget --header "x-service-key: $SERVICE_KEY"; kubectl exec w -- sh'), ['pod-exec', 'secret-read', 'auth-header']);
  });
});

describe('grantsOf', () => {
  it('reads every Grants line, split on commas or spaces, and keeps the words that name no kind', () => {
    const { declared, unknown } = grantsOf('Owner: alpha\r\nGrants: pod-exec, secret-read\r\nGrants:  auth-header kubectl\r\nNo Grants: here');
    assert.deepEqual([...declared], ['pod-exec', 'secret-read', 'auth-header']);
    assert.deepEqual(unknown, ['kubectl']);
  });
});

describe('grantGaps', () => {
  it('names each missing kind once with every script that makes it, and nothing when all are granted', () => {
    const scripts = [
      { name: 'a.js', text: 'kubectl exec w -- ls' },
      { name: 'b.js', text: 'kubectl exec w -- ps' },
    ];
    assert.deepEqual(grantGaps('Owner: alpha', scripts), [
      'pod-exec in a.js, b.js, which auto mode does not see: with the owner\'s grant add "Grants: pod-exec", else drop the call',
    ]);
    assert.deepEqual(grantGaps('Grants: pod-exec', scripts), []);
  });
});

describe('isSkillScript', () => {
  it('matches the script kinds a skill folder holds, not its docs or data', () => {
    const names = ['a.ts', 'a.mts', 'a.cjs', 'a.js', 'a.sh', 'a.ps1', 'a.py', 'SKILL.md', 'a.json', 'node_modules'];
    assert.deepEqual(names.filter(isSkillScript), ['a.ts', 'a.mts', 'a.cjs', 'a.js', 'a.sh', 'a.ps1', 'a.py']);
  });

  it('leaves out a script spec, which the test runner runs and the skill never does', () => {
    const names = ['token-check.test.ts', 'a.spec.mjs', 'a.test.cjs', 'test_a.py', 'a_test.py', 'testing.ts', 'latest.py', 'contest.js'];
    assert.deepEqual(names.filter(isSkillScript), ['testing.ts', 'latest.py', 'contest.js']);
  });
});
