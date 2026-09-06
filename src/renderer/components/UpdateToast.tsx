/** Offers the restart that installs a Tau the host already downloaded. */
export function UpdateToast({ version, onRestart, onDismiss }: {
  version: string;
  onRestart(): void;
  onDismiss(): void;
}) {
  return <div className="toast update-toast" data-level="info" role="status">
    <b>UPDATE</b>
    <span>Tau {version} downloaded, restart to install</span>
    <button type="button" onClick={onRestart}>Restart</button>
    <button type="button" className="dismiss" aria-label="Dismiss" onClick={onDismiss}>×</button>
  </div>;
}
