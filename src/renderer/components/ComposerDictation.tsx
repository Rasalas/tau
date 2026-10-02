import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { errorMessage } from "../../workbench/error-message";
import { dictationLanguage, insertDictation, type DictationPort } from "../dictation";
import { usePreferences } from "../renderer-services-context";
import "./composer-dictation.css";

/** Retain the insertion point, then follow our own inserts without replacing edits made during recording. */
export function NativeComposerDictation({ port, text, inputRef, updateDraft, onActiveChange }: {
  port: DictationPort; text: string; inputRef: RefObject<HTMLTextAreaElement | null>; updateDraft(text: string): void; onActiveChange?(active: boolean): void;
}) {
  const preferences = usePreferences();
  const { dictationLanguage: language } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const selection = useRef({ start: 0, end: 0, text: "" });
  const latest = useRef(text);
  latest.current = text;
  return <ComposerDictation port={port} language={language} onActiveChange={onActiveChange}
    capture={() => { const input = inputRef.current; selection.current = { start: input?.selectionStart ?? text.length, end: input?.selectionEnd ?? text.length, text }; }}
    insert={(transcript) => {
      const captured = selection.current;
      const draft = latest.current;
      const unchanged = captured.text === draft;
      const next = insertDictation(draft, unchanged ? captured.start : draft.length, unchanged ? captured.end : draft.length, transcript);
      latest.current = next.text;
      selection.current = { text: next.text, start: next.caret, end: next.caret };
      updateDraft(next.text);
      // Do not open the software keyboard or steal the cursor on each speech result.
      requestAnimationFrame(() => { if (inputRef.current?.value === next.text) inputRef.current.setSelectionRange(next.caret, next.caret); });
    }} />;
}

export function ComposerDictation({ port, language = "", capture, insert, onActiveChange }: {
  port: DictationPort; language?: string; capture(): void; insert(text: string): void; onActiveChange?(active: boolean): void;
}) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<DictationPort["languages"]>>>();
  const [phase, setPhase] = useState<"idle" | "starting" | "downloading" | "recording" | "transcribing">("idle");
  const [preview, setPreview] = useState("");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const busy = useRef(false);
  const finishing = useRef(false);
  const inserted = useRef("");
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const activeRef = useRef(onActiveChange);
  activeRef.current = onActiveChange;
  const chosen = catalog ? dictationLanguage(catalog.languages, language, catalog.defaultLanguage ?? navigator.language) : undefined;

  function accept(text: string) {
    if (!text.startsWith(inserted.current)) return;
    const delta = text.slice(inserted.current.length);
    inserted.current = text;
    if (delta) insertRef.current(delta);
  }
  function idle() {
    busy.current = false; finishing.current = false;
    setPhase("idle"); setPreview(""); setLevel(0);
    activeRef.current?.(false);
  }
  useEffect(() => {
    let cancelled = false;
    setCatalog(undefined); setError(""); idle();
    void port.languages().then((result) => { if (!cancelled) setCatalog(result); }).catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; generation.current++; busy.current = false; activeRef.current?.(false); void port.cancel().catch(() => undefined); };
  }, [port]);

  async function finish() {
    if (!busy.current || finishing.current || phase !== "recording") return;
    finishing.current = true;
    setPhase("transcribing");
    const current = generation.current;
    try {
      const text = await port.finish();
      if (current !== generation.current) return;
      accept(text); idle();
    } catch (cause) {
      if (current !== generation.current) return;
      setError(errorMessage(cause)); idle();
      void port.cancel().catch(() => undefined);
    }
  }
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    const limit = setTimeout(() => void finishRef.current(), 300_000);
    return () => { clearInterval(timer); clearTimeout(limit); };
  }, [phase]);

  async function start() {
    if (busy.current || !chosen) return;
    busy.current = true;
    activeRef.current?.(true);
    const current = ++generation.current;
    inserted.current = ""; setPreview(""); setSeconds(0); setError("");
    capture(); setPhase("starting");
    let unlisten: (() => void) | undefined;
    try {
      if (port.listen) {
        unlisten = await port.listen((update) => {
          if (current !== generation.current || !busy.current) return;
          if (update.error || update.cancelled) {
            if (update.error) setError(update.error);
            generation.current++; idle(); unlisten?.();
            void port.cancel().catch(() => undefined);
            return;
          }
          accept(update.text);
          setPreview(update.preview ?? "");
          if (update.level !== undefined) setLevel(Math.max(0, Math.min(1, update.level)));
          if (update.limitReached) void finishRef.current();
        });
      }
      if (current !== generation.current) { unlisten?.(); return; }
      if (!catalog?.languages.find((item) => item.id === chosen)?.installed) { setPhase("downloading"); await port.download(chosen); }
      if (current !== generation.current) { unlisten?.(); return; }
      await port.start(chosen);
      if (current === generation.current) setPhase("recording");
    } catch (cause) {
      if (current === generation.current) { setError(errorMessage(cause)); idle(); void port.cancel().catch(() => undefined); }
      unlisten?.();
      return;
    }
    // A successful subscription is released at the next terminal phase, or on unmount.
    if (unlisten && current === generation.current) subscription.current = unlisten;
  }
  const subscription = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (phase === "idle") { subscription.current?.(); subscription.current = undefined; }
    return undefined;
  }, [phase]);
  useEffect(() => () => { subscription.current?.(); subscription.current = undefined; }, [port]);
  function cancel() {
    generation.current++; subscription.current?.(); subscription.current = undefined;
    idle(); void port.cancel().catch(() => undefined);
  }
  useEffect(() => {
    if (phase === "idle") return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } };
    const hidden = () => { if (document.visibilityState === "hidden") cancel(); };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", hidden);
    return () => { document.removeEventListener("keydown", escape, true); document.removeEventListener("visibilitychange", hidden); };
  }, [phase, port]);

  if (!catalog?.available) return error ? <span className="dictation-error" role="alert">{error}</span> : null;
  const recording = phase === "recording";
  const active = phase !== "idle";
  const status = recording ? "Listening" : phase === "downloading" ? "Downloading speech model…" : phase === "transcribing" ? "Finishing…" : "Starting microphone…";
  return <div className={`composer-dictation${active ? " is-active" : ""}`}>
    {active ? <div className="dictation-status">
      <div className="dictation-meter" aria-hidden="true">{[0.45, 0.7, 1, 0.65, 0.9, 0.55, 0.35].map((weight, index) => <i key={index} style={{ height: `${3 + level * weight * 17}px` }} />)}</div>
      <span role="status">{status}</span>
      {recording ? <span className="dictation-time">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span> : null}
      {preview ? <span className="dictation-preview">{preview}</span> : null}
      <button type="button" className="dictation-cancel" aria-label="Cancel dictation" title="Cancel remaining dictation, keep text already inserted" onClick={cancel}><X size={14} /></button>
    </div> : null}
    <button type="button" className={`dictation-button${active ? " is-active" : ""}`} aria-label={recording ? "Stop dictation" : "Dictate"} aria-pressed={active}
      title={!chosen ? "Choose a supported dictation language in Settings → General" : recording ? "Stop dictation" : "Dictate, transcribed on this device"}
      disabled={active && !recording || !chosen} onClick={() => { if (recording) void finish(); else void start(); }}>
      {recording ? <Square size={14} fill="currentColor" /> : active ? <LoaderCircle size={16} className="dictation-spinner" /> : <Mic size={17} />}
    </button>
    {error ? <span className="dictation-error" role="alert">{error}</span> : null}
  </div>;
}
