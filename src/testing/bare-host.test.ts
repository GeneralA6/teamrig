import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUnsupported } from '../ports/host/index.ts';
import { quietWorld } from './quiet-world.ts';
import { bareHost } from './bare-host.ts';

describe('bareHost', () => {
  it('fills no port, each with a reason of its own', () => {
    const ports = Object.values(bareHost());
    assert.ok(ports.length > 0);
    assert.ok(ports.every(isUnsupported), JSON.stringify(ports));
    const notices = ports.filter(isUnsupported).map((port) => port.notice);
    assert.equal(new Set(notices).size, notices.length, notices.join('; '));
  });

  it('names every port the shipped host has, so a new port cannot be left out', () => {
    const shipped = quietWorld().host({ env: {}, platform: 'linux' });
    assert.deepEqual(Object.keys(bareHost()).sort(), Object.keys(shipped).sort());
  });
});
