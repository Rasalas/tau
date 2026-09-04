import { useEffect } from "react";
import { CircleStop, Clock3, RefreshCw } from "lucide-react";

export function ReloadConflictDialog({
  runningThreads,
  onCancel,
  onWait,
  onAbort,
}: {
  runningThreads: number;
  onCancel(): void;
  onWait(): void;
  onAbort(): void;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [onCancel]);

  const threads = `${runningThreads} ${runningThreads === 1 ? "thread is" : "threads are"}`;
  return <div className="modal-scrim urgent reload-conflict-scrim">
    <section className="reload-conflict" role="dialog" aria-modal="true" aria-labelledby="reload-conflict-title">
      <header>
        <span className="reload-conflict-mark"><RefreshCw size={16} /></span>
        <span>
          <h2 id="reload-conflict-title">{threads} still running</h2>
          <small>Tau will not interrupt work without confirmation.</small>
        </span>
      </header>
      <div className="reload-conflict-body">
        <button type="button" className="reload-choice primary" onClick={onWait} autoFocus>
          <Clock3 size={17} />
          <span><strong>Wait, then reload</strong><small>Apply changes when every running thread has finished.</small></span>
        </button>
        <button type="button" className="reload-choice danger" onClick={onAbort}>
          <CircleStop size={17} />
          <span><strong>Stop runs and reload</strong><small>Cancel all running work, then apply the changes now.</small></span>
        </button>
      </div>
      <footer>
        <span>Reloading now could lose unfinished work.</span>
        <span className="spacer" />
        <button type="button" onClick={onCancel}>Cancel</button>
      </footer>
    </section>
  </div>;
}
