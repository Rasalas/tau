import { useEffect, useState, useSyncExternalStore } from "react";
import type { DictationPort } from "../dictation";
import { usePreferences } from "../renderer-services-context";
import { errorMessage } from "../../workbench/error-message";
import { Select } from "./controls";
import { SettingRow } from "./settings-layout";
import { settingAnchor } from "./settings-search";

/** Native clients alone ship this row. The choice is local to the device, not the connected host. */
export function DictationSettings({ port }: { port: DictationPort }) {
  const preferences = usePreferences();
  const { dictationLanguage } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<DictationPort["languages"]>>>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setCatalog(undefined); setError("");
    void port.languages().then((value) => { if (active) setCatalog(value); }).catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [port]);
  if (!catalog?.available && !error) return null;
  const options = [{ value: "", label: "Device language" }, ...(catalog?.languages ?? []).map((entry) => ({ value: entry.id, label: entry.name }))];
  if (dictationLanguage && !options.some((option) => option.value === dictationLanguage)) options.push({ value: dictationLanguage, label: `${dictationLanguage} · unavailable` });
  return <SettingRow id={settingAnchor("Dictation language")} title="Dictation language" wholeMachine
    help="Speech is transcribed on this device and inserted directly into the draft. A speech model downloads the first time you use a language. Nothing is sent automatically."
    {...(error ? { status: <p role="alert">{error}</p> } : {})}
    control={<Select label="Dictation language" value={dictationLanguage} options={options} disabled={!catalog?.available} onChange={(value) => preferences.setDictationLanguage(value)} />} />;
}
