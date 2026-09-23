import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { CHIP_MARK, CHIP_SLOT, findChipTokens, mirrorSegments, removeChipToken, repairChipTokens, tokenAround, type ChipToken, type MirrorSegment } from "./composer-chips";

/** How a chip token draws: resolved to what holds it, or `undefined` for a token nothing holds any more. */
export interface ChipLook {
  icon?: ReactNode;
  state?: "busy" | "failed";
}

export interface ComposerInputProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  placeholder: string;
  maxHeight: number;
  /** The selected skill's range, drawn as a chip while the text still names it. */
  skill?: { start: number; end: number };
  lookChip(label: string): ChipLook | undefined;
  onValueChange(next: string, caret: number): void;
  onCaret(caret: number): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onOpenChip(label: string, anchor: HTMLElement): void;
}

const setSelection = (field: HTMLTextAreaElement, start: number, end = start, direction?: "forward" | "backward" | "none") => {
  field.setSelectionRange(start, end, direction);
};

/**
 * The composer's text field. A token in the text is laid out by the textarea
 * as plain characters, transparent while chips are drawn, and a mirror behind
 * it draws the same characters with the same metrics, so every chip sits
 * where its characters are. Without chips or mentions there is no mirror and
 * the textarea draws its own text.
 */
export function ComposerInput({ textareaRef, value, placeholder, maxHeight, skill, lookChip, onValueChange, onCaret, onKeyDown, onOpenChip }: ComposerInputProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const segments = useMemo(() => mirrorSegments(value, skill), [skill, value]);
  const tokens = useMemo(() => findChipTokens(value), [value]);
  const mirrored = segments.length > 0 && !composing;
  const pendingCaret = useRef<number | undefined>(undefined);
  const lastCaret = useRef(0);

  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    if (pendingCaret.current !== undefined) {
      setSelection(field, pendingCaret.current);
      pendingCaret.current = undefined;
    }
    field.style.height = "auto";
    const contentHeight = field.scrollHeight;
    if (contentHeight <= 0) {
      field.style.height = "";
    } else {
      field.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      field.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    }
    const mirror = mirrorRef.current;
    if (mirror) {
      // The field's client box leaves out a scrollbar, which moves where its lines wrap.
      mirror.style.width = `${field.clientWidth}px`;
      mirror.style.height = `${field.clientHeight}px`;
      mirror.scrollTop = field.scrollTop;
    }
  }, [maxHeight, mirrored, textareaRef, value]);

  const snap = (field: HTMLTextAreaElement) => {
    const { selectionStart: start, selectionEnd: end, selectionDirection } = field;
    if (start === end) {
      const token = tokenAround(tokens, start);
      if (token) {
        // A caret stepping in leaves on the far side; a click goes to the nearer edge.
        const previous = lastCaret.current;
        const target = previous <= token.start ? token.end : previous >= token.end ? token.start : start - token.start < token.end - start ? token.start : token.end;
        setSelection(field, target);
        lastCaret.current = target;
        onCaret(target);
        return;
      }
      lastCaret.current = start;
      return;
    }
    const from = tokenAround(tokens, start)?.start ?? start;
    const to = tokenAround(tokens, end)?.end ?? end;
    if (from !== start || to !== end) setSelection(field, from, to, selectionDirection);
    lastCaret.current = selectionDirection === "backward" ? from : to;
  };

  const deleteChip = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    if (field.selectionStart !== field.selectionEnd || event.altKey || event.metaKey || event.ctrlKey) return;
    const caret = field.selectionStart;
    const token = event.key === "Backspace"
      ? tokens.find((candidate) => candidate.end === caret)
      : tokens.find((candidate) => candidate.start === caret);
    if (!token) return;
    event.preventDefault();
    removeToken(field, token);
  };

  const removeToken = (field: HTMLTextAreaElement, token: ChipToken) => {
    // Through the editing command, so one undo brings the chip back.
    setSelection(field, token.start, token.end);
    if (typeof document.execCommand === "function" && document.execCommand("delete")) return;
    const next = removeChipToken(value, token);
    pendingCaret.current = next.caret;
    onValueChange(next.text, next.caret);
  };

  const openChipAt = (event: MouseEvent<HTMLTextAreaElement>) => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    for (const chip of mirror.querySelectorAll<HTMLElement>("[data-chip]")) {
      for (const rect of chip.getClientRects()) {
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          onOpenChip(chip.dataset.chip ?? "", chip);
          return;
        }
      }
    }
  };

  return (
    <div className="composer-input">
      {mirrored ? <ComposerMirror ref={mirrorRef} segments={segments} lookChip={lookChip} /> : null}
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        className={mirrored ? "mirrored" : undefined}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          const repaired = composing ? undefined : repairChipTokens(value, next);
          if (repaired) {
            pendingCaret.current = repaired.caret;
            onValueChange(repaired.text, repaired.caret);
          } else {
            onValueChange(next, event.target.selectionStart);
          }
        }}
        onSelect={(event) => snap(event.currentTarget)}
        onClick={(event) => { onCaret(event.currentTarget.selectionStart); openChipAt(event); }}
        onKeyUp={(event) => onCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          onKeyDown(event);
          if (!event.defaultPrevented && (event.key === "Backspace" || event.key === "Delete")) deleteChip(event);
        }}
        onScroll={(event) => { if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop; }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
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

/**
 * One block per hard line: the textarea wraps each line on its own too, and a
 * keystroke then lays out only the line it changed.
 */
const ComposerMirror = memo(function ComposerMirror({ ref, segments, lookChip }: {
  ref: RefObject<HTMLDivElement | null>;
  segments: readonly MirrorSegment[];
  lookChip: ComposerInputProps["lookChip"];
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
  lookChip: ComposerInputProps["lookChip"];
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
