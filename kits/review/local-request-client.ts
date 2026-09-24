import type { HostExtensionClient } from "tau";
import type { LocalBranch, LocalEvidence, UploadPlan } from "./local-request.js";
import type { ReviewRequestDraft } from "./protocol.js";

/** Evidence Kit's desktop service, mirrored rather than imported: the part the local view reads. */
export const EVIDENCE_SERVICE = "tau.evidence/capture";
export const EVIDENCE_SOURCE = "tau.evidence";

export interface EvidenceService {
  image(threadId: string, id: string, thumb?: boolean): Promise<string | null>;
  subscribe(listener: (threadId: string) => void): () => void;
}

type ModelRef = { provider: string; id: string };

/** Review Kit's host commands for the local pull request, typed, with pictures cached. */
export interface LocalRequestClient {
  branch(base?: string): Promise<LocalBranch>;
  evidence(root: string, threads: readonly string[]): Promise<{ available: boolean; evidence: LocalEvidence[] }>;
  /** A thumbnail through Evidence Kit when it took the picture, else the picture itself. */
  image(frame: Pick<LocalEvidence, "threadId" | "source" | "id">, thumb: boolean): Promise<string | null>;
  describe(input: { base?: string; model?: ModelRef; prefer?: ModelRef; instructions?: string; template?: boolean; evidence?: string[] }): Promise<ReviewRequestDraft & { model?: string }>;
  plan(url?: string, branch?: string): Promise<UploadPlan>;
  attach(input: { url: string; body: string; branch?: string }): Promise<{ uploaded: number }>;
}

const CACHE = 300;

export function localRequestClient(host: HostExtensionClient, evidence: () => EvidenceService | undefined): LocalRequestClient {
  const images = new Map<string, Promise<string | null>>();
  return {
    branch: (base) => host.invoke("local-pr", base ? { base } : undefined) as Promise<LocalBranch>,
    evidence: (root, threads) => host.invoke("local-pr-evidence", { root, threads }) as Promise<{ available: boolean; evidence: LocalEvidence[] }>,
    image: (frame, thumb) => {
      const service = frame.source === EVIDENCE_SOURCE ? evidence() : undefined;
      const key = `${frame.threadId}\n${frame.source}\n${frame.id}\n${thumb && service ? "t" : "f"}`;
      const cached = images.get(key);
      if (cached) return cached;
      const read = (service
        ? service.image(frame.threadId, frame.id, thumb)
        : host.invoke("local-pr-image", { threadId: frame.threadId, source: frame.source, id: frame.id }) as Promise<string | null>).catch(() => null);
      images.set(key, read);
      while (images.size > CACHE) images.delete(images.keys().next().value!);
      return read;
    },
    describe: (input) => host.invoke("local-pr-describe", input) as Promise<ReviewRequestDraft & { model?: string }>,
    plan: (url, branch) => host.invoke("local-pr-upload-plan", url ? { url, ...(branch ? { branch } : {}) } : undefined) as Promise<UploadPlan>,
    attach: (input) => host.invoke("pr-attach-evidence", { ...input, uploadConfirmed: true }) as Promise<{ uploaded: number }>,
  };
}
