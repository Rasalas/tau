import { lazy, Suspense, type ComponentProps } from "react";
import { LazyFeatureFallback } from "./components/LazyFeature";

/**
 * The review surface core lends extensions. It is the largest single view Tau
 * has, so it arrives as its own chunk the first time an extension renders it,
 * and brings its own loading state.
 */
const LazyReviewMode = lazy(() => import("./components/ReviewMode").then((module) => ({ default: module.ReviewMode })));

/** Core's full-workbench review of a set of changes: file list, diffs, comments, commit box. */
export function ReviewMode(props: ComponentProps<typeof LazyReviewMode>) {
  return <Suspense fallback={<LazyFeatureFallback label="review" />}><LazyReviewMode {...props} /></Suspense>;
}

const LazyDiffView = lazy(() => import("./components/DiffView").then((module) => ({ default: module.DiffView })));

/** One file's diff with its own scroll element and the line seam, from the chunk review mode already loads. */
export function DiffView(props: ComponentProps<typeof LazyDiffView>) {
  return <Suspense fallback={<LazyFeatureFallback label="diff" />}><LazyDiffView {...props} /></Suspense>;
}

const LazyDiffStack = lazy(() => import("./components/DiffStack").then((module) => ({ default: module.DiffStack })));

/** File cards shared by stage diffs and review pages, with optional line and header actions. */
export function DiffStack(props: ComponentProps<typeof LazyDiffStack>) {
  return <Suspense fallback={<LazyFeatureFallback label="diff" />}><LazyDiffStack {...props} /></Suspense>;
}
