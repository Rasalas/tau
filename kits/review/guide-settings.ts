import type { ExtensionOption } from "tau";
import { GUIDE_EFFORT_VALUE, GUIDE_MODEL_VALUE, GUIDE_RUNTIME_VALUE } from "./guide-protocol.js";

/** Review Kit's page in Settings → Extensions: the model that writes guides. The switch and instructions are on the Review page. */
export const GUIDE_OPTIONS: ExtensionOption[] = [
  { id: GUIDE_RUNTIME_VALUE, kind: "select", defaultValue: "pi", label: "Runtime that writes review guides", values: [{ value: "pi", label: "Pi" }, { value: "codex", label: "Codex · runtime model" }, { value: "claude-code", label: "Claude · runtime model" }] },
  { id: GUIDE_MODEL_VALUE, kind: "model", thinkingLevelValue: GUIDE_EFFORT_VALUE, label: "Pi model that writes review guides" },
];
