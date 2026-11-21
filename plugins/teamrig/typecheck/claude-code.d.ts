// The engine's `claude-code` module as teamrig's mod calls it, for the typecheck only (tsconfig.mod.json at
// the repo root). Claude Code runs a mod's hooks itself and writes its own declarations only beside a mod it
// loaded, never into this repo, so these are written from the mod's own calls (hooks/register.ts and its
// spec): the subset they use, under the engine's own names, typed as strictly as those calls allow. They
// prove the mod agrees with itself; `claude plugin test` runs it in the engine, which is what proves the
// engine agrees. A call the mod adds that is not here fails the typecheck: add it here, as the engine's
// documentation or a test run shows it, never as `any`. The mod's own state (`PluginState`) is declared in
// ../types/index.d.ts, the contract the manifest names.

declare module 'claude-code' {
  /** Each plugin's `$.state` keys and their types; ../types/index.d.ts adds teamrig's (module augmentation). */
  export interface PluginState {}

  /** One state key of one plugin, both literals: the reload hand's record. */
  export type StateRef<P extends keyof PluginState & string, K extends keyof PluginState[P] & string> = {
    readonly plugin: P
    readonly key: K
  }
  /** A state key with the value it reads as until written: the bands' and the agenda pane's values. */
  export type Atom<T> = { readonly plugin: string; readonly key: string; readonly initial: T }
  /** Declares a band's or the pane's value under its contract key, `initial` until written. */
  export function atom<P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(
    ref: StateRef<P, K>,
    initial: PluginState[P][K],
  ): Atom<PluginState[P][K]>
  /** Reads a value while a band or the pane draws, which redraws it on the next write. */
  export function read<T>($: EngineInterface, source: Atom<T>): Promise<T>
  /** Writes a band's or the pane's value (read, change, write, again on a miss); resolves to the value written. */
  export function update<T>($: EngineInterface, target: Atom<T>, change: (value: T) => T): Promise<T>
  /** What `$.state.get` answers: the value, undefined while never written, and its version. */
  export type StateRead<T> = { readonly value: T | undefined; readonly version: number }
  /** What `$.state.set` answers: whether the write landed, and the version it stands at. */
  export type StateSetResult = { readonly isSet: boolean; readonly version: number }

  /** The surfaces a session draws on; every one has the Box, Text and Button the mod draws with. */
  export type RenderSurface = 'terminal' | 'desktop' | 'vscode' | 'mobile'
  /** The theme colours the mod's bands draw text in (the engine has more, and takes plain colours). */
  export type ThemeKey = 'success' | 'error' | 'warning'
  /** A drawn element, as a render hook returns it and a test reads it back as plain data. */
  export type RenderElement = { readonly type: string; readonly props?: unknown; readonly children?: readonly RenderNode[] }
  /** One child: an element or text. */
  export type RenderNode = RenderElement | string
  /** What a component takes as `children`: nodes, numbers, dropped values, or lists of them. */
  export type RenderChildren = RenderNode | number | boolean | null | undefined | readonly RenderChildren[]
  /** A row or column of the bands and the agenda pane; `round` boxes the card on the table. */
  export type BoxProps = {
    readonly flexDirection?: 'row' | 'column'
    readonly gap?: number
    readonly paddingX?: number
    readonly paddingY?: number
    readonly paddingLeft?: number
    readonly borderStyle?: 'round'
  }
  /** A band's line or a card's line. */
  export type TextProps = {
    readonly color?: ThemeKey
    readonly bold?: boolean
    readonly dimColor?: boolean
    readonly wrap?: 'wrap'
  }
  /** A band's button by `key`: `label`, `plain` with no frame, `hotkey` the digit that presses it from an empty prompt box. */
  export type ButtonProps = {
    readonly key: string
    readonly label: string
    readonly hotkey?: string
    readonly plain?: true
    readonly onPress: () => void
  }
  /** One of the surface's components: props plus `children`, to an element. */
  export type ElementConstructor<P> = (props: P & { readonly children?: RenderChildren }) => RenderElement
  /** The components `$.ui.resolve` hands a render hook. */
  export type Elements = {
    readonly Box: ElementConstructor<BoxProps>
    readonly Text: ElementConstructor<TextProps>
    readonly Button: ElementConstructor<ButtonProps>
  }

