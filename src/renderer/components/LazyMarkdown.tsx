import { Suspense, type ComponentProps } from "react";
import { LazyFeatureBoundary, LazyFeatureFallback, retryableLazy } from "./LazyFeature";

const MarkdownContent = retryableLazy(() => import("./Markdown").then((module) => ({ default: module.Markdown })));

/** Markdown parsing is needed when a transcript is visible, after the shell starts. */
export function Markdown(props: ComponentProps<typeof MarkdownContent>) {
  return <LazyFeatureBoundary label="message"><Suspense fallback={<LazyFeatureFallback label="message" />}><MarkdownContent {...props} /></Suspense></LazyFeatureBoundary>;
}
