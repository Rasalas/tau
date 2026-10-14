import { Suspense, useRef, type ComponentProps, type ReactNode } from "react";
import { deferredModule } from "./deferred";
import { LazyFeatureBoundary, LazyFeatureFallback, retryableLazy } from "./LazyFeature";

const loadMarkdown = deferredModule(() => import("./Markdown").then((module) => module.Markdown));
export function isMarkdownReady(): boolean { return loadMarkdown.current !== undefined; }
/** The initial transcript loads its parser alongside extensions, before mounting rows. */
export const preloadMarkdown = loadMarkdown;
const MarkdownContent = retryableLazy(() => loadMarkdown().then((defaultExport) => ({ default: defaultExport })));

/** Markdown parsing is needed when a transcript is visible, after the shell starts. `fallback` stands in until it loads. */
export function Markdown({ fallback, ...props }: ComponentProps<typeof MarkdownContent> & { fallback?: ReactNode }) {
  // Keep this choice for the instance's lifetime: switching a resolved lazy
  // wrapper to the direct component on a later render would remount its state.
  const Content = useRef(loadMarkdown.current ?? MarkdownContent).current;
  return <LazyFeatureBoundary label="message"><Suspense fallback={fallback ?? <LazyFeatureFallback label="message" />}><Content {...props} /></Suspense></LazyFeatureBoundary>;
}