  /** The window of a site the engine draws: its first row shown and how many it shows. */
  export type SiteScroll = { readonly offset: number; readonly bodyRows: number }
  /** What the site shows: the subagent whose view it is, when one. */
  export type SiteView = { readonly agentId?: string }
  /** The props of each component the mod draws: the band above the prompt and the agenda pane. */
  export type RenderPropsOf = {
    readonly AbovePrompt: {
      /** True while a survey holds the band; the mod's band yields to it. */
      readonly hasSurvey: boolean
      readonly isWorking: boolean
      readonly maxRows: number
      readonly bodyColumns: number
      readonly scroll: SiteScroll
      readonly view: SiteView
    }
    readonly Pane: {
      readonly title: string
      readonly isFocused: boolean
      readonly bodyColumns: number
      readonly placement: 'dock' | 'inline' | 'widget'
      readonly scroll: SiteScroll
      readonly view: SiteView
    }
  }
  /** The components the mod draws. */
  export type RenderComponent = keyof RenderPropsOf
  /** A `ui.render` request: the surface, the component, its instance (a pane's id) and its props. */
  export type RenderInput<C extends RenderComponent> = {
    readonly surface: RenderSurface
    readonly component: C
    readonly requestId: string
    readonly plugin?: string
    readonly props: RenderPropsOf[C]
  }

  /** A slash command `$.command.register` adds: `/teamrig`. */
  export type CommandSpec = { readonly name: string; readonly description: string; readonly argumentHint?: string }
  /** A command `$.command.run` runs as if typed: /clear, /reload-plugins. */
  export type CommandRunArgs = { readonly command: string; readonly args?: string }
  /** A command's answer: the text it shows, and the exit code a headless `claude -p` ends with. */
  export type CommandRunResult = { readonly text?: string; readonly exitCode?: number }
  /** Where a prompt or a command came from: the person's prompt box (`composer`), Remote Control (`bridge`), or elsewhere. */
  export type PromptOrigin =
    | {
        readonly kind:
          | 'composer'
          | 'bridge'
          | 'sdk'
          | 'task-notification'
          | 'scheduled-trigger'
          | 'peer'
          | 'peer-send-message'
          | 'projects-relay'
          | 'coordinator'
          | 'observer'
          | 'observer-activity'
          | 'auto-continuation'
          | 'unclassified'
          | 'slack-ping'
      }
    | { readonly kind: 'channel'; readonly server: string }
    | { readonly kind: 'plugin'; readonly name: string; readonly asUser?: true }
  /** Where the fullscreen layout would draw a command's pane. */
  export type CommandPresentation = { readonly isFullscreen: boolean; readonly columns: number }
  /** `/teamrig <args>` as typed, and where from. */
  export type CommandRunInput = {
    readonly command: string
    readonly args: string
    readonly origin: PromptOrigin
    readonly presentation: CommandPresentation
  }

  /** What the prompt box holds: the person's draft and the cursor in it. */
  export type PromptBox = { readonly text: string; readonly cursor: number }
  /** The wake's prompt, submitted as the plugin. */
  export type PromptSubmitArgs = { readonly text: string }
  /** A prompt on its way to a turn: its text, whether the caller waits for the turn, and where it came from. */
  export type PromptSubmitInput = { readonly text: string; readonly wait: boolean; readonly origin: PromptOrigin }
  /** The prompt as submitted, or why a hook dropped it. */
  export type PromptSubmitResult =
    | { readonly text: string; readonly drop?: undefined }
    | { readonly drop: string; readonly text?: undefined }
  /** A key in the prompt box: the text before it, the cursor, and the span `inputText` replaces. */
  export type PromptEditInput = {
    readonly origin: { readonly kind: 'composer' }
    readonly text: string
    readonly cursor: number
    readonly start: number
    readonly end: number
    readonly inputText: string
  }

