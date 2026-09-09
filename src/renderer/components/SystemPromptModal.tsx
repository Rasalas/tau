import { useEffect, useState } from "react";
import { Check, Copy, FileText, Sparkles, Terminal, X } from "lucide-react";
import type { SystemPromptInspection } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";

export interface SystemPromptModalProps {
  threadId?: string;
  onClose(): void;
}

type TabKey = "effective" | "base" | "appends" | "context";

export function SystemPromptModal({ threadId, onClose }: SystemPromptModalProps) {
  const client = useHostClient();
  const [tab, setTab] = useState<TabKey>("effective");
  const [inspection, setInspection] = useState<SystemPromptInspection>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    if (!client) {
      setError("Host client unavailable.");
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
  }, [client, threadId]);

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

  return (
    <>
      <button className="project-modal-scrim" aria-label="Close system prompt modal" onClick={onClose} />
      <section
        className="project-modal system-prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Active Instructions and System Prompt"
        style={{ maxWidth: 780, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}
      >
        <header className="project-modal-title">
          <span>
            <strong>Active Instructions & System Prompt</strong>
            <small>Inspect the live prompt, customizations, and AGENTS.md loaded for this session</small>
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>

        <div style={{ padding: "12px 18px 0", borderBottom: "1px solid var(--line)" }}>
          <div className="segmented" style={{ width: "100%", justifyContent: "flex-start" }}>
            <button
              className={tab === "effective" ? "active" : ""}
              onClick={() => setTab("effective")}
            >
              <Terminal size={12} style={{ marginRight: 5, verticalAlign: "middle" }} />
              Effective Prompt
            </button>
            <button
              className={tab === "base" ? "active" : ""}
              onClick={() => setTab("base")}
            >
              <Sparkles size={12} style={{ marginRight: 5, verticalAlign: "middle" }} />
              Base Prompt
            </button>
            <button
              className={tab === "appends" ? "active" : ""}
              onClick={() => setTab("appends")}
            >
              Appends ({appends.length})
            </button>
            <button
              className={tab === "context" ? "active" : ""}
              onClick={() => setTab("context")}
            >
              <FileText size={12} style={{ marginRight: 5, verticalAlign: "middle" }} />
              Project Context ({contextFiles.length})
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px" }}>
          {loading ? (
            <p className="palette-empty" style={{ margin: "20px 0" }}>Loading active instructions…</p>
          ) : error ? (
            <div
              role="alert"
              style={{
                padding: "10px 12px",
                borderRadius: 6,
                backgroundColor: "var(--danger-bg, #fee2e2)",
                color: "var(--danger, #dc2626)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          ) : (
            <>
              {tab === "effective" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
                      {effectivePrompt.length} chars · ~{Math.round(effectivePrompt.length / 4)} tokens
                    </span>
                    <button
                      className="chrome-button"
                      style={{ fontSize: 11, padding: "4px 8px", display: "flex", alignItems: "center", gap: 4 }}
                      onClick={() => handleCopy(effectivePrompt)}
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                      <span>{copied ? "Copied" : "Copy Prompt"}</span>
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      background: "var(--well, #18181b)",
                      borderRadius: 8,
                      border: "1px solid var(--line-control)",
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      color: "var(--ink-2)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: "50vh",
                      overflowY: "auto",
                    }}
                  >
                    {effectivePrompt}
                  </pre>
                </div>
              ) : null}

              {tab === "base" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 6,
                      background: "var(--sunken)",
                      fontSize: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <strong>Prompt Source</strong>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
                      {baseSource ?? "Built-in harness default (~/.pi/agent or core harness)"}
                    </span>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      background: "var(--well)",
                      borderRadius: 8,
                      border: "1px solid var(--line-control)",
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      color: "var(--ink-2)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: "50vh",
                      overflowY: "auto",
                    }}
                  >
                    {basePrompt ?? "(Default Pi system prompt is active)"}
                  </pre>
                </div>
              ) : null}

              {tab === "appends" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {appends.length === 0 ? (
                    <p className="palette-empty">No prompt appends configured (.tau/append-system-prompt.md or .pi/APPEND_SYSTEM.md).</p>
                  ) : (
                    appends.map((item, idx) => (
                      <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", fontFamily: "var(--mono)" }}>
                          {item.source ?? `Append section #${idx + 1}`}
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 10,
                            background: "var(--well)",
                            borderRadius: 6,
                            border: "1px solid var(--line-control)",
                            fontFamily: "var(--mono)",
                            fontSize: 11.5,
                            lineHeight: 1.4,
                            color: "var(--ink-2)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {item.text}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              ) : null}

              {tab === "context" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {contextFiles.length === 0 ? (
                    <p className="palette-empty">No AGENTS.md or project instructions discovered in this workspace.</p>
                  ) : (
                    contextFiles.map((file, idx) => (
                      <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "6px 10px",
                            background: "var(--sunken)",
                            borderRadius: 6,
                          }}
                        >
                          <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>
                            {file.path}
                          </span>
                          <button
                            className="chrome-button"
                            style={{ fontSize: 10, padding: "2px 6px" }}
                            onClick={() => handleCopy(file.content)}
                          >
                            Copy
                          </button>
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 10,
                            background: "var(--well)",
                            borderRadius: 6,
                            border: "1px solid var(--line-control)",
                            fontFamily: "var(--mono)",
                            fontSize: 11.5,
                            lineHeight: 1.4,
                            color: "var(--ink-2)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: "35vh",
                            overflowY: "auto",
                          }}
                        >
                          {file.content}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>

        <footer style={{ padding: "10px 18px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end" }}>
          <button className="chrome-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </>
  );
}
