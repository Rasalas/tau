import { useEffect, useSyncExternalStore } from "react";
import { Archive, Quote, X } from "lucide-react";
import { ComposerMenuItem, ComposerMenuSection, errorMessage, type ComposerControlProps, type ComposerInlineContext, type DesktopExtension, type HostSnapshot } from "tau";
import { buildHistory, stepHistory, type HistoryDirection, type HistoryPosition } from "./history.js";
import {
  CHIPS_SERVICE,
  FOLLOW_UP_OPTION,
  PROMPT_TOOLS_ID,
  STASH_CHANGED_EVENT,
  type ComposerContextChips,
  type FollowUpBehavior,
  type StashEntry,
} from "./protocol.js";
import { StashController, type HostApi } from "./stash.js";

/** Another thread's prompts are read again after this long. */
const PROJECT_PROMPTS_TTL_MS = 60_000;
const KEYS: Readonly<Record<string, HistoryDirection>> = { ArrowUp: "back", ArrowDown: "forward", Escape: "clear" };

export function ago(then: number, now = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function entryTitle(entry: StashEntry): string {
  const line = entry.text.trim().split("\n")[0] ?? "";
  if (line) return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  return entry.chips.map((chip) => chip.label).join(", ") || `${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`;
}

function entryDetail(entry: StashEntry): string {
  const parts = [ago(entry.createdAt)];
  if (entry.chips.length > 0) parts.push(`${entry.chips.length} chip${entry.chips.length === 1 ? "" : "s"}`);
  if (entry.images.length > 0) parts.push(`${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The thread's own prompts, newest first. */
export function threadPrompts(snapshot: HostSnapshot | undefined): string[] {
  return (snapshot?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.skill?.copyText ?? message.text)
    .reverse();
}

/**
 * The stash as a section of the composer's "…" menu: stash the draft, then
 * each entry to bring back, newest first, with a button to delete it.
 */
export function createStashControl(controller: StashController) {
  return function StashControl({ actions }: ComposerControlProps) {
    const project = actions?.activeThread()?.cwd;
    const entries = useSyncExternalStore(controller.subscribe, () => controller.list(project));
    useEffect(() => {
      if (project) controller.refresh(project).catch(() => undefined);
    }, [project]);
    if (!actions || !project) return null;
    const attempt = (work: () => Promise<unknown>) => { work().catch((error) => actions.notify(errorMessage(error))); };
    return (
      <ComposerMenuSection heading={entries.length > 0 ? `Stashed prompts · ${entries.length}` : "Stash"}>
        <ComposerMenuItem
          icon={<Archive size={13} />}
          label="Stash this draft"
          onSelect={() => attempt(async () => { if (!(await controller.stash(actions))) actions.notify("There is nothing to stash."); })}
        />
        {entries.map((entry) => (
          <span key={entry.id} className="prompt-stash-entry" title={entry.text || undefined}>
            <ComposerMenuItem label={entryTitle(entry)} detail={entryDetail(entry)} onSelect={() => attempt(() => controller.restore(actions, entry.id))} />
            <button type="button" className="prompt-stash-drop" aria-label={`Delete stashed prompt: ${entryTitle(entry)}`} onClick={() => attempt(() => controller.drop(project, entry.id))}>
              <X size={12} />
            </button>
          </span>
        ))}
      </ComposerMenuSection>
    );
  };
}

/** Recall state per draft, and the project's prompts as last read. */
export function createHistory(host: HostApi) {
  const positions = new Map<string, HistoryPosition>();
  const projects = new Map<string, { at: number; prompts: readonly string[] }>();
  const loading = new Set<string>();
  const prefetch = (snapshot: HostSnapshot | undefined) => {
    const cwd = snapshot?.cwd;
    if (!cwd || loading.has(cwd) || Date.now() - (projects.get(cwd)?.at ?? 0) < PROJECT_PROMPTS_TTL_MS) return;
    loading.add(cwd);
    host("project-prompts", { cwd, ...(snapshot.sessionId ? { excludeSessionId: snapshot.sessionId } : {}) })
      .then((prompts) => { projects.set(cwd, { at: Date.now(), prompts }); })
      .catch(() => undefined)
      .finally(() => loading.delete(cwd));
  };
  return {
    keyDown(event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; text: string }, context: ComposerInlineContext & { setText(text: string): void }): boolean {
      prefetch(context.snapshot);
      const direction = KEYS[event.key];
      if (!direction || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      const entries = buildHistory(threadPrompts(context.snapshot), projects.get(context.snapshot?.cwd ?? "")?.prompts ?? []);
      const step = stepHistory(direction, entries, positions.get(context.scope), event.text);
      if (!step) {
        positions.delete(context.scope);
        return false;
      }
      if (step.position) positions.set(context.scope, step.position);
      else positions.delete(context.scope);
      if (step.text !== event.text) context.setText(step.text);
      return true;
    },
  };
}

/** A quote as the text a composer without chips takes. */
export function quoteBlock(text: string): string {
  return text.split(/\r?\n/u).map((line) => line ? `> ${line}` : ">").join("\n");
}

export function citeLabel(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `“${flat.length > 40 ? `${flat.slice(0, 40)}…` : flat}”`;
}

/** Prompt Tools: stash drafts, recall earlier prompts, cite a reply, and say what ↵ does while a turn runs. */
const promptTools: DesktopExtension = {
  id: PROMPT_TOOLS_ID,
  name: "Prompt Tools",
  activate(context) {
    const host: HostApi = (command, input) => context.host.invoke(command, input) as never;
    const controller = new StashController(host);
    context.useService<ComposerContextChips>(CHIPS_SERVICE, (chips) => {
      controller.chips = chips;
      return () => { if (controller.chips === chips) controller.chips = undefined; };
    });
    context.host.onEvent(STASH_CHANGED_EVENT, (payload) => {
      const project = (payload as { project?: unknown } | undefined)?.project;
      if (typeof project === "string") controller.refresh(project).catch(() => undefined);
    });

    context.registerCommand({
      id: "prompt-tools.stash",
      label: "Stash the draft",
      group: "Composer",
      access: "write",
      run: async (actions) => { if (!(await controller.stash(actions))) actions.notify("There is nothing to stash."); },
    });
    // As in T3 Code: a terminal has nothing to stash, and Files Kit's editor saves on the same chord.
    context.registerKeybinding({ keys: "mod+s", commandId: "prompt-tools.stash", when: "!terminalFocus" });
    context.registerCommand({
      id: "prompt-tools.stash-list",
      label: "Bring back a stashed prompt…",
      group: "Composer",
      access: "write",
      // The stash lives in the composer's menu, whose trigger answers to this id.
      run: (actions) => {
        const trigger = document.querySelector<HTMLElement>('[data-composer-shortcut~="prompt-tools.stash-list"]');
        if (trigger) trigger.click();
        else actions.notify("The composer shows no menu here.");
      },
    });
    context.registerComposerControl({ id: "prompt-tools.stash", placement: "menu", shortcuts: ["prompt-tools.stash-list"], order: 40, profiles: ["desktop"], Component: createStashControl(controller) });

    const history = createHistory(host);
    context.registerComposerInline({ id: "prompt-tools.history", profiles: ["desktop"], keyDown: history.keyDown });

    context.registerMessageAction({
      id: "prompt-tools.cite",
      label: "Cite",
      Icon: Quote,
      profiles: ["desktop"],
      run: (message, { selection }, actions) => {
        const quote = (selection ?? message.text).trim();
        if (!quote) return;
        try {
          if (!controller.chips) throw new Error("no chip service");
          controller.chips.addChip({ kind: "text-excerpt", label: citeLabel(quote), payload: { source: "your earlier reply", text: quote } });
        } catch {
          const draft = actions.composerDraft().replace(/\s+$/u, "");
          actions.setComposerDraft?.(`${draft ? `${draft}\n\n` : ""}${quoteBlock(quote)}\n\n`);
        }
        actions.focusComposer();
      },
    });

    const followUp = (): FollowUpBehavior => context.preferences.value(PROMPT_TOOLS_ID, FOLLOW_UP_OPTION) === "steer" ? "steer" : "queue";
    context.registerOptions([{
      id: FOLLOW_UP_OPTION,
      kind: "select",
      label: "While a turn runs, the send key",
      values: [{ value: "queue", label: "queues a follow-up" }, { value: "steer", label: "steers the turn" }],
      defaultValue: "queue",
    }]);
    context.registerPromptHook({ id: "prompt-tools.delivery", streamingDelivery: () => followUp() === "steer" ? "steer" : "followUp" });
    context.registerCommand({
      id: "prompt-tools.toggle-follow-up",
      label: "Switch between queueing and steering while a turn runs",
      group: "Composer",
      access: "write",
      run: (actions) => {
        const next: FollowUpBehavior = followUp() === "steer" ? "queue" : "steer";
        context.preferences.setValue(PROMPT_TOOLS_ID, FOLLOW_UP_OPTION, next);
        actions.notify(next === "steer" ? "While a turn runs, the send key steers it." : "While a turn runs, the send key queues a follow-up.");
      },
    });
  },
};

export default promptTools;