  /** A turn starting: the prompt's text, its id, and the subagent's id when not the main conversation. */
  export type TurnStartInput = { readonly text: string; readonly turnId: string; readonly agentId?: string }
  /** A turn ended: its answer, how long it ran, whether aborted, its id, and the subagent's id when not the main conversation. */
  export type TurnCompleteInput = {
    readonly answer: string
    readonly durationMs: number
    readonly isAborted: boolean
    readonly turnId: string
    readonly agentId?: string
  }

  /** A tool call as the hooks see it: the tool, the call's id, and the subagent's id when not the main conversation. */
  export type ToolCallInput = { readonly tool: string; readonly tool_use_id: string; readonly agentId?: string }
  /** A tool call's outcome: refused (`deny`), its result with lines the model reads after it (`context`), or an error. */
  export type ToolCallResult =
    | { readonly deny: string; readonly result?: undefined; readonly context?: undefined; readonly text?: undefined; readonly isError?: undefined }
    | { readonly result: unknown; readonly context?: readonly string[]; readonly text?: string; readonly isError?: undefined; readonly deny?: undefined }
    | { readonly isError: true; readonly result: unknown; readonly context?: readonly string[]; readonly text?: string; readonly deny?: undefined }

  /** Why a compaction runs: the person's /compact, Claude Code's own (`auto`, or `precompute` ahead), or a plugin's. */
  export type SessionCompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'
  /** One message of a conversation as a compaction reads it. */
  export type SessionMessage = {
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly toolUses: readonly unknown[]
  }
  /** A compaction about to run: why, the subagent's id when not the main conversation, and the messages. */
  export type SessionCompactInput = {
    readonly trigger: SessionCompactTrigger
    readonly agentId?: string
    readonly messages: readonly SessionMessage[]
  }
  /** The conversation compacted to these messages. */
  export type SessionCompacted = { readonly messages: readonly SessionMessage[]; readonly skip?: undefined }
  /** The compaction skipped, with the line that says why. */
  export type SessionCompactSkipped = { readonly skip: string; readonly messages?: undefined }
  export type SessionCompactResult = SessionCompacted | SessionCompactSkipped
  /** Where the compaction window's size came from. */
  export type ContextWindowSource = 'env' | 'settings' | 'clientdata' | 'experiment' | 'model-default' | 'unknown-model' | 'auto'
  /** Claude Code's estimate of the context as /context breaks it down; the mod reads `totalTokens` and `rawMaxTokens`. */
  export type SessionContextBreakdown = {
    readonly categories: readonly unknown[]
    readonly totalTokens: number
    readonly maxTokens: number
    readonly rawMaxTokens: number
    readonly autocompactSource: ContextWindowSource
    readonly percentage: number
    readonly gridRows: readonly (readonly unknown[])[]
    readonly model: string
    readonly memoryFiles: readonly unknown[]
    readonly mcpTools: readonly unknown[]
    readonly agents: readonly unknown[]
    readonly isAutoCompactEnabled: boolean
    readonly apiUsage: unknown
  }
  /** The context as of the last reply: its tokens, the window, and the breakdown when asked for. */
  export type SessionContextUsage = {
    readonly tokens?: number
    readonly window: number
    readonly breakdown?: SessionContextBreakdown
  }
  /** `$.session.usage`'s ask: the /context breakdown too, in summary or in full. */
  export type SessionUsageArgs = { readonly breakdown?: 'summary' | 'full' }
  /** The session's figures: when it started, its context, its rate limits. */
  export type SessionUsage = {
    readonly startedAt: number
    readonly context: SessionContextUsage
    readonly rateLimits: readonly unknown[]
  }
  /** The session starting (once per load of the module, never on /clear): its folder, surface, and whether a person is at it. */
  export type SessionStartInput = { readonly cwd: string; readonly surface: RenderSurface | null; readonly isInteractive: boolean }
  export type SessionStartResult = { readonly cwd: string }

