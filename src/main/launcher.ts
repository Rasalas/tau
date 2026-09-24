import { app } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readWorkbenchSourceRoot } from "./workbench-source.js";
import { backgroundModeRequested } from "./background-mode.js";

// First thing, before the workbench's modules load: until then the Dock shows a test instance.
if (process.platform === "darwin" && backgroundModeRequested(process.env)) app.setActivationPolicy("accessory");

const userData = process.env.TAU_USER_DATA || join(app.getPath("appData"), "tau-pi-desktop-prototype");
const ignoreSource = process.env.TAU_IGNORE_WORKBENCH_SOURCE === "1" || process.env.TAU_NO_EXTENSIONS === "1";
const sourceRoot = ignoreSource ? undefined : await readWorkbenchSourceRoot(userData);
const root = sourceRoot ?? app.getAppPath();
process.env.TAU_WORKBENCH_ROOT = root;

await import(pathToFileURL(join(root, "dist-electron/main/index.js")).href);
