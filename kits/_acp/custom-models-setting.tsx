import { SettingRow, TextField, useSetting } from "tau";
import { customModelIds } from "./custom-models.js";

export function CustomModelsSetting({ extensionId, id }: { extensionId: string; id: string }) {
  const setting = useSetting<string>(`values.${extensionId}.customModels`, {
    defaultValue: "",
    read: (raw) => typeof raw === "string" ? raw : undefined,
  });
  return (
    <SettingRow
      id={id}
      title="Custom models"
      description="One model ID per line. Empty lines are ignored."
      help="For all instances on this machine. After saving, choose Refresh models in the model picker. New sessions use the changes; existing sessions keep their model list."
      setting={setting}
      control={<TextField label="Custom models" rows={3} mono value={setting.value} onCommit={(text) => setting.set(customModelIds(text).join("\n"))} />}
    />
  );
}