  /** One agent of the session (a helper or a teammate) and its status: the clear hand holds while one is live. */
  export type AgentInfo = {
    readonly id: string
    readonly description: string
    readonly type: string
    readonly status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  }
  /** A file's or folder's kind and when it last changed. */
  export type FsStat = { readonly kind: 'file' | 'dir' | 'other'; readonly size: number; readonly mtimeMs: number; readonly isLink: boolean }
  /** One entry of a folder, by name. */
  export type FsEntry = FsStat & { readonly name: string }
  /** How the plugin's CLI runs: its folder, the environment set over Claude Code's own, its stdin, and when it is stopped. */
  export type ProcessRunInit = {
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
    readonly stdin?: string
    readonly timeoutMs?: number
  }
  /** What a run of the plugin's CLI printed and how it exited. */
  export type ProcessRunResult = {
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
    readonly isStdoutTruncated: boolean
    readonly isStderrTruncated: boolean
  }
  /** The agenda pane `$.ui.open` opens: its id and tab title. */
  export type PaneOpenArgs = { readonly id: string; readonly title?: string }
  /** Whether a surface draws the pane now, or why it waits. */
  export type UiOpenResult = { readonly isPlaced: true } | { readonly isPlaced: false; readonly reason: string }
  /** Who closed a pane: the person, the plugin, or the engine unloading it. */
  export type PaneCloseOrigin = { readonly kind: 'plugin' | 'person' | 'unload' }
  /** A timer `$.clock` started. */
  export type Timer = { cancel(): void }

  /** What the mod calls on the engine; each call is an event a test (or another plugin) can answer beneath it. */
  export interface EngineInterface {
    readonly plugin: { readonly root: string }
    readonly session: {
      id(): Promise<string>
      cwd(): Promise<string>
      root(): Promise<string>
      usage(args?: SessionUsageArgs): Promise<SessionUsage>
    }
    readonly command: {
      register(command: CommandSpec): Promise<{ readonly command: string }>
      run(input: CommandRunArgs): Promise<CommandRunResult>
    }
    readonly prompt: {
      read(): Promise<PromptBox>
      submit(input: PromptSubmitArgs): Promise<PromptSubmitResult>
    }
    readonly agent: { list(): Promise<AgentInfo[]> }
    readonly ui: {
      resolve(e: { readonly surface: RenderSurface; readonly component: RenderComponent }): Elements
      log(text: string, options?: { readonly to?: 'transcript' | 'debug' }): void
      ask(question: string, options?: readonly string[]): Promise<string>
      toast(text: string, options?: { readonly timeoutMs?: number }): void
      status(text: string | undefined): void
      open(pane: PaneOpenArgs): Promise<UiOpenResult>
      close(pane: { readonly id: string }): Promise<void>
    }
    readonly fs: {
      read(path: string): Promise<string>
      list(path: string): Promise<FsEntry[]>
      exists(path: string): Promise<boolean>
      stat(path: string): Promise<FsStat>
    }
    readonly state: {
      get<P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(ref: StateRef<P, K>): Promise<StateRead<PluginState[P][K]>>
      set<P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(ref: StateRef<P, K>, value: PluginState[P][K]): Promise<StateSetResult>
    }
    readonly clock: {
      now(): Promise<number>
      after(ms: number, fn: () => void): Timer
      every(ms: number, fn: () => void): Timer
    }
    readonly process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  }

