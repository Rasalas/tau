import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Sparkles, X } from "lucide-react";
import type { ExtensionInspection, HostExtensionSummary, UiModel } from "../../shared/contracts";
import type { ExtensionRegistry, ExtensionSummary } from "../extension-system";
import { NETWORK_ADVISORY_NOTE } from "../../shared/extension-permissions";
import { usePreferences } from "../renderer-services-context";
import { useHostClient } from "../host-client-context";
import { ModelPicker, modelKey } from "../components/ModelPicker";
import { PackageProvenance } from "../components/PackageProvenance";
import { SettingRow, SettingsSection, Switch } from "./settings-layout";

/** A model choice an extension declared; empty means the thread's own model. */
function ModelOptionRow({
  label,
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value?: string;
  models: readonly UiModel[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const chosen = value ? models.find((model) => modelKey(model) === value) : undefined;
  return (
    <div className="model-option-row">
      <button ref={pickerAnchor} className="settings-field compact" disabled={disabled} onClick={() => setPickerOpen((open) => !open)}>
        <Sparkles size={14} className="accent" />
        <span>
          <strong>{chosen?.name ?? (value || "Thread's model")}</strong>
          <small>{chosen ? chosen.provider : "the thread's own"}</small>
        </span>
        <b><ChevronDown size={13} /></b>
      </button>
      {value ? (
        <button className="model-option-clear" disabled={disabled} aria-label={`Use the thread's model for ${label}`} onClick={() => onChange("")}>
          <X size={12} />
        </button>
      ) : null}
      {pickerOpen ? (
        <ModelPicker
          models={models}
          activeKey={value}
          onSelect={(model) => onChange(modelKey(model))}
          onClose={() => setPickerOpen(false)}
          anchor={pickerAnchor}
          side="bottom"
        />
      ) : null}
    </div>
  );
}

/**
 * Packages on disk the user has not answered for yet. A host-only package has no
 * desktop half in the registry, so without this it would never reach the approval UI.
 */
export function useAwaitingApproval(cwd: string | undefined, known: readonly ExtensionSummary[], revision: number): ExtensionSummary[] {
  const client = useHostClient();
  const [packages, setPackages] = useState<ExtensionInspection["packages"]>([]);
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    client?.inspectExtensions(cwd).then((result) => { if (!cancelled) setPackages(result.packages); }).catch(() => undefined);
    return () => { cancelled = true; };
    // `revision` moves when an answer was given, so an approved package leaves the list.
  }, [client, cwd, revision]);
  const knownIds = known.map((entry) => entry.id).join("\u0000");
  return useMemo(() => {
    const ids = new Set(knownIds ? knownIds.split("\u0000") : []);
    return packages
      .filter((pkg) => pkg.granted === false && !ids.has(pkg.id))
      .map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        active: false,
        contributes: "",
        options: [],
        permissions: pkg.permissions ?? [],
        ...(pkg.isolation ? { isolation: pkg.isolation } : {}),
        granted: false,
      }));
  }, [knownIds, packages]);
}

