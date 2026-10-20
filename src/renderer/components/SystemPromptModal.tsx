import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, FileText, Sparkles, Terminal, X } from "lucide-react";
import type { SystemPromptInspection } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { Dialog } from "./ui/Dialog";
import { LoadError } from "./ui/LoadError";
import "./system-prompt.css";

export interface SystemPromptModalProps {
  threadId?: string;
  onClose(): void;
}

type TabKey = "effective" | "base" | "appends" | "context";
const TAB_KEYS: TabKey[] = ["effective", "base", "appends", "context"];

export function SystemPromptModal({ threadId, onClose }: SystemPromptModalProps) {
  const client = useHostClient();
  const [tab, setTab] = useState<TabKey>("effective");
  const [inspection, setInspection] = useState<SystemPromptInspection>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  /** Retry reads the instructions again. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    if (!client) {
      setError("The machine is not connected.");
      setLoading(false);
      return;
    }

    client
      .inspectSystemPrompt(threadId)
      .then((result) => {
        if (!cancelled) {
          setInspection(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to inspect system prompt.");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, client, threadId]);

  const handleCopy = async (text: string) => {
    if (!client) return;
    try {
      await client.copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore copy error
    }
  };

  const effectivePrompt = inspection?.effectivePrompt ?? "";
  const basePrompt = inspection?.basePrompt;
  const baseSource = inspection?.basePromptSource;
  const appends = inspection?.appends ?? [];
  const contextFiles = inspection?.contextFiles ?? [];
  const ids = useId();
  const tabs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});
  const tabLabels: Record<TabKey, ReactNode> = {
    effective: <><Terminal size={12} aria-hidden="true" />Effective prompt</>,
    base: <><Sparkles size={12} aria-hidden="true" />Base prompt</>,
    appends: <>Appends ({appends.length})</>,
    context: <><FileText size={12} aria-hidden="true" />Project context ({contextFiles.length})</>,
  };
  // Arrow keys move between the tabs, as a tab list does; Tab leaves for the panel.
  const onTabKey = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const next = step ? TAB_KEYS[(TAB_KEYS.indexOf(tab) + step + TAB_KEYS.length) % TAB_KEYS.length]
      : event.key === "Home" ? TAB_KEYS[0] : event.key === "End" ? TAB_KEYS.at(-1) : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabs.current[next]?.focus();
  };

  return (
    <Dialog className="project-modal system-prompt-modal" label="Active instructions and system prompt" onClose={onClose}>
      <header className="project-modal-title">
        <span>
          <strong>Active instructions & system prompt</strong>
          <small>Inspect the live prompt, customizations, and AGENTS.md loaded for this session</small>
        </span>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>

      <div className="system-prompt-tabs">
        <div className="segmented" role="tablist" aria-label="Prompt parts">
          {TAB_KEYS.map((key) => (
            <button
              key={key}
              ref={(element) => { tabs.current[key] = element; }}
              type="button"
              role="tab"
              id={`${ids}-tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === key ? 0 : -1}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
              onKeyDown={onTabKey}
            >
              {tabLabels[key]}
            </button>
          ))}
        </div>
      </div>

      <div className="system-prompt-body" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`}>
        {loading ? (
          <p className="palette-empty system-prompt-loading">Loading active instructions…</p>
        ) : error ? (
          <LoadError
            title="Could not read the instructions"
            description={client ? undefined : "The machine is not connected."}
            error={client ? error : undefined}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        ) : (
          <>
            {tab === "effective" ? (
              <div className="system-prompt-section">
                <div className="system-prompt-toolbar">
                  <span className="system-prompt-meta">
                    {effectivePrompt.length} chars · ~{Math.round(effectivePrompt.length / 4)} tokens
                  </span>
                  <button type="button" className="chrome-button system-prompt-copy" onClick={() => handleCopy(effectivePrompt)}>
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copied ? "Copied" : "Copy prompt"}</span>
                  </button>
                </div>
                <pre className="system-prompt-text tall">{effectivePrompt}</pre>
              </div>
            ) : null}

            {tab === "base" ? (
              <div className="system-prompt-section">
                <div className="system-prompt-source">
                  <strong>Prompt source</strong>
                  <span className="system-prompt-meta">
                    {baseSource ?? "Built-in harness default (~/.pi/agent or core harness)"}
                  </span>
                </div>
                <pre className="system-prompt-text tall">{basePrompt ?? "(Default Pi system prompt is active)"}</pre>
              </div>
            ) : null}

            {tab === "appends" ? (
              <div className="system-prompt-section">
                {appends.length === 0 ? (
                  <p className="palette-empty">No prompt appends configured (.tau/append-system-prompt.md or .pi/APPEND_SYSTEM.md).</p>
                ) : (
                  appends.map((item, idx) => (
                    <div key={idx} className="system-prompt-file">
                      <div className="system-prompt-meta strong">{item.source ?? `Append section #${idx + 1}`}</div>
                      <pre className="system-prompt-text">{item.text}</pre>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {tab === "context" ? (
              <div className="system-prompt-section">
                {contextFiles.length === 0 ? (
                  <p className="palette-empty">No AGENTS.md or project instructions discovered in this workspace.</p>
                ) : (
                  contextFiles.map((file, idx) => (
                    <div key={idx} className="system-prompt-file">
                      <div className="system-prompt-file-head">
                        <span>{file.path}</span>
                        <button type="button" className="chrome-button system-prompt-copy" aria-label={`Copy ${file.path}`} onClick={() => handleCopy(file.content)}>
                          Copy
                        </button>
                      </div>
                      <pre className="system-prompt-text short">{file.content}</pre>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      <footer className="system-prompt-footer">
        <button type="button" className="chrome-button" onClick={onClose}>
          Close
        </button>
      </footer>
    </Dialog>
  );
}
