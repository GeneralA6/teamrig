import { DEFAULT_LEAD_LAUNCH } from './defaults.ts';
import type { Check } from './reader.ts';
import { EFFORT_LEVELS, isEffortLevel, type KitConfig, type LaunchConfig } from './types.ts';

/** Leaves the model to Claude Code: `launch` passes no `--model` for it. */
export const DEFAULT_MODEL_ALIAS = 'default';

/**
 * The model aliases Claude Code documents for `--model` and `/model`: `best` is Fable where the
 * account has it, else Opus; `opusplan` plans on Opus and works on Sonnet; `[1m]` asks for the
 * 1M-token context window.
 */
export const MODEL_ALIASES = [
  DEFAULT_MODEL_ALIAS,
  'best',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'opusplan',
  'fable[1m]',
  'opus[1m]',
  'sonnet[1m]',
  'opusplan[1m]',
] as const;

/** A full model id, such as `claude-opus-5-5`, with an optional `[1m]` window suffix. */
export const MODEL_ID_PATTERN = /^claude-[a-z0-9]+(?:[.@-][a-z0-9]+)*(?:\[1m\])?$/;
export const MODEL_ID_MAX_LENGTH = 100;

export const isModel: Check<string> = (model) =>
  MODEL_ALIASES.some((alias) => alias === model) || (model.length <= MODEL_ID_MAX_LENGTH && MODEL_ID_PATTERN.test(model))
    ? undefined
    : `expected a model alias (${MODEL_ALIASES.join(', ')}) or a model id starting claude-`;

export const isEffort: Check<string> = (effort) => (isEffortLevel(effort) ? undefined : `expected one of ${EFFORT_LEVELS.join(', ')}`);

/**
 * What the team config itself sets for the session (`launch.<id>`), without the lead's defaults: the restore reopens a
 * session on an effort set here, and on the level it last ran at otherwise (T2440).
 */
export function ownLaunchOf(config: KitConfig, id: string): LaunchConfig {
  // By its own keys only, so an id such as `constructor` never reads the object's prototype.
  return Object.entries(config.launch).find(([key]) => key === id)?.[1] ?? {};
}

/**
 * The model and effort a session starts on: its own `launch` entry, and for the lead
 * `DEFAULT_LEAD_LAUNCH` under each key the entry leaves unset. Other sessions leave unset keys to Claude Code.
 */
export function launchOf(config: KitConfig, id: string): LaunchConfig {
  const own = ownLaunchOf(config, id);
  return config.roles.lead === id ? { ...DEFAULT_LEAD_LAUNCH, ...own } : own;
}

/** True when the settings leave the model to Claude Code. */
export function isDefaultModel(model: string | undefined): model is typeof DEFAULT_MODEL_ALIAS | undefined {
  return model === undefined || model === DEFAULT_MODEL_ALIAS;
}

/** The settings in words, such as "model best at xhigh effort", for the lines a person reads. */
export function describeLaunch(settings: LaunchConfig): string {
  const { model, effort } = settings;
  if (isDefaultModel(model)) {
    return effort === undefined ? 'the default model and effort' : `the default model at ${effort} effort`;
  }
  return `model ${model} at ${effort ?? 'the default'} effort`;
}
