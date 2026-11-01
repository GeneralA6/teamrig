import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProgramRequest, ProgramResult, ProgramRunner } from '../github/credentials.ts';
import { CLEAN_SHUTDOWN_LOOKBACK_MS, parseWindowsEvents, pickShutdown, SHUTDOWN_EVENTS, systemShutdownLog, WINDOWS_SHUTDOWN_SCRIPT } from './shutdowns.ts';

const T = Date.parse('2030-01-08T07:55:00.000Z');

describe('pickShutdown', () => {
  it('starts a started shutdown with no stop after it at its own time, and ends it the lookback later', () => {
    assert.deepEqual(pickShutdown([{ id: SHUTDOWN_EVENTS.initiated, at: T }]), { start: T, end: T + CLEAN_SHUTDOWN_LOOKBACK_MS });
  });

  it('ends at the stopped event log, starting at the shutdown that stopped it within the lookback, else at the stop itself', () => {
    const stopped = { id: SHUTDOWN_EVENTS.eventLogStopped, at: T + 60_000 };
    assert.deepEqual(pickShutdown([{ id: SHUTDOWN_EVENTS.initiated, at: T }, stopped]), { start: T, end: stopped.at });
    const long = { id: SHUTDOWN_EVENTS.initiated, at: stopped.at - CLEAN_SHUTDOWN_LOOKBACK_MS - 1 };
    assert.deepEqual(pickShutdown([long, stopped]), { start: stopped.at, end: stopped.at });
  });

  it('has none after a power loss or an unexpected end, or with no events', () => {
    assert.equal(pickShutdown([{ id: SHUTDOWN_EVENTS.initiated, at: T }, { id: SHUTDOWN_EVENTS.powerLost, at: T + 1 }]), undefined);
    assert.equal(pickShutdown([{ id: SHUTDOWN_EVENTS.unexpected, at: T }]), undefined);
    assert.equal(pickShutdown([]), undefined);
  });
});

describe('parseWindowsEvents', () => {
  it('reads each id and instant line and skips any other', () => {
    const stdout = `1074 2030-01-08T07:55:00.0000000Z\r\n6006 2030-01-08T07:56:00.0000000Z\r\nwarning\r\n41 not-a-date\r\n`;
    assert.deepEqual(parseWindowsEvents(stdout), [
      { id: 1074, at: T },
      { id: 6006, at: T + 60_000 },
    ]);
  });
});

function answering(result: ProgramResult): { readonly run: ProgramRunner; readonly ran: ProgramRequest[] } {
  const ran: ProgramRequest[] = [];
  return {
    ran,
    run: async (request) => {
      ran.push(request);
      return result;
    },
  };
}

describe('systemShutdownLog', () => {
  it('asks Windows for the events through an encoded script', async () => {
    const { run, ran } = answering({ end: { kind: 'exited', code: 0 }, stdout: '1074 2030-01-08T07:55:00.0000000Z\n6006 2030-01-08T07:56:00.0000000Z\n', stderr: '' });
    assert.deepEqual(await systemShutdownLog('win32', run).lastShutdown(), { start: T, end: T + 60_000 });
    const args = ran[0]?.args ?? [];
    assert.equal(ran[0]?.program, 'powershell.exe');
    assert.equal(Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le'), WINDOWS_SHUTDOWN_SCRIPT);
  });

  it('knows none when the query fails, cannot start, or the system is not Windows', async () => {
    assert.equal(await systemShutdownLog('win32', answering({ end: { kind: 'exited', code: 1 }, stdout: '1074 2030-01-08T07:55:00Z', stderr: '' }).run).lastShutdown(), undefined);
    const missing: ProgramRunner = async () => {
      throw new Error('spawn powershell.exe ENOENT');
    };
    assert.equal(await systemShutdownLog('win32', missing).lastShutdown(), undefined);
    const { run, ran } = answering({ end: { kind: 'exited', code: 0 }, stdout: '', stderr: '' });
    assert.equal(await systemShutdownLog('linux', run).lastShutdown(), undefined);
    assert.deepEqual(ran, []);
  });
});
