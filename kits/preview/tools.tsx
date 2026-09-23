import { useEffect, useState } from "react";
import { ArrowUpRight, Circle, Cookie, Crosshair, PenLine, Send, Square, SquareDashed, StickyNote } from "lucide-react";
import type { WorkbenchActions } from "tau";
import { attachAnnotations, attachPickedElement, attachRecording } from "./attach.js";
import type { PreviewAnnotationTool } from "./page-overlay.js";
import type { PreviewProfiles, PreviewState } from "./protocol.js";
import { previewKit } from "./store.js";
import { cookieImportDialogs } from "./cookie-import-dialog.js";

const NEW_PROFILE = "\u0000new";

/** `12 s`, `3:05`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function RecordingClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="preview-recording-clock">{elapsed(now - since)}</span>;
}

function ProfilePicker({ active, run }: { active: string; run(work: () => Promise<unknown>): void }) {
  const [profiles, setProfiles] = useState<PreviewProfiles | undefined>();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    void previewKit.profiles().then(setProfiles).catch(() => undefined);
  }, [active]);

  const use = (profile: string) => run(async () => setProfiles(await previewKit["use-profile"]({ name: profile })));

  if (naming) {
    return <form
      className="preview-profile-name"
      onSubmit={(event) => {
        event.preventDefault();
        setNaming(false);
        if (name.trim()) use(name);
        setName("");
      }}
    >
      <input
        aria-label="New profile name"
        placeholder="profile name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setNaming(false); }}
        onBlur={() => setNaming(false)}
      />
    </form>;
  }
  const listed = profiles?.profiles.includes(active) ? profiles.profiles : [...profiles?.profiles ?? [], active];
  return <select
    className="preview-profile"
    aria-label="Browser profile"
    title="Browser profile: each has its own cookies and storage"
    value={active}
    onChange={(event) => {
      if (event.target.value === NEW_PROFILE) setNaming(true);
      else use(event.target.value);
    }}
  >
    {listed.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
    <option value={NEW_PROFILE}>New profile…</option>
  </select>;
}

const TOOLS: ReadonlyArray<{ tool: PreviewAnnotationTool; label: string; Icon: typeof Square }> = [
  { tool: "rect", label: "Rectangle", Icon: SquareDashed },
  { tool: "arrow", label: "Arrow", Icon: ArrowUpRight },
  { tool: "note", label: "Note", Icon: StickyNote },
];

/**
 * The row under the address bar: pick an element, annotate the page, record
 * it, and the profile it runs in. What each produces goes to the composer.
 */
export function PreviewTools({ state, actions, run }: {
  state: PreviewState;
  actions: WorkbenchActions;
  run(work: () => Promise<unknown>): void;
}) {
  const [tool, setTool] = useState<PreviewAnnotationTool>("rect");
  const loaded = Boolean(state.url);
  const attached = (failure: string | undefined) => { if (failure) throw new Error(failure); };

  if (state.mode === "annotate") {
    return <div className="preview-tools annotating" role="toolbar" aria-label="Annotate">
      {TOOLS.map(({ tool: value, label, Icon }) => <button
        key={value}
        type="button"
        className={value === tool ? "icon-button compact active" : "icon-button compact"}
        aria-label={label}
        aria-pressed={value === tool}
        title={label}
        onClick={() => { setTool(value); run(() => previewKit.annotate({ tool: value })); }}
      ><Icon size={13} /></button>)}
      <span className="preview-hint">draw on the page, then send</span>
      <span className="spacer" />
      <button type="button" className="text-button" onClick={() => run(() => previewKit["annotate-cancel"]())}>cancel</button>
      <button
        type="button"
        className="text-button primary"
        onClick={() => run(async () => {
          const sent = await previewKit["annotate-send"]();
          if (sent) attached(attachAnnotations(actions, sent));
        })}
      ><Send size={12} /> send</button>
    </div>;
  }

  if (state.mode === "pick") {
    return <div className="preview-tools picking" role="toolbar" aria-label="Pick an element">
      <Crosshair size={13} aria-hidden="true" />
      <span className="preview-hint">click an element in the page · Esc cancels</span>
      <span className="spacer" />
      <button type="button" className="text-button" onClick={() => run(() => previewKit["pick-cancel"]())}>cancel</button>
    </div>;
  }

  const recording = state.recordingSince !== undefined;
  return <div className="preview-tools" role="toolbar" aria-label="Preview tools">
    <button
      type="button"
      className="icon-button compact"
      aria-label="Pick an element"
      title="Pick an element for the prompt"
      disabled={!loaded}
      onClick={() => run(async () => {
        const picked = await previewKit.pick();
        if (picked) attached(attachPickedElement(actions, picked));
      })}
    ><Crosshair size={13} /></button>
    <button
      type="button"
      className="icon-button compact"
      aria-label="Annotate the page"
      title="Draw on the page and send it with notes"
      disabled={!loaded}
      onClick={() => { setTool("rect"); run(() => previewKit.annotate({ tool: "rect" })); }}
    ><PenLine size={13} /></button>
    <button
      type="button"
      className={recording ? "icon-button compact recording" : "icon-button compact"}
      aria-label={recording ? "Stop recording" : "Record the preview"}
      title={recording ? "Stop and attach the recording" : "Record the preview as video"}
      disabled={!loaded && !recording}
      onClick={() => run(async () => {
        if (!recording) return previewKit["record-start"]();
        const saved = await previewKit["record-stop"]();
        if (saved) attached(attachRecording(actions, saved));
      })}
    >{recording ? <Square size={11} /> : <Circle size={12} />}</button>
    {recording ? <RecordingClock since={state.recordingSince!} /> : null}
    <span className="spacer" />
    <button
      type="button"
      className="icon-button compact"
      aria-label="Import cookies from a browser"
      title="Import sign-ins from another browser into a profile"
      onClick={() => { void cookieImportDialogs.open({ profile: state.profile || "default" }); }}
    ><Cookie size={13} /></button>
    <ProfilePicker active={state.profile || "default"} run={run} />
  </div>;
}
