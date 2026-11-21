// The engine's `claude-code/testing` kit as teamrig's mod spec (hooks/register.test.ts) calls it, for the
// typecheck only (see claude-code.d.ts beside it for why it is written here and what proves it).
// `claude plugin test` runs each test file in the engine with this kit.

declare module 'claude-code/testing' {
  import type {
    On,
    PromptSubmitInput,
    PromptSubmitResult,
    RenderComponent,
    RenderElement,
    RenderPropsOf,
    RenderSurface,
    SessionCompactInput,
    SessionCompactResult,
    SessionStartInput,
    SessionStartResult,
    ToolCallResult,
  } from 'claude-code'

  /** The checks the spec makes on a value; `not` negates one. */
  export type Matchers = {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toMatchObject(expected: object): void
    toBeUndefined(): void
  }
  /** Checks on `received`. */
  export const expect: (received: unknown) => Matchers & { readonly not: Matchers }

  /** An element a query found in a drawing: its component, its key, its props and the text inside it. */
  export type FoundElement = {
    readonly type: string
    readonly key: string | undefined
    readonly props: Readonly<Record<string, unknown>>
    readonly text: string
  }
  /** Finds elements by component, by key, or both. */
  export type ElementQuery = { readonly type?: string; readonly key?: string }
  /** Component `C` mounted as the engine draws it on surface `P`, driven as a person would (`C` types only the engine's `redraw`, which the spec never calls). */
  export type Mounted<P extends RenderSurface, C extends RenderComponent> = {
    readonly surface: P
    /** The first element matching, in drawing order. */
    find(query: ElementQuery): Promise<FoundElement | undefined>
    /** Every element matching, in drawing order. */
    findAll(query: ElementQuery): Promise<FoundElement[]>
    /** Presses the button with this key, as a click or its hotkey does. */
    press(target: { readonly key: string }): Promise<unknown>
    /** The tree it drew last, as plain data. */
    drawn(): Promise<RenderElement>
    /** Takes it off the surface. */
    unmount(): Promise<void>
  }
  /** What to mount: the plugin's drawing of a component on a surface, with its props and, for a pane, its id. */
  export type MountTarget<P extends RenderSurface, C extends RenderComponent> = {
    readonly plugin: string
    readonly surface: P
    readonly component: C
    readonly props: RenderPropsOf[C]
    readonly requestId?: string
  }
  /** A tool call the test makes: the tool, the call's id, and the subagent's id when not the main conversation. */
  export type ToolCallArgs = { readonly tool: string; readonly tool_use_id?: string; readonly agentId?: string }
  /** The engine around the plugin under test: each call raises its event through the plugin's hooks, then the test's own beneath them. */
  export type Engine = {
    readonly session: {
      start(e: SessionStartInput): Promise<SessionStartResult>
      compact(e: SessionCompactInput): Promise<SessionCompactResult>
    }
    readonly prompt: { submit(e: PromptSubmitInput): Promise<PromptSubmitResult> }
    readonly tool: { call(input: ToolCallArgs): Promise<ToolCallResult> }
    readonly ui: { mount<P extends RenderSurface, C extends RenderComponent>(target: MountTarget<P, C>): Promise<Mounted<P, C>> }
  }
  /** The engine's clock under test: `advance` runs the timers due, `settle` lets pending work finish. */
  export type MockClock = {
    advance(ms: number): Promise<void>
    settle(): Promise<void>
  }
  export const mock: {
    /** Answers `$.clock` from a clock that starts at `now` and moves only when told. */
    clock(on: On, options?: { readonly now?: number }): MockClock
  }

  /** Groups tests under a name. */
  export const describe: (name: string, body: () => void) => void
  /** A test: `$` the engine with the plugin loaded, `on` the test's hooks beneath the plugin's. */
  export const test: (name: string, body: ($: Engine, on: On) => unknown) => void
}