  /** A call's answer as the hooks on its event give it: `{ value }`, or `{ deny }`, the reason the caller's promise rejects. */
  export type ValueOrDeny<V> = { readonly value: V; readonly deny?: undefined } | { readonly deny: string; readonly value?: undefined }
  /** Nothing: the input of a call that takes no argument. */
  export type NoArgs = Readonly<Record<never, never>>

  /** Each event the mod or its spec hooks: its input `e` and its result. */
  export interface Events {
    'session.start': { e: SessionStartInput; result: SessionStartResult }
    'session.compact': { e: SessionCompactInput; result: SessionCompactResult }
    'session.id': { e: NoArgs; result: ValueOrDeny<string> }
    'session.cwd': { e: NoArgs; result: ValueOrDeny<string> }
    'session.root': { e: NoArgs; result: ValueOrDeny<string> }
    'session.usage': { e: SessionUsageArgs; result: ValueOrDeny<SessionUsage> }
    'turn.start': { e: TurnStartInput; result: { readonly turnId: string } }
    'turn.complete': { e: TurnCompleteInput; result: { readonly text: string } }
    'command.run': { e: CommandRunInput; result: CommandRunResult }
    'prompt.read': { e: NoArgs; result: ValueOrDeny<PromptBox> }
    'prompt.edit': { e: PromptEditInput; result: PromptBox }
    'prompt.submit': { e: PromptSubmitInput; result: PromptSubmitResult }
    'tool.call': { e: ToolCallInput; result: ToolCallResult }
    'agent.list': { e: NoArgs; result: ValueOrDeny<AgentInfo[]> }
    'ui.render': { e: RenderInput<RenderComponent>; result: RenderElement }
    'ui.open': { e: PaneOpenArgs; result: ValueOrDeny<UiOpenResult> }
    'ui.close': { e: { readonly id: string; readonly origin: PaneCloseOrigin }; result: ValueOrDeny<void> }
    'ui.log': { e: { readonly text: string; readonly to: 'transcript' | 'debug' }; result: ValueOrDeny<void> }
    'ui.toast': { e: { readonly text: string; readonly timeoutMs?: number }; result: ValueOrDeny<void> }
    'fs.exists': { e: { readonly path: string }; result: ValueOrDeny<boolean> }
    'fs.read': { e: { readonly path: string }; result: ValueOrDeny<string> }
    'process.run': { e: { readonly argv: readonly string[]; readonly init?: ProcessRunInit }; result: ValueOrDeny<ProcessRunResult> }
  }
  export type EventName = keyof Events

  /** Runs the hooks beneath, then the engine's own behaviour, resolving to the event's result. */
  export type Next<E, R> = (e: E) => Promise<R>
  /** A hook: `$`, the event's input, and `next`. */
  export type Hook<E, R> = ($: EngineInterface, e: E, next: Next<E, R>) => R | Promise<R>
  /** A registered hook; `catch` sets the answer given in its place when it throws (the `/teamrig` hook's failure line). */
  export type Registration<E, R> = {
    readonly catch: (handler: ($: EngineInterface, e: E, next: Next<E, R>) => R | undefined | Promise<R | undefined>) => void
  }

  /** Registers a hook on an event, or on the `/teamrig` command, the band above the prompt or the agenda pane alone. */
  export interface On {
    <N extends EventName>(event: N, hook: Hook<Events[N]['e'], Events[N]['result']>): Registration<Events[N]['e'], Events[N]['result']>
    (event: 'command.run', matcher: { readonly command: string }, hook: Hook<CommandRunInput, CommandRunResult>): Registration<CommandRunInput, CommandRunResult>
    <C extends RenderComponent>(
      event: 'ui.render',
      matcher: { readonly component: C; readonly requestId?: string },
      hook: Hook<RenderInput<C>, RenderElement>,
    ): Registration<RenderInput<C>, RenderElement>
  }
  /** The hooks module's entry, which the engine calls with `on` each time it loads the module. */
  export type Register = (on: On) => unknown
}
