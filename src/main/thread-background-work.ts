import type { ThreadBackgroundCapability } from "./runtime-types.js";

/** Combines native runtime work with work owned by kits, without teaching core about a harness. */
export class ThreadBackgroundWork {
  private readonly providers = new Set<(threadId: string) => ThreadBackgroundCapability | undefined>();
  private readonly touched = new Set<string>();

  constructor(private readonly native: (threadId: string) => ThreadBackgroundCapability | undefined, private readonly publish: (threadId: string) => void) {}

  provide(provider: (threadId: string) => ThreadBackgroundCapability | undefined): () => void {
    this.providers.add(provider);
    return () => {
      this.providers.delete(provider);
      for (const id of this.touched) this.publish(id);
    };
  }

  changed(threadId: string): void { this.touched.add(threadId); this.publish(threadId); }
  get available(): boolean { return this.providers.size > 0; }

  forThread(threadId: string): ThreadBackgroundCapability | undefined {
    const sources = () => [this.native(threadId), ...[...this.providers].map((provider) => provider(threadId))].filter((source): source is ThreadBackgroundCapability => Boolean(source));
    if (!sources().length) return undefined;
    const owner = (id: string) => {
      const source = sources().find((candidate) => (candidate.list?.() ?? candidate.current()).some((task) => task.id === id));
      if (!source) throw new Error("That background task is no longer available.");
      return source;
    };
    return {
      current: () => sources().flatMap((source) => source.current()),
      list: () => sources().flatMap((source) => source.list?.() ?? source.current()),
      stop: async (id) => {
        if (id) await owner(id).stop(id);
        else await Promise.all(sources().map((source) => source.stop()));
        this.changed(threadId);
      },
      release: (id) => {
        const source = owner(id);
        if (!source.release) throw new Error("This runtime cannot release that background task as a service.");
        source.release(id);
        this.changed(threadId);
      },
      read: (id) => {
        const source = owner(id);
        if (!source.read) throw new Error("This runtime does not provide output for that background task.");
        return source.read(id);
      },
    };
  }
}
