import { Suspense, type ComponentProps, type ReactNode } from "react";
import { LazyFeatureBoundary, LazyFeatureFallback, retryableLazy } from "./LazyFeature";

const MarkdownContent = retryableLazy(() => import("./Markdown").then((module) => ({ default: module.Markdown })));

/** Markdown parsing is needed when a transcript is visible, after the shell starts. `fallback` stands in until it loads. */
export function Markdown({ fallback, ...props }: ComponentProps<typeof MarkdownContent> & { fallback?: ReactNode }) {
  return <LazyFeatureBoundary label="message"><Suspense fallback={fallback ?? <LazyFeatureFallback label="message" />}><MarkdownContent {...props} /></Suspense></LazyFeatureBoundary>;
}
