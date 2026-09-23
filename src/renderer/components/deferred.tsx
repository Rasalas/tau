import { createElement, lazy, Suspense, type ComponentProps, type ComponentType } from "react";

type AnyComponent = ComponentType<any>;

export type DeferredComponent<C extends AnyComponent> = C & {
  /** Loads the chunk; the component then renders without suspending. */
  preload(): Promise<void>;
};

const loaders: Array<() => Promise<void>> = [];

/**
 * A component whose code is a chunk of its own, for surfaces drawn only after
 * a user action (menus, dialogs, settings rows). Once loaded it renders in
 * place; drawn before that, it shows nothing until the chunk arrives. `when`
 * skips the load while the component would draw nothing anyway.
 */
export function deferred<C extends AnyComponent>(
  load: () => Promise<C>,
  when?: (props: ComponentProps<C>) => boolean,
): DeferredComponent<C> {
  let loaded: C | undefined;
  let loading: Promise<void> | undefined;
  const preload = () => loading ??= load().then(
    (component) => { loaded = component; },
    (error: unknown) => { loading = undefined; throw error; },
  );
  // A loaded chunk answers with a thenable that settles synchronously, so React never suspends for it.
  const Lazy = lazy(() => (loaded
    ? { then: (resolve: (module: { default: C }) => void) => resolve({ default: loaded! }) }
    : preload().then(() => ({ default: loaded! }))) as Promise<{ default: C }>);
  loaders.push(preload);
  const Deferred = (props: ComponentProps<C>) => (when && !when(props)
    ? null
    : createElement(Suspense, { fallback: null }, createElement(Lazy, props)));
  return Object.assign(Deferred, { preload }) as unknown as DeferredComponent<C>;
}

/** Loads every deferred component's chunk. */
export function preloadDeferred(): Promise<void> {
  return Promise.all(loaders.map((load) => load())).then(() => undefined);
}

/** After start-up, when the window is idle, so the first open of a surface does not wait for its chunk. */
export function preloadDeferredWhenIdle(delayMs = 2_000): void {
  if (typeof window === "undefined") return;
  const run = () => void preloadDeferred().catch(() => undefined);
  const schedule = () => window.setTimeout(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5_000 });
    else run();
  }, delayMs);
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
}
