import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";
import type { ClientStorage } from "../../workbench/client-storage";
import type { ComposerScope, ComposerScopeStore, PendingAttachment } from "../../workbench/composer-scope-store";
import { readComposerDraftState, writeComposerDraftState } from "../../workbench/draft-store";
import type { ComposerChipDetailProps, ComposerInlineContribution } from "../extension-system";
import { findChipTokens, insertChipTokens, removeChipToken, uniqueChipLabel, chipLabelText } from "./composer-chips";
import type { ChipLook } from "./ComposerInput";

/** Core's own slot in a draft's state: which chip each label in the text stands for. */
const LABELS_OWNER = "tau.composer.chips";
const IMAGE_OWNER = "image";

/** `a.ts 2` for `a.ts`: a label `uniqueChipLabel` made (its spaces are no-break spaces). */
const isNumbered = (label: string, base: string) => label.startsWith(`${base}\u00a0`) && /^\d+$/u.test(label.slice(base.length + 1));

type Inline = ComposerInlineContribution & { extensionId?: string; extensionName?: string };

/** A chip of the draft, whoever holds it, under the label its token reads. */
export interface ComposerChipEntry {
  key: string;
  label: string;
  look: ChipLook;
  title?: string;
  image?: PendingAttachment;
  Detail?: ComponentType<ComposerChipDetailProps>;
  inline?: Inline;
  id: string;
}

interface Candidate { key: string; base: string; entry: Omit<ComposerChipEntry, "label"> }

export interface UseComposerChipsOptions {
  scope: ComposerScope;
  text: string;
  /** The draft as the store holds it now, which an effect of the same commit may have changed. */
  readText(): string;
  draftStorageKey?: string;
  clientStorage: ClientStorage;
  inlines: readonly Inline[];
  attachments: readonly PendingAttachment[];
  scopeStore: ComposerScopeStore;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Where a menu that just closed left the caret; read once, the field's own caret otherwise. */
  insertAt: RefObject<number | undefined>;
  /** A prompt is on its way: its chips are hidden by their holders, not gone, so no token is taken out. */
  paused: boolean;
  updateDraft(next: string): void;
  setCaret(caret: number): void;
}

/**
 * Keeps the draft's chip tokens and the chips their holders keep in step: a
 * new chip gets a token at the caret, a chip its holder dropped loses its
 * token, and a token the user deleted leaves its chip until the prompt is
 * sent (so an undo brings it back); the send drops those.
 */
