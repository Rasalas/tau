export type ReloadPhase = "building" | "extensions" | "restarting";

const phaseCopy: Record<ReloadPhase, { eyebrow: string; message: string }> = {
  building: { eyebrow: "Applying changes", message: "Building Tau" },
  extensions: { eyebrow: "Applying changes", message: "Reloading extensions" },
  restarting: { eyebrow: "Changes applied", message: "Restarting Tau" },
};

export function ReloadCurtain({ phase }: { phase: ReloadPhase }) {
  const copy = phaseCopy[phase];
  return <div className="reload-curtain" role="status" aria-live="polite" aria-label={copy.message}>
    <div className="reload-mark" aria-hidden="true">
      <span className="reload-orbit reload-orbit-outer" />
      <span className="reload-orbit reload-orbit-inner" />
      <span className="reload-pulse" />
      <div className="reload-constant">
        <strong>τ</strong>
        <small>2π</small>
      </div>
    </div>
    <p>{copy.eyebrow}</p>
    <h2>{copy.message}<span className="reload-ellipsis" aria-hidden="true">…</span></h2>
  </div>;
}
