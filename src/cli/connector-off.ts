import type { Env } from '../core/home.ts';

/** The value that turns a connector off on this machine, in any case and with spaces around it. */
export const CONNECTOR_OFF = 'off';

const OFF_VARIABLE_PREFIX = 'TEAMRIG_CONNECTOR_';

/**
 * The environment variable that turns the connector of an id off on this machine, whatever the team config says:
 * `TEAMRIG_CONNECTOR_<ID>`, the id in upper case with `_` for each `-`, as a variable's name takes no `-`.
 */
export function connectorOffVariable(id: string): string {
  return `${OFF_VARIABLE_PREFIX}${id.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * The variable that turns a connector off here, or undefined while it is on. `older` names the switches the connector
 * had before every connector got one of the same shape: they still work, and are named first, so a machine that set
 * one reads the name it set.
 */
export function connectorOffBy(env: Env, id: string, older: readonly string[] = []): string | undefined {
  return [...older, connectorOffVariable(id)].find((name) => env[name]?.trim().toLowerCase() === CONNECTOR_OFF);
}