/** One extension's own page: its switch, the grant it waits for, the options it declared. */
export function ExtensionPage({
  summary,
  registry,
  models,
  cwd,
  onChanged,
  onNotify,
}: {
  summary: ExtensionSummary;
  registry: ExtensionRegistry;
  models: readonly UiModel[];
  cwd?: string;
  onChanged(): void;
  onNotify(message: string): void;
}) {
  const client = useHostClient();
  const preferences = usePreferences();
  const state = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  // The host half of the same package, if the package has one.
  const [hostHalves, setHostHalves] = useState<HostExtensionSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    client?.listHostExtensions().then((summaries) => { if (!cancelled) setHostHalves(summaries); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, summary.id]);
  const hostHalf = hostHalves.find((entry) => entry.id === summary.id);

  const toggleExtension = () => {
    const next = !summary.active;
    preferences.setExtensionEnabled(summary.id, next);
    registry.setActive(summary.id, next);
    if (hostHalf) {
      client?.setHostExtensionActive(summary.id, next).then(setHostHalves).catch((error: unknown) => {
        onNotify(error instanceof Error ? error.message : String(error));
      });
    }
    onChanged();
  };

  // A grant is the package's first start; a denial keeps both halves off. The
  // host starts or stops its own half and pushes the desktop half after it, so
  // a package approved here needs no reload.
  const handleGrant = async (allow: boolean) => {
    try {
      preferences.setExtensionEnabled(summary.id, allow);
      await client?.grantExtension(summary.id, allow);
      registry.setGranted(summary.id, allow);
      registry.setActive(summary.id, allow);
      setHostHalves(await client?.listHostExtensions() ?? []);
      onChanged();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    }
  };

  const status = summary.granted === false
    ? "Waiting for approval"
    : summary.contributes ? `Contributes ${summary.contributes}` : "No contributions";
  const hostStatus = hostHalf
    ? `Host entry ${hostHalf.error ? `failed to start (${hostHalf.error})` : hostHalf.active ? `active${hostHalf.commands.length ? `, commands ${hostHalf.commands.join(", ")}` : ""}` : "off"}${hostHalf.isolation ? ` · ${hostHalf.isolation === "worker" ? "isolated in a worker" : "in the host process"}` : ""}.`
    : undefined;

  return (
    <div className="settings-page">
      <SettingsSection title="Extension">
        <SettingRow
          title={summary.name}
          description={<>{status}{summary.permissions && summary.permissions.length > 0 && summary.granted !== false ? <> · permissions {summary.permissions.join(", ")}</> : null}</>}
          status={hostStatus ? <span data-host-status={hostHalf?.error ? "failed" : hostHalf?.active ? "active" : "off"}>{hostStatus}</span> : undefined}
          control={summary.granted === false || summary.core ? undefined : (
            <Switch label={`${summary.active ? "Disable" : "Enable"} ${summary.name}`} checked={summary.active} onChange={toggleExtension} />
          )}
        />
      </SettingsSection>

      {summary.granted === false ? (
        <div className="extension-grant-box">
          <div className="settings-label">Approval required</div>
          <p>This package does not run until you approve what it asks for:</p>
          {summary.permissions && summary.permissions.length > 0 ? (
            <ul>{summary.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul>
          ) : (
            <p>It asks for no permissions.</p>
          )}
          {summary.isolation === "in-process" ? (
            <>
              <ul><li><code>in-process</code> — runs inside the host process, outside the worker isolation</li></ul>
              <p className="settings-note">{NETWORK_ADVISORY_NOTE}, so this package can reach the network and start processes whatever it asked for.</p>
            </>
          ) : (
            <p className="settings-note">In its worker, network and process access are refused without the matching grant — a guardrail against a mistake, not against code written to get around it.</p>
          )}
          <div className="extension-grant-actions">
            <button type="button" className="grant-allow" onClick={() => void handleGrant(true)}>Allow</button>
            <button type="button" className="grant-deny" onClick={() => void handleGrant(false)}>Deny</button>
          </div>
        </div>
      ) : null}

      {summary.options.length > 0 ? (
        <SettingsSection title="Options">
          {summary.options.map((option) => {
            if (option.kind === "model") {
              return (
                <SettingRow
                  key={option.id}
                  title={option.label}
                  control={<ModelOptionRow
                    label={option.label}
                    value={state.extensionValues[`${summary.id}.${option.id}`] || undefined}
                    models={models}
                    disabled={!summary.active}
                    onChange={(value) => preferences.setValue(summary.id, option.id, value)}
                  />}
                />
              );
            }
            if (option.kind === "chips") {
              return (
                <SettingRow key={option.id} title={option.label} control={<div className="chip-row">{option.values.map((value) => <span className="chip" key={value}>{value}</span>)}</div>} />
              );
            }
            if (option.kind === "select") {
              const value = state.extensionValues[`${summary.id}.${option.id}`] || option.defaultValue;
              return (
                <SettingRow
                  key={option.id}
                  title={option.label}
                  control={<select className="settings-select" aria-label={option.label} disabled={!summary.active} value={value} onChange={(event) => preferences.setValue(summary.id, option.id, event.target.value)}>
                    {option.values.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                  </select>}
                />
              );
            }
            const checked = state.extensionOptions[`${summary.id}.${option.id}`] ?? option.defaultValue;
            return (
              <SettingRow
                key={option.id}
                title={option.label}
                control={<Switch role="checkbox" label={option.label} checked={checked} disabled={!summary.active} onChange={(next) => preferences.setOption(summary.id, option.id, next)} />}
              />
            );
          })}
        </SettingsSection>
      ) : null}

      <PackageProvenance id={summary.id} cwd={cwd} />
      <p className="settings-footnote">
        Extensions declare options when they activate; Tau draws this page from that declaration. Extensions without options show only the switch.
      </p>
    </div>
  );
}
