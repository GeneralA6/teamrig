/** Which projects an install serves: every one, the project at `path` only, or none the core knows of. */
export type InstallReach =
  | { readonly kind: 'every project' }
  | { readonly kind: 'project'; readonly path: string }
  | { readonly kind: 'unknown' };

/** One install of a plugin, as the host's plugin list records it. */
export interface PluginInstall {
  /** The host's own name for the install, the key its settings turn the plugin on or off by. */
  readonly key: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly reach: InstallReach;
  /** The folder the install runs from. */
  readonly installPath: string;
  /** The version the list names; empty when it names none. */
  readonly version: string;
  /** What tells two installs of one version apart, such as the commit they came from; empty when the list names none. */
  readonly revision: string;
}

/**
 * Where a marketplace lives: a folder on this machine (`directory`), read in place, or a git repository the host
 * cloned to `installLocation`, whose `origin` is asked for its newest commit.
 */
export type MarketplaceSource =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'clone'; readonly installLocation: string };

/**
 * The host's plugin store: the plugin list and the marketplace list it keeps in its plugins folder, the cache its
 * installs run from, and the commands that update a plugin. The core reads the files and runs the commands; this port
 * only names them and reads their content. Nothing here may import from Node: the in-tab mod reads the list with it.
 */
export interface HostPlugin {
  /** The plugin list's file name, in the plugins folder. */
  readonly listFile: string;
  /** The marketplace list's file name, beside the plugin list; an update rewrites it as it ends. */
  readonly marketplacesFile: string;
  /**
   * Every install the plugin list holds, in its order. Undefined for a text of another shape, an install of another
   * shape included, so a file mid-write or of another version reads as none.
   */
  installs(listText: string): readonly PluginInstall[] | undefined;
  /** Where the marketplace `name` lives, from the marketplace list; undefined when it is not listed or of another shape. */
  marketplaceSource(marketplacesText: string, name: string): MarketplaceSource | undefined;
  /** The plugins folder of a plugin run from the host's cache, read from its root; undefined for one run from elsewhere. */
  pluginsFolderOf(pluginRoot: string): string | undefined;
  /** Whether a folder is the `bin` folder of an install in the host's cache, which the host puts on its shell's PATH. */
  isCacheBin(folder: string): boolean;
  /** The arguments to the host's program, one run each in order, that update `plugin` from `marketplace`. */
  updateSteps(plugin: string, marketplace: string): readonly (readonly string[])[];
}
