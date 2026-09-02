# ADR 0007: Project facts come from extensions

## Status

Accepted, 2026-09-02.

## Context

ADR 0006 left the shared Git cache in core: the thread index shows a branch per project, linked worktrees are folded into their repository, a project's display name comes from its remote, and core invalidated the cache after edits and Git commands. Every one of those is Workspace Kit knowledge living in `PiHost`, and `git-coordinator.ts` and `workspace-git.ts` were the last feature modules core imported.

Two ways out were on the table: keep the branch a core field that an extension fills, or let Workspace Kit decorate the index on the desktop side. Decorating on the desktop side would have meant a second index pipeline in the renderer for three small facts.

## Decision

Core keeps the index machinery and loses the facts. The seam gains `describeProjects(facts)`, where an extension answers three questions about a project folder: its display `name`, a short `label` and whether it is `nested` in another project. Core caches the answers, refreshes the label in the background, publishes changes with the thread index and withholds unclassified paths from the project list, exactly as it did for branches and worktrees.

On the wire the field is `projectLabel` on sessions and the snapshot, and `label` on project updates. Workspace Kit fills it with the Git branch, supplies the repository name and reports linked worktrees as nested. The kit also owns the Git cache: it constructs `GitCoordinator`, invalidates it through the turn observer's `toolEnded` hook, and passes it to its checkpoint lifecycle.

"Copy branch" leaves the thread title menu of core and becomes a Workspace Kit command on the `thread-title` surface.

## Consequences

- Core imports neither `git-coordinator.ts` nor `workspace-git.ts`; Git is a word that no longer appears in `src/main/pi-host.ts` or the contracts.
- A host without Workspace Kit shows folder names, no labels and every folder as a root. Safe mode therefore lists projects a little more plainly.
- The seam grew by one provider hook and `noteSubprocess()` for the lifecycle metrics. Another extension may supply labels of its own; the first defined answer wins.
