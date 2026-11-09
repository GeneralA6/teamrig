import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KEEPALIVE_SSH_COMMAND, withSshKeepalive } from './ssh-keepalive.ts';

describe('withSshKeepalive', () => {
  it("sets git's ssh command to ssh with a 30 second keepalive when the user chose none", () => {
    const env = { PATH: '/bin' };
    assert.deepEqual(withSshKeepalive(env, undefined), { PATH: '/bin', GIT_SSH_COMMAND: 'ssh -o ServerAliveInterval=30' });
    assert.equal(KEEPALIVE_SSH_COMMAND, 'ssh -o ServerAliveInterval=30');
    assert.deepEqual(env, { PATH: '/bin' }, 'the env passed in is left as it was');
  });

  it("keeps the user's own GIT_SSH_COMMAND or GIT_SSH, in any case, since GIT_SSH_COMMAND would override both", () => {
    for (const env of [{ GIT_SSH_COMMAND: 'ssh -i key' }, { GIT_SSH: 'plink.exe' }, { Git_Ssh_Command: 'ssh -v' }, { git_ssh: 'plink.exe' }]) {
      assert.equal(withSshKeepalive(env, undefined), env, JSON.stringify(env));
    }
  });

  it("keeps the repository's core.sshCommand, which GIT_SSH_COMMAND would override", () => {
    const env = { PATH: '/bin' };
    assert.equal(withSshKeepalive(env, 'ssh -i deploy_key'), env);
  });
});
