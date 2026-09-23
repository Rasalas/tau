import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { WorkbenchShellContext } from "../workbench-context";
import type { SelectedSkill } from "./ComposerAutocomplete";
import { CHIP_MARK, CHIP_SLOT, mirrorSegments, removeChipToken, repairChipTokens, tokenAround, type ChipToken, type MirrorSegment } from "./composer-chips";
import { ComposerChipPopover } from "./ComposerChipPopover";
import { useComposerChips, type UseComposerChipsOptions } from "./useComposerChips";
import { useComposerCollapse } from "./useComposerCollapse";
import { composerFold } from "./composer-fold";

/** How a chip token draws: resolved to what holds it, or `undefined` for a token nothing holds any more. */
export interface ChipLook {
  icon?: ReactNode;
  state?: "busy" | "failed";
}

/** What the composer asks of the layer once it has loaded; until then chips are plain text. */
export interface ChipLayerApi {
  /** An edit that cut into a chip, made whole; undefined when nothing was cut. */
  repair(previous: string, next: string): { text: string; caret: number } | undefined;
  /** Before a send: drops the chips whose tokens the user deleted. */
  dropOrphans(text: string): void;
}

export interface ComposerChipLayerProps extends UseComposerChipsOptions {
  apiRef: RefObject<ChipLayerApi | undefined>;
  /** Drawn as a chip while the text still names it. */
  selectedSkill?: SelectedSkill;
  onNotify?(message: string): void;
  onPreview(imageId: number): void;
}

/** Something in the composer asks to stay open: a question, a menu, a search, a gate, the model picker. */
const BUSY = ".composer-frame.stacked, .composer-command-menu, .composer-history-search, .composer-gate, [aria-expanded=\"true\"]";

const NO_INLINES: readonly never[] = [];

/**
 * Chips inside the composer's text, loaded in its own chunk after the
 * textarea is up: the first key never waits for it. The textarea lays a token
 * out as plain characters; while the text holds a chip, a mention or the
 * selected skill, its glyphs turn transparent and a mirror behind it draws
 * the same characters, so every chip sits where its characters are. The layer
 * also keeps chips whole (the caret steps over them, Backspace takes one
 * whole), opens a chip's popover on a click, and folds the idle composer
 * while the transcript is scrolled back.
 */
