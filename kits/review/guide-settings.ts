import type { ExtensionOption } from "tau";
import { GUIDE_MODEL_VALUE } from "./guide-protocol.js";

/** Review Kit's page in Settings → Extensions: the model that writes guides. The switch and instructions are on the Review page. */
export const GUIDE_OPTIONS: ExtensionOption[] = [
  { id: GUIDE_MODEL_VALUE, kind: "model", label: "Model that writes review guides" },
];
