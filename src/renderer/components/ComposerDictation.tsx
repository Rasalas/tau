import { useEffect, useRef, useState } from "react";
import type { DictationPort } from "../dictation";

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
    void port.languages().then((result) => { if (alive.current && result.available) { setLanguages(result.languages); setLanguage(result.languages[0]?.id ?? ""); } }).catch(() => undefined);
    return () => { alive.current = false; generation.current++; void port.cancel(); };
  }, [port]);
  async function act(work: () => Promise<void>) {
    const current = ++generation.current;
    setError("");
    try { await work(); } catch (cause) { if (alive.current && current === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase("idle"); } }
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