export default function ComposerChipLayer(props: ComposerChipLayerProps) {
  const { textareaRef, selectedSkill, apiRef, setCaret, onNotify, onPreview, scope, scopeStore } = props;
  // The composer re-renders on any of these, and so does its layer.
  const registry = useContext(WorkbenchShellContext)?.registry;
  const inlines = registry?.getComposerInlines() ?? NO_INLINES;
  const { attachments, draft: text, submissionPending: paused } = scopeStore.getSnapshot(scope);
  const collapseEnabled = useSyncExternalStore(composerFold.subscribe, composerFold.get);
  const skill = selectedSkill && text.slice(selectedSkill.start, selectedSkill.end) === selectedSkill.invocation ? selectedSkill : undefined;
  const chips = useComposerChips({ ...props, text, inlines, attachments, paused });
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const segments = useMemo(() => mirrorSegments(text, skill), [skill, text]);
  const tokens = useMemo(() => findTokens(segments), [segments]);
  const mirrored = segments.length > 0 && !composing;
  const pendingCaret = useRef<number | undefined>(undefined);
  const [openChip, setOpenChip] = useState<{ label: string; point: { x: number; y: number } }>();
  const latest = useRef({ tokens, text, chips, updateDraft: props.updateDraft });
  latest.current = { tokens, text, chips, updateDraft: props.updateDraft };

  apiRef.current = {
    repair: (previous, next) => {
      if (composingRef.current) return undefined;
      const repaired = repairChipTokens(previous, next);
      if (repaired) pendingCaret.current = repaired.caret;
      return repaired;
    },
    dropOrphans: (sent) => latest.current.chips.dropOrphans(sent),
  };
  useEffect(() => () => { apiRef.current = undefined; }, [apiRef]);

  const syncMirror = () => {
    const field = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!field || !mirror) return;
    // Over the field in the frame; its client box leaves out a scrollbar, which moves where its lines wrap.
    mirror.style.left = `${field.offsetLeft}px`;
    mirror.style.top = `${field.offsetTop}px`;
    mirror.style.width = `${field.clientWidth}px`;
    mirror.style.height = `${field.clientHeight}px`;
    mirror.scrollTop = field.scrollTop;
  };

  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.classList.toggle("mirrored", mirrored);
    if (pendingCaret.current !== undefined && field.ownerDocument.activeElement === field) {
      field.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
    }
    pendingCaret.current = undefined;
    syncMirror();
  });

  // The textarea's own listeners: the composer's React handlers stay what they were.
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return undefined;
    let lastCaret = field.selectionStart;
    const snap = () => {
      if (field.ownerDocument.activeElement !== field) return;
      const { tokens: current } = latest.current;
      const { selectionStart: start, selectionEnd: end, selectionDirection } = field;
      if (start === end) {
        const token = tokenAround(current, start);
        if (!token) { lastCaret = start; return; }
        // A caret stepping in leaves on the far side; a click goes to the nearer edge.
        const target = lastCaret <= token.start ? token.end : lastCaret >= token.end ? token.start : start - token.start < token.end - start ? token.start : token.end;
        field.setSelectionRange(target, target);
        lastCaret = target;
        setCaret(target);
        return;
      }
      const from = tokenAround(current, start)?.start ?? start;
      const to = tokenAround(current, end)?.end ?? end;
      if (from !== start || to !== end) field.setSelectionRange(from, to, selectionDirection);
      lastCaret = selectionDirection === "backward" ? from : to;
    };
    // After the composer's own key handling, which bubbles to React's root first.
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== field || event.defaultPrevented || (event.key !== "Backspace" && event.key !== "Delete")) return;
      if (field.selectionStart !== field.selectionEnd || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
      const caret = field.selectionStart;
      const { tokens: current, text: value } = latest.current;
      const token = event.key === "Backspace" ? current.find((candidate) => candidate.end === caret) : current.find((candidate) => candidate.start === caret);
      if (!token) return;
      event.preventDefault();
      removeToken(field, token, value);
    };
    const onClick = (event: MouseEvent) => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      for (const chip of mirror.querySelectorAll<HTMLElement>("[data-chip]")) {
        for (const rect of chip.getClientRects()) {
          if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
            setOpenChip({ label: chip.dataset.chip ?? "", point: { x: rect.left, y: rect.top } });
            return;
          }
        }
      }
    };
    const onScroll = () => { if (mirrorRef.current) mirrorRef.current.scrollTop = field.scrollTop; };
    const onCompose = (event: CompositionEvent) => {
      composingRef.current = event.type === "compositionstart";
      setComposing(composingRef.current);
    };
    const view = field.ownerDocument.defaultView ?? window;
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncMirror);
    resize?.observe(field);
    field.addEventListener("select", snap);
    field.ownerDocument.addEventListener("selectionchange", snap);
    field.addEventListener("click", onClick);
    field.addEventListener("scroll", onScroll);
    field.addEventListener("compositionstart", onCompose);
    field.addEventListener("compositionend", onCompose);
    view.addEventListener("keydown", onKey);
    return () => {
      resize?.disconnect();
      field.removeEventListener("select", snap);
      field.ownerDocument.removeEventListener("selectionchange", snap);
      field.removeEventListener("click", onClick);
      field.removeEventListener("scroll", onScroll);
      field.removeEventListener("compositionstart", onCompose);
      field.removeEventListener("compositionend", onCompose);
      view.removeEventListener("keydown", onKey);
    };
  // The listeners read what changes through `latest`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textareaRef]);

  const removeToken = (field: HTMLTextAreaElement, token: ChipToken, value: string) => {
    // Through the editing command, so one undo brings the chip back.
    field.setSelectionRange(token.start, token.end);
    if (typeof document.execCommand === "function" && document.execCommand("delete")) return;
    const next = removeChipToken(value, token);
    pendingCaret.current = next.caret;
    latest.current.updateDraft(next.text);
  };

  const zoneRef = useMemo(() => ({ get current() { return textareaRef.current?.closest<HTMLElement>(".composer-zone") ?? null; } }), [textareaRef]);
  const idle = () => !latest.current.text.includes("\n") && !zoneRef.current?.querySelector(BUSY);
  const { collapsed } = useComposerCollapse({ enabled: collapseEnabled && !openChip, idle, zoneRef });
  useLayoutEffect(() => { zoneRef.current?.classList.toggle("collapsed", collapsed); }, [collapsed, zoneRef]);

  const openFromList = (label: string) => {
    const drawn = [...(mirrorRef.current?.querySelectorAll<HTMLElement>("[data-chip]") ?? [])].find((element) => element.dataset.chip === label);
    const rect = (drawn ?? textareaRef.current)?.getBoundingClientRect();
    setOpenChip({ label, point: { x: rect?.left ?? 0, y: rect?.top ?? 0 } });
  };

  return <>
    {mirrored ? <ComposerMirror ref={mirrorRef} segments={segments} lookChip={chips.lookChip} /> : null}
    {tokens.length > 0 ? (
      // For a screen reader and the keyboard's browse mode; the pointer clicks the chip itself.
      <div className="composer-chip-list" role="group" aria-label="Chips in the prompt">
        {tokens.map((token, index) => {
          const image = chips.chipFor(token.label)?.image;
          return image
            ? <button key={index} type="button" tabIndex={-1} aria-label={`Preview ${image.name}`} onClick={() => onPreview(image.id)} />
            : <button key={index} type="button" tabIndex={-1} aria-label={`Chip ${token.label}`} onClick={() => openFromList(token.label)} />;
        })}
      </div>
    ) : null}
    {openChip ? (
      <ComposerChipPopover
        label={openChip.label}
        point={openChip.point}
        entry={chips.chipFor(openChip.label)}
        scope={scope}
        registry={registry}
        onNotify={onNotify}
        onPreview={onPreview}
        onRemove={() => chips.removeChip(openChip.label)}
        onClose={() => setOpenChip(undefined)}
      />
    ) : null}
  </>;
}