export function useComposerChips({ scope, text, readText, draftStorageKey, clientStorage, inlines, attachments, scopeStore, textareaRef, insertAt, paused, updateDraft, setCaret }: UseComposerChipsOptions) {
  const chipInlines = useMemo(() => inlines.filter((inline) => inline.chips), [inlines]);
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribers = chipInlines.map((inline) => inline.subscribe?.(listener));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe?.(); };
  }, [chipInlines]);
  const [version, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((value) => value + 1)), [subscribe]);

  const labelsByScope = useRef(new Map<string, Map<string, string>>());
  const seen = useRef(new Set<string>());
  const labelsFor = useCallback((target: string) => {
    let labels = labelsByScope.current.get(target);
    if (!labels) {
      const stored = readComposerDraftState(clientStorage, draftStorageKey, LABELS_OWNER) as { labels?: unknown } | undefined;
      labels = new Map(Array.isArray(stored?.labels) ? stored.labels.filter((pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") : []);
      labelsByScope.current.set(target, labels);
    }
    return labels;
  }, [clientStorage, draftStorageKey]);

  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = [];
    for (const inline of chipInlines) {
      for (const chip of inline.chips!.list(scope)) {
        const Icon = chip.icon;
        list.push({
          key: `${inline.id}:${chip.id}`,
          base: chip.label,
          entry: {
            key: `${inline.id}:${chip.id}`,
            id: chip.id,
            inline,
            look: { ...(Icon ? { icon: <Icon size={11} className="composer-chip-icon" aria-hidden /> } : {}), ...(chip.state ? { state: chip.state } : {}) },
            ...(chip.title ? { title: chip.title } : {}),
            ...(chip.Detail ? { Detail: chip.Detail } : {}),
          },
        });
      }
    }
    for (const image of attachments) {
      list.push({
        key: `${IMAGE_OWNER}:${image.id}`,
        base: image.name,
        entry: { key: `${IMAGE_OWNER}:${image.id}`, id: String(image.id), image, look: { icon: <img className="composer-chip-thumb" src={image.previewUrl} alt="" /> } },
      });
    }
    return list;
  // `version` stands for whatever the holders changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, chipInlines, scope, version]);

  const [labelsVersion, setLabelsVersion] = useState(0);
  useEffect(() => {
    const labels = labelsFor(scope);
    const current = readText();
    const tokens = findChipTokens(current);
    const tokenLabels = new Set(tokens.map((token) => token.label));
    const present = new Set(candidates.map((candidate) => candidate.key));
    const owners = new Set([IMAGE_OWNER, ...chipInlines.map((inline) => inline.id)]);
    let next = current;
    let changed = false;
    // While a prompt is on its way its chips are hidden, not gone; new ones still get tokens.
    for (const [key, label] of paused ? [] : [...labels]) {
      if (present.has(key)) continue;
      const owner = key.slice(0, key.indexOf(":"));
      // A kit that is not loaded yet still holds its chips; images do not outlive the window.
      if (!owners.has(owner) || (owner !== IMAGE_OWNER && !seen.current.has(key))) continue;
      labels.delete(key);
      changed = true;
      for (const token of findChipTokens(next).filter((candidate) => candidate.label === label).reverse()) next = removeChipToken(next, token).text;
    }
    const bound = new Set(labels.values());
    const inserts: string[] = [];
    for (const candidate of candidates) {
      seen.current.add(candidate.key);
      if (labels.has(candidate.key)) continue;
      const base = chipLabelText(candidate.base);
      // A token that came back with the text (a restored stash, a reload) takes its chip back.
      const adopted = tokens.find((token) => !bound.has(token.label) && (token.label === base || isNumbered(token.label, base)))?.label;
      const label = adopted ?? uniqueChipLabel(base, new Set([...bound, ...tokenLabels]));
      labels.set(candidate.key, label);
      bound.add(label);
      changed = true;
      if (!tokenLabels.has(label)) inserts.push(label);
    }
    if (!changed) return;
    writeComposerDraftState(clientStorage, draftStorageKey, LABELS_OWNER, labels.size > 0 ? { labels: [...labels] } : undefined);
    setLabelsVersion((value) => value + 1);
    const field = textareaRef.current;
    const focused = field !== null && field.ownerDocument.activeElement === field;
    let caret: number | undefined;
    if (inserts.length > 0) {
      const at = focused ? Math.min(insertAt.current ?? field!.selectionStart, next.length) : next.length;
      insertAt.current = undefined;
      const inserted = insertChipTokens(next, at, inserts);
      next = inserted.text;
      caret = inserted.caret;
    }
    if (next === current) return;
    updateDraft(next);
    if (caret !== undefined && focused) {
      const at = caret;
      setCaret(at);
      // After any frame callback that placed the caret for the edit that added the chip.
      requestAnimationFrame(() => requestAnimationFrame(() => field!.setSelectionRange(at, at)));
    }
    // `text` stands for the draft `readText` answers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, chipInlines, clientStorage, draftStorageKey, insertAt, labelsFor, paused, readText, scope, setCaret, text, textareaRef, updateDraft]);

  const byLabel = useMemo(() => {
    const labels = labelsFor(scope);
    const map = new Map<string, ComposerChipEntry>();
    for (const candidate of candidates) {
      const label = labels.get(candidate.key);
      if (label !== undefined) map.set(label, { ...candidate.entry, label });
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, labelsFor, labelsVersion, scope]);

  const lookChip = useCallback((label: string) => byLabel.get(label)?.look, [byLabel]);
  const chipFor = useCallback((label: string) => byLabel.get(label), [byLabel]);

  const dropChip = useCallback((entry: ComposerChipEntry) => {
    if (entry.image) scopeStore.removeAttachment(scope, entry.image.id);
    else entry.inline?.chips?.remove(scope, entry.id);
  }, [scope, scopeStore]);

  /** Takes a chip out of the text and out of its holder. */
  const removeChip = useCallback((label: string) => {
    const entry = byLabel.get(label);
    let next = text;
    for (const token of findChipTokens(text).filter((candidate) => candidate.label === label).reverse()) next = removeChipToken(next, token).text;
    if (next !== text) updateDraft(next);
    if (entry) dropChip(entry);
  }, [byLabel, dropChip, text, updateDraft]);

  /** Before a send: the chips whose tokens the user deleted go, so the prompt carries only what it shows. */
  const dropOrphans = useCallback((sent: string) => {
    const shown = new Set(findChipTokens(sent).map((token) => token.label));
    const labels = labelsFor(scope);
    for (const candidate of candidates) {
      const label = labels.get(candidate.key);
      if (label !== undefined && !shown.has(label)) dropChip({ ...candidate.entry, label });
    }
  }, [candidates, dropChip, labelsFor, scope]);

  return { lookChip, chipFor, removeChip, dropOrphans, hasChipInlines: chipInlines.length > 0 };
}
