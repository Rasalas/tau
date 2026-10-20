import { useId, useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import type { CustomProviderInput, UiModel } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { Dialog } from "./ui/Dialog";
import "./add-model-provider.css";

export interface AddModelProviderModalProps {
  onClose(): void;
  onProviderAdded?(models: UiModel[]): void;
}

/** One labelled field: the label names the control it sits over. */
function Field({ label, required = false, wide = false, children }: {
  label: string;
  required?: boolean;
  wide?: boolean;
  children(id: string): ReactNode;
}) {
  const id = useId();
  return (
    <div className={`add-provider-field${wide ? " wide" : ""}`}>
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      {children(id)}
    </div>
  );
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
      setError("The machine is not connected.");
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
    <Dialog className="project-modal add-provider-modal" label="Add model provider" onClose={onClose}>
      <header className="project-modal-title">
        <span>
          <strong>Add model provider</strong>
          <small>Configure custom endpoints and API keys for ~/.pi/agent</small>
        </span>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>

      <form className="add-provider-form" onSubmit={handleSubmit}>
        {error ? <div role="alert" className="add-provider-error">{error}</div> : null}

        <Field label="Provider ID" required>
          {(id) => <input
            id={id}
            type="text"
            required
            autoFocus
            placeholder="e.g. ollama, openrouter, custom"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          />}
        </Field>

        <Field label="Provider name">
          {(id) => <input id={id} type="text" placeholder="e.g. Ollama Local" value={providerName} onChange={(e) => setProviderName(e.target.value)} />}
        </Field>

        <Field label="Base URL">
          {(id) => <input id={id} type="text" placeholder="e.g. http://localhost:11434/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
        </Field>

        <div className="add-provider-row">
          <Field label="API protocol">
            {(id) => <select id={id} value={api} onChange={(e) => setApi(e.target.value)}>
              <option value="openai-compatible">openai-compatible</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>}
          </Field>

          <Field label="API key">
            {(id) => <input id={id} type="password" placeholder="Optional / sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
          </Field>
        </div>

        <div className="add-provider-row">
          <Field label="Model ID" required wide>
            {(id) => <input id={id} type="text" required placeholder="e.g. llama3, mistral" value={modelId} onChange={(e) => setModelId(e.target.value)} />}
          </Field>

          <Field label="Model name">
            {(id) => <input id={id} type="text" placeholder="Display name" value={modelName} onChange={(e) => setModelName(e.target.value)} />}
          </Field>

          <Field label="Context window">
            {(id) => <input id={id} type="number" placeholder="128000" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} />}
          </Field>
        </div>

        <div className="add-provider-actions">
          <button type="button" className="modal-back" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="chrome-button primary" disabled={busy}>
            <Sparkles size={13} />
            <span>{busy ? "Saving…" : "Save provider"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