/** The tokens the segments hold, with their offsets in the text. */
function findTokens(segments: readonly MirrorSegment[]): ChipToken[] {
  const tokens: ChipToken[] = [];
  let offset = 0;
  for (const segment of segments) {
    if (segment.kind === "chip") tokens.push({ start: offset, end: offset + segment.text.length, label: segment.label });
    offset += segment.text.length;
  }
  return tokens;
}

/** The segments of each hard line, with a key that changes whenever what the line draws does. */
function mirrorLines(segments: readonly MirrorSegment[]): Array<{ key: string; segments: MirrorSegment[] }> {
  const lines: Array<{ key: string; segments: MirrorSegment[] }> = [{ key: "", segments: [] }];
  for (const segment of segments) {
    const parts = segment.kind === "text" ? segment.text.split("\n") : [segment.text];
    parts.forEach((part, index) => {
      if (index > 0) lines.push({ key: "", segments: [] });
      const line = lines.at(-1)!;
      if (!part) return;
      line.segments.push(segment.kind === "text" ? { kind: "text", text: part } : segment);
      line.key += `${segment.kind}\u0000${part}\u0001`;
    });
  }
  return lines;
}

type LookChip = (label: string) => ChipLook | undefined;

/**
 * One block per hard line: the textarea wraps each line on its own too, and a
 * keystroke then lays out only the line it changed.
 */
const ComposerMirror = memo(function ComposerMirror({ ref, segments, lookChip }: {
  ref: RefObject<HTMLDivElement | null>;
  segments: readonly MirrorSegment[];
  lookChip: LookChip;
}) {
  return (
    <div ref={ref} className="composer-mirror" aria-hidden="true">
      {mirrorLines(segments).map((line, index) => <MirrorLine key={index} signature={line.key} segments={line.segments} lookChip={lookChip} />)}
    </div>
  );
});

const MirrorLine = memo(function MirrorLine({ segments, lookChip }: {
  signature: string;
  segments: readonly MirrorSegment[];
  lookChip: LookChip;
}) {
  // An empty line still takes a line's height, as it does in the textarea.
  if (segments.length === 0) return <div>{"\u200b"}</div>;
  return (
    <div>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return segment.text;
        if (segment.kind !== "chip") return <span key={index} className={`composer-mirror-${segment.kind}`}>{segment.text}</span>;
        const look = lookChip(segment.label);
        const state = look ? look.state ?? "" : "unresolved";
        // The same characters as the token: a mark, the icon's slot, the label, a mark.
        return (
          <span key={index} className={`composer-mirror-chip ${state}`} data-chip={segment.label}>
            {CHIP_MARK}<span className="composer-chip-slot">{CHIP_SLOT}{look?.icon}</span>{segment.label}{CHIP_MARK}
          </span>
        );
      })}
    </div>
  );
}, (previous, next) => previous.signature === next.signature && previous.lookChip === next.lookChip);
