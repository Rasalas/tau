import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { errorMessage } from "../../workbench/error-message";
import { tooltipProps } from "../components/ui/Tooltip";
import { useHostClient } from "../host-client-context";
import { usePlatform } from "../platform-context";
import { SettingRow } from "./settings-layout";
import { settingAnchor } from "./settings-search";

/** The owner's access key, hidden until Show or Copy reads it from the host, never with the page (ADR 0040). */
export function AccessKeyRow({ onNotify }: { onNotify(message: string, level?: "info" | "warning" | "error"): void }) {
  const client = useHostClient();
  const platform = usePlatform();
  const [key, setKey] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!client || client.isOwner?.() === false) return null;

  const run = async (use: (token: string) => Promise<void> | void, keep: boolean) => {
    setBusy(true);
    try {
      const token = key ?? await client.hostToken();
      await use(token);
      setKey(keep ? token : undefined);
    } catch (error: unknown) {
      onNotify((error as { code?: unknown })?.code === "unknown-method"
        ? "This machine's Tau is older and cannot show its access key. Update it first."
        : errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => { if (key) setKey(undefined); else void run(() => undefined, true); };
  const copy = () => void run(async (token) => {
    await platform.clipboard.writeText(token);
    onNotify("Access key copied");
  }, key !== undefined);

  return (
    <SettingRow
      id={settingAnchor("Access key")}
      title="Access key"
      description={<code className="connection-fingerprint">{key ?? "••••••••••••••••••••"}</code>}
      status="Whoever has it can use this machine as you do. Enter it only on your own devices or browsers."
      control={<>
        <button type="button" className="tau-icon-button" disabled={busy} aria-label={key ? "Hide the access key" : "Show the access key"}
          {...tooltipProps(key ? "Hide" : "Show")} onClick={toggle}>
          {key ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
        </button>
        <button type="button" className="tau-icon-button" disabled={busy} aria-label="Copy the access key" {...tooltipProps("Copy")} onClick={copy}>
          <Copy size={14} aria-hidden />
        </button>
      </>}
    />
  );
}
