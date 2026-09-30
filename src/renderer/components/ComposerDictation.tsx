import { useEffect, useRef, useState, type RefObject } from "react";
import { errorMessage } from "../../workbench/error-message";
import { insertDictation, type DictationPort } from "../dictation";

/** The native client's editor adapter retains the insertion point during recording. */
export function NativeComposerDictation({ port, text, inputRef, updateDraft }: {
  port: DictationPort; text: string; inputRef: RefObject<HTMLTextAreaElement | null>; updateDraft(text: string): void;
}) {
  const selection = useRef({ start: 0, end: 0, text: "" });
  return <ComposerDictation port={port}
    capture={() => { const input = inputRef.current; selection.current = { start: input?.selectionStart ?? text.length, end: input?.selectionEnd ?? text.length, text }; }}
    insert={(transcript) => {
      const captured = selection.current;
      const next = insertDictation(text, captured.text === text ? captured.start : text.length, captured.text === text ? captured.end : text.length, transcript);
      updateDraft(next.text);
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.caret, next.caret); });
    }} />;
}

export function ComposerDictation({ port, capture, insert }: { port: DictationPort; capture(): void; insert(text: string): void }) {
  const [languages, setLanguages] = useState<Array<{ id: string; name: string; installed: boolean }>>([]);
  const [language, setLanguage] = useState("");
  const [phase, setPhase] = useState<"idle" | "starting" | "downloading" | "recording" | "transcribing" | "review">("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setLanguages([]); setLanguage(""); setPhase("idle"); setTranscript(""); setError("");
    void port.languages().then((result) => { if (!cancelled && result.available) { setLanguages(result.languages); setLanguage(result.languages[0]?.id ?? ""); } }).catch(() => undefined);
    return () => { cancelled = true; alive.current = false; generation.current++; void port.cancel(); };
  }, [port]);
  async function act(work: () => Promise<void>) {
    const current = ++generation.current;
    setError("");
    try { await work(); } catch (cause) { if (alive.current && current === generation.current) { setError(errorMessage(cause)); setPhase("idle"); } }
  }
  async function finish() {
    setPhase("transcribing");
    const current = generation.current;
    const text = await port.finish();
    if (!alive.current || current !== generation.current) return;
    setTranscript(text); setPhase("review");
  }
  const finishRecording = useRef<() => void>(() => undefined);
  finishRecording.current = () => { void act(finish); };
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setTimeout(() => finishRecording.current(), 300_000);
    return () => clearTimeout(timer);
  }, [phase]);
  if (!languages.length) return null;
  return <div className="composer-dictation">
    {phase === "idle" ? <>
      <select aria-label="Dictation language" value={language} onChange={(event) => setLanguage(event.target.value)}>{languages.map((item) => <option key={item.id} value={item.id}>{item.name}{item.installed ? "" : " · download required"}</option>)}</select>
      <button type="button" className="runtime-chip" onClick={() => { capture(); setPhase("starting"); void act(async () => { const current = generation.current; if (!languages.find((item) => item.id === language)?.installed) { setPhase("downloading"); await port.download(language); } if (current !== generation.current || !alive.current) return; await port.start(language); if (current === generation.current && alive.current) setPhase("recording"); }); }}>Dictate</button>
    </> : <>
      <span role="status">{phase === "recording" ? "Recording locally · up to 5 minutes" : phase === "downloading" ? "Downloading Apple's language model…" : phase === "transcribing" ? "Transcribing on this iPhone…" : phase === "starting" ? "Waiting for microphone permission…" : "Review dictation"}</span>
      {phase === "recording" ? <button type="button" onClick={() => void act(finish)}>Stop recording</button> : null}
      {phase === "review" ? <><textarea aria-label="Dictation transcript" value={transcript} onChange={(event) => setTranscript(event.target.value)} /><button type="button" disabled={!transcript.trim()} onClick={() => { insert(transcript); setPhase("idle"); }}>Insert into draft</button></> : null}
      <button type="button" onClick={() => { generation.current++; void port.cancel(); setPhase("idle"); setTranscript(""); }}>Cancel dictation</button>
    </>}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
