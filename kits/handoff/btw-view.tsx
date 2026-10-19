import { useEffect, useSyncExternalStore } from "react";
import { Copy, GitFork, MessageCircleQuestion, RotateCw } from "lucide-react";
import {
  Markdown,
  READ_ONLY_REASON,
  Spinner,
  errorMessage,
  tooltipProps,
  useCommandAllowed,
  type DesktopExtensionContext,
  type HostExtensionClient,
  type WorkbenchActions,
} from "tau";
import { BtwStore } from "./btw-store.js";
import { BTW_EVENT, BTW_STAGE_TAB, HANDOFF_EXTENSION_ID, NATIVE_FORK_RUNTIMES, sideTaskPrompt, type BtwChat } from "./protocol.js";

const PROFILES = ["desktop", "web"] as const;
const TITLE_CHARS = 36;

const tabTitle = (question: string): string => {
  const flat = question.replace(/\s+/gu, " ").trim();
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat || "Side question";
};

interface BtwTabParams extends Record<string, unknown> {
  chatId: string;
  title?: string;
}

const paramsOf = (params: Record<string, unknown>): BtwTabParams => ({
  chatId: typeof params.chatId === "string" ? params.chatId : "",
  ...(typeof params.title === "string" ? { title: params.title } : {}),
});

export interface BtwDeps {
  host: HostExtensionClient;
  /** Handoff's "Continue in…" for a runtime Tau cannot fork: a new thread that starts with a summary. */
  continueIn(runtime: string, actions: WorkbenchActions): Promise<void>;
  store?: BtwStore;
}

/**
 * Side questions on the desktop half: `/btw <question>` asks one, its answer
 * streams into a stage tab that stays until it is closed, and "Continue as side
 * task" turns it into a fork (or, where the runtime cannot fork, a new thread).
 */
