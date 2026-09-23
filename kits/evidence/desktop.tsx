import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Images } from "lucide-react";
import { ConfirmDialog, errorMessage, useWorkbench, type DesktopExtension, type DesktopExtensionContext, type RegionProps, type TranscriptRowsHandle } from "tau";
import { settledTurn, turnAnchor } from "./anchor.js";
import { EvidenceCard } from "./card.js";
import { EvidenceClient } from "./client.js";
import {
  EVIDENCE_CHANGED_EVENT,
  EVIDENCE_EXTENSION_ID,
  EVIDENCE_PAUSED_EVENT,
  EVIDENCE_SERVICE,
  type EvidenceCaptureService,
  type EvidenceTurn,
} from "./protocol.js";
import { EvidenceSettingsPage } from "./settings-page.js";
import { EvidenceViewer, type ViewerRequest } from "./viewer.js";

interface Placed {
  turn: EvidenceTurn;
  anchor?: string;
  running: boolean;
}

/**
 * Invisible region that turns the thread's pictures into transcript rows under
 * each turn's answer, and hosts the viewer and the delete question.
 */
function createController(client: EvidenceClient, rows: TranscriptRowsHandle) {
  return function EvidenceController({ actions }: RegionProps) {
    const { snapshot } = useWorkbench();
    useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
    const sessionId = snapshot?.sessionId;
    const streaming = Boolean(snapshot?.isStreaming);
    const messages = snapshot?.messages;
    const [viewer, setViewer] = useState<ViewerRequest>();
    const [deleting, setDeleting] = useState<{ threadId: string; turnId: string }>();
    const shown = useRef<string | undefined>(undefined);

    useEffect(() => {
      const previous = shown.current;
      shown.current = sessionId;
      if (previous && previous !== sessionId) {
        rows.clear(previous);
        client.forget(previous);
      }
      if (sessionId) void client.load(sessionId);
    }, [sessionId]);

    const thread = sessionId ? client.thread(sessionId) : undefined;
    const paused = sessionId ? client.paused()[sessionId] : undefined;
    const placed = useMemo<Placed[]>(() => (thread?.turns ?? []).map((turn) => {
      const settled = settledTurn(turn, streaming);
      const anchor = turnAnchor(settled, messages ?? []);
      return { turn, running: settled.endedAt === undefined, ...(anchor ? { anchor } : {}) };
    }), [messages, streaming, thread]);
    // Streaming changes the messages on every token; the rows change only when a placement does.
    const key = `${placed.map((entry) => `${entry.turn.turnId}:${String(entry.turn.frames.length)}:${entry.turn.frames.at(-1)?.id ?? ""}:${entry.anchor ?? ""}:${String(entry.running)}`).join("|")}#${paused ?? ""}`;

    useEffect(() => {
      if (!sessionId) return;
      rows.setRows(sessionId, placed.filter((entry) => entry.anchor || entry.running).map((entry) => ({
        id: entry.turn.turnId,
        ...(entry.anchor ? { afterMessageId: entry.anchor } : { fallbackToTail: true }),
        content: (
          <EvidenceCard
            client={client}
            threadId={sessionId}
            turn={entry.turn}
            running={entry.running}
            {...(entry.running && paused ? { paused } : {})}
            onOpen={(index, play) => setViewer({ threadId: sessionId, turn: entry.turn, index, ...(play ? { play } : {}) })}
          />
        ),
      })));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, sessionId]);

    if (deleting) {
      return (
        <ConfirmDialog
          title="Delete these pictures?"
          message="The turn's pictures are deleted from this machine. The conversation stays as it is."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(undefined);
            setViewer(undefined);
            void client.deleteTurn(target.threadId, target.turnId).catch((error: unknown) => actions.notify(errorMessage(error)));
          }}
        />
      );
    }
    if (!viewer) return null;
    return (
      <EvidenceViewer
        key={`${viewer.turn.turnId}:${String(viewer.index)}`}
        client={client}
        request={viewer}
        onClose={() => setViewer(undefined)}
        onDelete={() => setDeleting({ threadId: viewer.threadId, turnId: viewer.turn.turnId })}
        notify={(message) => actions.notify(message)}
      />
    );
  };
}

/**
 * Evidence: what the agent changed, seen — pictures of the Preview and of the
 * window it drives, per turn, under the turn's answer, with a viewer that
 * plays them and saves them as a short video.
 */
const evidence: DesktopExtension = {
  id: EVIDENCE_EXTENSION_ID,
  name: "Evidence",
  activate(context: DesktopExtensionContext) {
    const client = new EvidenceClient(context.host);
    const disposers: Array<() => void> = [];
    disposers.push(context.host.onEvent(EVIDENCE_CHANGED_EVENT, (payload) => {
      const threadId = (payload as { threadId?: unknown } | undefined)?.threadId;
      if (typeof threadId === "string") client.changed(threadId);
    }));
    disposers.push(context.host.onEvent(EVIDENCE_PAUSED_EVENT, (payload) => {
      const paused = (payload as { paused?: unknown } | undefined)?.paused;
      if (paused && typeof paused === "object") client.setPaused(paused as Record<string, string>);
    }));
    void (context.host.invoke("paused") as Promise<Record<string, string>>).then((paused) => client.setPaused(paused ?? {}), () => undefined);

    const rows = context.registerTranscriptRows("evidence", 30, { profiles: ["desktop"] });
    disposers.push(() => rows.dispose());
    disposers.push(context.registerRegion({ id: "evidence.controller", placement: "transcript-header", order: 110, profiles: ["desktop"], Component: createController(client, rows) }));
    disposers.push(context.registerSettingsPage({
      id: "evidence",
      label: "Evidence",
      Icon: Images,
      scope: "both",
      profiles: ["desktop"],
      keywords: ["screenshots", "pictures", "video", "recording", "privacy", "review"],
      Component: EvidenceSettingsPage,
    }));

    const service: EvidenceCaptureService = {
      pause: async (threadId, reason) => { await context.host.invoke("pause", { threadId, reason }); },
      resume: async (threadId) => { await context.host.invoke("resume", { threadId }); },
      list: async (threadId) => await client.load(threadId) ?? { threadId, turns: [] },
      image: (threadId, id, thumb) => client.image(threadId, id, thumb),
      subscribe: (listener) => client.onChanged(listener),
    };
    disposers.push(context.provideService(EVIDENCE_SERVICE, service));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
};

export default evidence;
