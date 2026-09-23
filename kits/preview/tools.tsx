import { useEffect, useState } from "react";
import { ArrowUpRight, Circle, Crosshair, MonitorSmartphone, PenLine, Send, Square, SquareDashed, StickyNote } from "lucide-react";
import { Menu, tooltipProps, type MenuSection, type WorkbenchActions } from "tau";
import { attachAnnotations, attachPickedElement, attachRecording } from "./attach.js";
import type { PreviewAnnotationTool } from "./page-overlay.js";
import { DEFAULT_PREVIEW_PROFILE, profileLabel, type PreviewAppearance, type PreviewProfiles, type PreviewState } from "./protocol.js";
import { previewKit } from "./store.js";
import { VIEWPORT_PRESETS } from "./viewport.js";

const NEW_PROFILE = "\u0000new";
const RENAME_PROFILE = "\u0000rename";
const DELETE_PROFILE = "\u0000delete";

const APPEARANCES: ReadonlyArray<{ id: PreviewAppearance; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** `125%`. */
export const zoomLabel = (factor: number): string => `${Math.round(factor * 100)}%`;

/** The page's viewport, zoom and appearance: T3 Code's device toolbar, as one menu. */
function ViewOptions({ state, run }: { state: PreviewState; run(work: () => Promise<unknown>): void }) {
  const [open, setOpen] = useState(false);
  const fixed = state.viewport.mode === "fixed" ? state.viewport : undefined;
  const sections: MenuSection[] = [
    {
      heading: "Viewport",
      items: [
        { id: "viewport:fill", label: "Fill the panel", selected: !fixed },
        ...VIEWPORT_PRESETS.map((preset) => ({
          id: `viewport:${preset.id}`,
          label: preset.label,
          hint: `${preset.width}×${preset.height}`,
          selected: fixed?.preset === preset.id,
        })),
      ],
    },
    { heading: "Appearance", items: APPEARANCES.map((entry) => ({ id: `appearance:${entry.id}`, label: entry.label, selected: state.appearance === entry.id })) },
    {
      heading: `Zoom · ${zoomLabel(state.zoom)}`,
      items: [
        { id: "zoom:in", label: "Zoom in", hint: "⌘+" },
        { id: "zoom:out", label: "Zoom out", hint: "⌘−" },
        { id: "zoom:reset", label: "Actual size", hint: "⌘0", disabled: state.zoom === 1 },
      ],
    },
  ];
  const choose = (id: string) => {
    setOpen(false);
    const [kind, value = ""] = id.split(":");
    const preset = VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (kind === "viewport") run(() => previewKit.viewport(preset ? { mode: "fixed", width: preset.width, height: preset.height, preset: preset.id } : { mode: "fill" }));
    else if (kind === "appearance") run(() => previewKit.appearance({ appearance: value as PreviewAppearance }));
    else if (kind === "zoom") run(() => previewKit.zoom({ step: value as "in" | "out" | "reset" }));
  };
  const label = fixed ? `Viewport ${fixed.width}×${fixed.height}` : "Viewport, zoom and appearance";
  return <span className="menu-anchor">
    <button
      type="button"
      className={fixed || state.appearance !== "system" ? "icon-button compact active" : "icon-button compact"}
      aria-label="Viewport, zoom and appearance"
      aria-haspopup="menu"
      aria-expanded={open}
      {...tooltipProps(label)}
      onClick={() => setOpen(!open)}
    ><MonitorSmartphone size={13} /></button>
    {open ? <Menu align="right" label="Viewport, zoom and appearance" sections={sections} onSelect={choose} onClose={() => setOpen(false)} /> : null}
  </span>;
}

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
  const [naming, setNaming] = useState<"new" | "rename" | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    void previewKit.profiles().then(setProfiles).catch(() => undefined);
  }, [active]);

  const use = (profile: string) => run(async () => setProfiles(await previewKit["use-profile"]({ name: profile })));
  const activeLabel = profileLabel(profiles, active);

  if (naming) {
    return <form
      className="preview-profile-name"
      onSubmit={(event) => {
        event.preventDefault();
        setNaming(undefined);
        const typed = name.trim();
        setName("");
        if (!typed) return;
        if (naming === "new") use(typed);
        else run(async () => setProfiles(await previewKit["rename-profile"]({ id: active, name: typed })));
      }}
    >
      <input
        aria-label={naming === "new" ? "New profile name" : `New name for ${activeLabel}`}
        placeholder="profile name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setNaming(undefined); }}
        onBlur={() => setNaming(undefined)}
      />
    </form>;
  }
  if (confirming) {
    return <span className="preview-profile-confirm" role="group" aria-label={`Delete ${activeLabel}`}>
      <span className="preview-hint">Delete “{activeLabel}” and its cookies?</span>
      <button type="button" className="text-button" autoFocus onClick={() => setConfirming(false)}>cancel</button>
      <button
        type="button"
        className="text-button danger"
        onClick={() => { setConfirming(false); run(async () => setProfiles(await previewKit["delete-profile"]({ id: active }))); }}
      >delete</button>
    </span>;
  }
  const listed = profiles?.profiles.includes(active) ? profiles.profiles : [...profiles?.profiles ?? [], active];
  return <select
    className="preview-profile"
    aria-label="Browser profile"
    {...tooltipProps("Browser profile: each has its own cookies and storage")}
    value={active}
    onChange={(event) => {
      const value = event.target.value;
      if (value === NEW_PROFILE) setNaming("new");
      else if (value === RENAME_PROFILE) { setName(activeLabel); setNaming("rename"); }
      else if (value === DELETE_PROFILE) setConfirming(true);
      else use(value);
    }}
  >
    {listed.map((profile) => <option key={profile} value={profile}>{profileLabel(profiles, profile)}</option>)}
    <option disabled>──────</option>
    <option value={NEW_PROFILE}>New profile…</option>
    <option value={RENAME_PROFILE}>Rename “{activeLabel}”…</option>
    {active !== DEFAULT_PREVIEW_PROFILE ? <option value={DELETE_PROFILE}>Delete “{activeLabel}”…</option> : null}
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
    {state.zoom !== 1 ? <button
      type="button"
      className="text-button preview-zoom"
      aria-label={`Zoom ${zoomLabel(state.zoom)}, reset to actual size`}
      {...tooltipProps("Actual size", { shortcut: "⌘0" })}
      onClick={() => run(() => previewKit.zoom({ step: "reset" }))}
    >{zoomLabel(state.zoom)}</button> : null}
    <ViewOptions state={state} run={run} />
    <ProfilePicker active={state.profile || "default"} run={run} />
  </div>;
}