export function registerSideQuestions(context: DesktopExtensionContext, { host, continueIn, store = new BtwStore() }: BtwDeps): () => void {
  const open = (chat: BtwChat, actions: Pick<WorkbenchActions, "openStageTab">) =>
    actions.openStageTab(BTW_STAGE_TAB, { chatId: chat.id, title: tabTitle(chat.question) } satisfies BtwTabParams, { key: chat.id });

  /** Asks the question about the thread on screen and shows its tab; a message when it could not. */
  const ask = async (question: string, actions: WorkbenchActions): Promise<string | undefined> => {
    const active = actions.activeThread();
    if (!active?.sessionId || active.draftPending) return "Send a message first: a side question is about the conversation so far.";
    const text = question.trim();
    if (!text) return "Add a question after /btw.";
    try {
      const chat = await host.invoke("btw-ask", { threadId: active.sessionId, question: text }) as BtwChat;
      store.apply(chat);
      open(chat, actions);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  };

  const retry = async (chat: BtwChat, actions: WorkbenchActions): Promise<void> => {
    try {
      store.apply(await host.invoke("btw-ask", { threadId: chat.threadId, question: chat.question, chatId: chat.id }));
    } catch (error) {
      actions.notify(errorMessage(error), "error");
    }
  };

  const continueAsTask = async (chat: BtwChat, actions: WorkbenchActions): Promise<void> => {
    if (actions.activeThread()?.sessionId !== chat.threadId) {
      actions.notify("Open the thread this question was asked in first.");
      return;
    }
    const prompt = sideTaskPrompt(chat.question, chat.answer);
    // A runtime Tau forks keeps the history and gets the worktree question; any other starts afresh with a summary.
    if (chat.entryId && NATIVE_FORK_RUNTIMES.includes(chat.backend) && actions.askFork) {
      await actions.askFork({ entryId: chat.entryId, prompt });
      return;
    }
    await continueIn(chat.backend, actions);
    actions.focusComposer(prompt);
  };

  function BtwTab({ params, handle, actions }: { params: BtwTabParams; handle: { setTitle(title: string): void; onClose(listener: () => void): () => void }; actions: WorkbenchActions }) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    const chat = store.chat(params.chatId);
    const gone = store.isGone(params.chatId);
    const mayAsk = useCommandAllowed(HANDOFF_EXTENSION_ID, "btw-ask");
    // After a reload the window knows nothing yet: the host keeps every open question.
    useEffect(() => {
      if (store.chat(params.chatId) || store.isGone(params.chatId)) return;
      void host.invoke("btw-get", { chatId: params.chatId }).then(
        (found) => { if (found) store.apply(found); else store.markGone(params.chatId); },
        () => undefined,
      );
    }, [params.chatId]);
    useEffect(() => {
      if (chat) handle.setTitle(tabTitle(chat.question));
    }, [chat?.question]);
    // Closing the tab ends the question: it is not kept anywhere else.
    useEffect(() => handle.onClose(() => {
      store.markGone(params.chatId);
      void host.invoke("btw-forget", { chatId: params.chatId }).catch(() => undefined);
    }), [handle, params.chatId]);

    if (!chat) {
      return <div className="stage-empty" role="status">{gone ? "This side question was closed." : <Spinner size="sm" label="Loading the side question" />}</div>;
    }
    const working = chat.status === "working";
    const canFork = !working && chat.status === "done";
    return (
      <section className="btw-view" aria-label="Side question">
        <header className="btw-head">
          <MessageCircleQuestion size={14} aria-hidden="true" />
          <span className="btw-eyebrow">Side question</span>
          <span className="btw-note">Not part of the thread</span>
          {chat.model ? <span className="btw-model" {...tooltipProps(`Answered by ${chat.model}`)}>{chat.model.split("/").at(-1)}</span> : null}
        </header>
        <div className="btw-body">
          <p className="btw-question">{chat.question}</p>
          {working && !chat.answer ? <div className="btw-working" role="status"><Spinner size="sm" label="Working" /><span>Working…</span></div> : null}
          {chat.answer ? <div className="btw-answer"><Markdown streaming={working}>{chat.answer}</Markdown></div> : null}
          {chat.status === "failed" ? (
            <p className="btw-error" role="alert">{chat.error ?? "The question could not be answered."}</p>
          ) : null}
        </div>
        <footer className="btw-foot">
          {chat.status === "failed" ? (
            <button type="button" aria-disabled={!mayAsk || undefined} {...tooltipProps(mayAsk ? "Ask again" : READ_ONLY_REASON)} onClick={() => { if (mayAsk) void retry(chat, actions); }}>
              <RotateCw size={12} aria-hidden="true" />Retry
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" disabled={!chat.answer} {...tooltipProps("Copy the answer")} onClick={() => void actions.copyText(chat.answer)}>
            <Copy size={12} aria-hidden="true" />Copy
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canFork}
            aria-disabled={!mayAsk || undefined}
            {...tooltipProps(!mayAsk ? READ_ONLY_REASON : "Continue this as a task of its own: a fork of the thread that starts from this question and its answer")}
            onClick={() => { if (mayAsk) void continueAsTask(chat, actions); }}
          >
            <GitFork size={12} aria-hidden="true" />Continue as side task
          </button>
        </footer>
      </section>
    );
  }

  const disposers = [
    context.registerStageTab<BtwTabParams>({
      kind: BTW_STAGE_TAB,
      profiles: PROFILES,
      title: (params) => paramsOf(params).title ?? "Side question",
      Icon: MessageCircleQuestion,
      render: (params, handle, actions) => <BtwTab params={paramsOf(params)} handle={handle} actions={actions} />,
      restore: (params) => Boolean(paramsOf(params).chatId),
    }),
    context.registerSlashCommand({
      name: "btw",
      description: "Ask a side question; the answer opens in its own tab and the thread stays as it is",
      argumentHint: "<question>",
      run: (args, actions) => ask(args, actions),
    }),
    context.registerCommand({
      id: "handoff.btw",
      label: "Ask a side question…",
      group: "Thread",
      access: "write",
      surfaces: ["thread-title"],
      // What is typed becomes the question; an empty composer gets the command to finish.
      run: async (actions) => {
        const draft = actions.composerDraft().trim();
        if (!draft) {
          actions.setComposerDraft?.("/btw ");
          actions.focusComposer();
          return;
        }
        const problem = await ask(draft.replace(/^\/btw\s+/u, ""), actions);
        if (problem) actions.notify(problem, "error");
        else actions.setComposerDraft?.("");
      },
    }),
  ];
  context.host.onEvent(BTW_EVENT, (payload) => store.apply(payload));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
    store.clear();
  };
}
