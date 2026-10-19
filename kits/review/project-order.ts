import { useSyncExternalStore } from "react";
import type { UiProject, UiSession } from "tau";

/** Workspace Kit's rail order of projects, when that kit is active. */
export interface ProjectOrderService {
  order<T extends UiProject>(projects: readonly T[], threads: readonly UiSession[]): T[];
  subscribe(listener: () => void): () => void;
}

/** Holds the service so views can follow it; without it projects keep the order they came in. */
export class ProjectOrderSource {
  private service?: ProjectOrderService;
  private stop?: () => void;
  private version = 0;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.version;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(service: ProjectOrderService | undefined) {
    this.stop?.();
    this.service = service;
    this.stop = service?.subscribe(() => this.bump());
    this.bump();
  }
  order<T extends UiProject>(projects: readonly T[], threads: readonly UiSession[]): readonly T[] {
    return this.service ? this.service.order(projects, threads) : projects;
  }
  private bump() { this.version += 1; for (const listener of [...this.listeners]) listener(); }
}

const NONE = new ProjectOrderSource();

/** `projects` in the rail's order; the list is read again when the rail's settings change. */
export function useProjectsInRailOrder<T extends UiProject>(source: ProjectOrderSource | undefined, projects: readonly T[], threads: () => readonly UiSession[]): readonly T[] {
  const from = source ?? NONE;
  useSyncExternalStore(from.subscribe, from.getSnapshot, from.getSnapshot);
  return from.order(projects, threads());
}
