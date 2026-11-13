import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { formatCarriedJobs, parseCarriedJobs, type CarriedJobs } from './carry.ts';
import {
  formatParkedRestart,
  formatRefreshRequest,
  formatRefreshState,
  formatRestartRequest,
  parseParkedRestart,
  parseRefreshRequest,
  parseRefreshState,
  parseRestartRequest,
  type ParkedRestart,
  type RefreshRequest,
  type RefreshState,
  type RestartRequest,
} from './state.ts';

/**
 * Each session's refresh files. The state (`<id>.json`) is written only by the session itself, from
 * its commands and hooks; the lead's request (`<id>.request.json`) is a file of its own, so neither
 * write ever overwrites the other's; so is the automatic restart (`<id>.restart.json`), which the
 * session's hooks, its restart and `teamrig launch` share, and the restart held back until work comes
 * (`<id>.parked.json`), which its Stop hook writes and its wake check arms. The jobs a /clear left live in the session's process
 * (`<id>.carried.json`) are written by its SessionStart hook. Ids are session ids, checked by the roster, so they
 * are safe in a path.
 */
export class RefreshStore {
  private readonly files: Files;
  private readonly paths: Pick<TeamPaths, 'refresh' | 'handover'>;

  constructor(files: Files, paths: Pick<TeamPaths, 'refresh' | 'handover'>) {
    this.files = files;
    this.paths = paths;
  }

  /** Where the session writes its handover before a refresh. */
  handoverPath(id: string): string {
    return join(this.paths.handover, `${id}.md`);
  }

  /** Where a fresh start finds what the owner typed in the session its refresh replaced (owner-turns.ts). */
  ownerTurnsPath(id: string): string {
    return join(this.paths.handover, `${id}.owner.md`);
  }

  /** The handover's text; undefined when the session has not written one. */
  handover(id: string): Promise<string | undefined> {
    return this.files.read(this.handoverPath(id));
  }

  /** The session's state; undefined when it has none, or the file is damaged or from another format. */
  async state(id: string): Promise<RefreshState | undefined> {
    const text = await this.files.read(this.statePath(id));
    return text === undefined ? undefined : parseRefreshState(text);
  }

  setState(id: string, state: RefreshState): Promise<void> {
    return this.files.write(this.statePath(id), formatRefreshState(state));
  }

  async request(id: string): Promise<RefreshRequest | undefined> {
    const text = await this.files.read(this.requestPath(id));
    return text === undefined ? undefined : parseRefreshRequest(text);
  }

  setRequest(id: string, request: RefreshRequest): Promise<void> {
    return this.files.write(this.requestPath(id), formatRefreshRequest(request));
  }

  async clearRequest(id: string): Promise<void> {
    await this.files.remove(this.requestPath(id));
  }

  async restart(id: string): Promise<RestartRequest | undefined> {
    const text = await this.files.read(this.restartPath(id));
    return text === undefined ? undefined : parseRestartRequest(text);
  }

  setRestart(id: string, request: RestartRequest): Promise<void> {
    return this.files.write(this.restartPath(id), formatRestartRequest(request));
  }

  async clearRestart(id: string): Promise<void> {
    await this.files.remove(this.restartPath(id));
  }

  /** The restart held back until work comes; undefined when none, or the file is damaged. */
  async parked(id: string): Promise<ParkedRestart | undefined> {
    const text = await this.files.read(this.parkedPath(id));
    return text === undefined ? undefined : parseParkedRestart(text);
  }

  setParked(id: string, parked: ParkedRestart): Promise<void> {
    return this.files.write(this.parkedPath(id), formatParkedRestart(parked));
  }

  async clearParked(id: string): Promise<void> {
    await this.files.remove(this.parkedPath(id));
  }

  /** The jobs the last /clear left live in the session's process; undefined when none, or the file is damaged. */
  async carried(id: string): Promise<CarriedJobs | undefined> {
    const text = await this.files.read(this.carriedPath(id));
    return text === undefined ? undefined : parseCarriedJobs(text);
  }

  setCarried(id: string, jobs: CarriedJobs): Promise<void> {
    return this.files.write(this.carriedPath(id), formatCarriedJobs(jobs));
  }

  async clearCarried(id: string): Promise<void> {
    await this.files.remove(this.carriedPath(id));
  }

  private statePath(id: string): string {
    return join(this.paths.refresh, `${id}.json`);
  }

  private requestPath(id: string): string {
    return join(this.paths.refresh, `${id}.request.json`);
  }

  private restartPath(id: string): string {
    return join(this.paths.refresh, `${id}.restart.json`);
  }

  private parkedPath(id: string): string {
    return join(this.paths.refresh, `${id}.parked.json`);
  }

  private carriedPath(id: string): string {
    return join(this.paths.refresh, `${id}.carried.json`);
  }
}
