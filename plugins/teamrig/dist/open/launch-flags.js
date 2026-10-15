import { isDefaultModel } from "../config/launch.js";
/**
 * The `claude` flags that start a session on its model and effort, for the settings that are set;
 * the `default` model passes no flag, so Claude Code keeps its own.
 */
export function launchFlags(settings) {
    const { model, effort } = settings;
    return [...(isDefaultModel(model) ? [] : ['--model', model]), ...(effort === undefined ? [] : ['--effort', effort])];
}
