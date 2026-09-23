import type {
  HostTurnAttachmentServices,
  TurnAttachment,
  TurnAttachmentData,
  TurnAttachmentProvider,
} from "./host-extensions.js";

/**
 * Who provides media for a thread's turns. Core keeps no bytes and knows no
 * kind of media: a kit provides, any other kit reads by thread, and `source`
 * — the provider's extension id — is the only thing core adds.
 */
export class TurnAttachmentRegistry {
  private readonly providers = new Map<string, TurnAttachmentProvider>();

  private readonly observers = new Set<(threadId: string, source: string) => void>();

  private readonly bound = new Map<string, HostTurnAttachmentServices>();

  constructor(private readonly log: (label: string, detail?: string) => void = () => undefined) {}

  /** The facade one extension sees: its `provide` and `changed` speak for its own id only. */
  forExtension(source: string): HostTurnAttachmentServices {
    let facade = this.bound.get(source);
    if (facade) return facade;
    facade = {
      provide: (provider) => {
        this.providers.set(source, provider);
        return () => {
          if (this.providers.get(source) === provider) this.providers.delete(source);
        };
      },
      changed: (threadId) => {
        for (const observer of [...this.observers]) {
          try {
            observer(threadId, source);
          } catch (error) {
            this.log("turn-attachments.observer-failed", error instanceof Error ? error.message : String(error));
          }
        }
      },
      list: (threadId) => this.list(threadId),
      read: (threadId, from, id) => this.read(threadId, from, id),
      observe: (listener) => {
        this.observers.add(listener);
        return () => { this.observers.delete(listener); };
      },
    };
    this.bound.set(source, facade);
    return facade;
  }

  async list(threadId: string): Promise<TurnAttachment[]> {
    const lists = await Promise.all([...this.providers].map(async ([source, provider]) => {
      try {
        return (await provider.list(threadId)).map((attachment) => ({ ...attachment, source }));
      } catch (error) {
        this.log("turn-attachments.list-failed", `${source}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    return lists.flat().sort((left, right) => left.at - right.at);
  }

  async read(threadId: string, source: string, id: string): Promise<TurnAttachmentData | undefined> {
    const provider = this.providers.get(source);
    return provider ? provider.read(threadId, id) : undefined;
  }
}
