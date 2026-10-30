import { SettingRow, TextField, useSetting } from "tau";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_INSTRUCTIONS_SETTING, TITLE_INSTRUCTIONS_LIMIT, titleInstructions, titleInstructionsError } from "./protocol.js";

export function TitleInstructionsRow() {
  const instructions = useSetting<string>(`values.${THREAD_TITLES_HOST_EXTENSION_ID}.${TITLE_INSTRUCTIONS_SETTING}`, {
    defaultValue: "",
    scope: "both",
    read: (raw) => typeof raw === "string" ? raw : undefined,
  });
  return <SettingRow
    id="setting-thread-title-instructions"
    title="Thread title instructions"
    description="Style for titles written by Tau."
    help={`Applies to new and regenerated titles. Automatic naming prefers runtime-provided titles. Changes apply to the next generation; existing titles stay as they are. Up to ${TITLE_INSTRUCTIONS_LIMIT.toLocaleString("en-US")} characters.`}
    setting={instructions}
    control={<TextField
      label="Thread title instructions"
      rows={4}
      value={instructions.value}
      placeholder="Lead with the issue number. Use German."
      validate={titleInstructionsError}
      error={titleInstructionsError(instructions.value)}
      onCommit={(draft) => {
        const next = titleInstructions(draft);
        if (next !== instructions.value) instructions.set(next);
      }}
    />}
  />;
}
