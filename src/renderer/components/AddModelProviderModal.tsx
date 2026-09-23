import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { CustomProviderInput, UiModel } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";

export interface AddModelProviderModalProps {
  onClose(): void;
  onProviderAdded?(models: UiModel[]): void;
}

export function AddModelProviderModal({ onClose, onProviderAdded }: AddModelProviderModalProps) {
  const client = useHostClient();

  const [providerId, setProviderId] = useState("");
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [contextWindow, setContextWindow] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);

    const trimmedId = providerId.trim();
    const trimmedModelId = modelId.trim();

    if (!trimmedId) {
      setError("Provider ID is required.");
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmedId)) {
      setError("Provider ID may only contain letters, numbers, hyphens, dots, or underscores.");
      return;
    }
    if (baseUrl.trim() && !/^https?:\/\//i.test(baseUrl.trim())) {
      setError("Base URL must start with http:// or https://");
      return;
    }
    if (!trimmedModelId) {
      setError("Model ID is required.");
      return;
    }

    if (!client) {
      setError("Host client unavailable.");
      return;
    }

    setBusy(true);
    try {
      const input: CustomProviderInput = {
        providerId: trimmedId,
        name: providerName.trim() || trimmedId,
        baseUrl: baseUrl.trim() || undefined,
        api: api.trim() || "openai-compatible",
        apiKey: apiKey.trim() || undefined,
        models: [
          {
            id: trimmedModelId,
            name: modelName.trim() || trimmedModelId,
            contextWindow: contextWindow.trim() ? Number.parseInt(contextWindow.trim(), 10) : undefined,
          },
        ],
      };

      const models = await client.addModelProvider(input);
      onProviderAdded?.(models);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add model provider.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="project-modal-scrim" aria-label="Close modal" onClick={onClose} />
      <section
        className="project-modal add-provider-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add Model Provider"
        style={{ maxWidth: 460, width: "100%" }}
      >
        <header className="project-modal-title">
          <span>
            <strong>Add Model Provider</strong>
            <small>Configure custom endpoints and API keys for ~/.pi/agent</small>
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>

        <form onSubmit={handleSubmit} style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          {error ? (
            <div
              role="alert"
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                backgroundColor: "var(--danger-bg, #fee2e2)",
                color: "var(--danger, #dc2626)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
              PROVIDER ID *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. ollama, openrouter, custom"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--line-control)",
                background: "var(--well)",
                color: "var(--ink)",
                fontSize: 13,
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
              Provider name
            </label>
            <input
              type="text"
              placeholder="e.g. Ollama Local"
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--line-control)",
                background: "var(--well)",
                color: "var(--ink)",
                fontSize: 13,
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
              Base URL
            </label>
            <input
              type="text"
              placeholder="e.g. http://localhost:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--line-control)",
                background: "var(--well)",
                color: "var(--ink)",
                fontSize: 13,
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
                API protocol
              </label>
              <select
                value={api}
                onChange={(e) => setApi(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line-control)",
                  background: "var(--well)",
                  color: "var(--ink)",
                  fontSize: 13,
                }}
              >
                <option value="openai-compatible">openai-compatible</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
              </select>
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
                API key
              </label>
              <input
                type="password"
                placeholder="Optional / sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line-control)",
                  background: "var(--well)",
                  color: "var(--ink)",
                  fontSize: 13,
                }}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
                MODEL ID *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. llama3, mistral"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line-control)",
                  background: "var(--well)",
                  color: "var(--ink)",
                  fontSize: 13,
                }}
              />
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
                Model name
              </label>
              <input
                type="text"
                placeholder="Display name"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line-control)",
                  background: "var(--well)",
                  color: "var(--ink)",
                  fontSize: 13,
                }}
              />
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)" }}>
                Context window
              </label>
              <input
                type="number"
                placeholder="128000"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line-control)",
                  background: "var(--well)",
                  color: "var(--ink)",
                  fontSize: 13,
                }}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="modal-back"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="chrome-button primary"
              disabled={busy}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <Sparkles size={13} />
              <span>{busy ? "Saving…" : "Save Provider"}</span>
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
