import { lazy, Suspense, type ComponentProps } from "react";
import { LazyFeatureFallback } from "./components/LazyFeature";

/**
 * The two document surfaces core lends extensions. Both are heavy — the diff
 * viewer is the largest single view Tau has — so each arrives as its own chunk
 * the first time an extension renders it, and brings its own loading state.
 */
const LazyReviewMode = lazy(() => import("./components/ReviewMode").then((module) => ({ default: module.ReviewMode })));
const LazyChangesTree = lazy(() => import("./components/ChangesTree").then((module) => ({ default: module.ChangesTree })));

/** Core's full-workbench review of a set of changes: file list, diffs, comments, commit box. */
export function ReviewMode(props: ComponentProps<typeof LazyReviewMode>) {
  return <Suspense fallback={<LazyFeatureFallback label="review" />}><LazyReviewMode {...props} /></Suspense>;
}

/** The changed files of a workspace as a tree, with stage, unstage and revert. */
export function ChangesTree(props: ComponentProps<typeof LazyChangesTree>) {
  return <Suspense fallback={<LazyFeatureFallback label="changes" />}><LazyChangesTree {...props} /></Suspense>;
}
