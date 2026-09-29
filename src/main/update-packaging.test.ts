import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UPDATE_HELPER, UPDATE_POLKIT_ACTION } from "./update-installers.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const POLKIT_FILES = [
  "/usr/share/polkit-1/actions/de.tbuck.tau.update.policy",
  "/usr/share/polkit-1/rules.d/50-tau-update.rules",
  "/var/lib/polkit-1/localauthority/10-vendor.d/50-tau-update.pkla",
];

/** The .deb's half of the update helper (K103); scripts/packaging/update-helper-container.sh runs it for real. */
describe("the .deb's update helper", () => {
  it("is shipped where polkit's action and the host expect it", () => {
    const builder = read("electron-builder.yml");
    expect(builder).toMatch(/- from: packaging\/linux\/tau-update-helper\n\s+to: bin\/tau-update-helper/u);
    expect(builder).toMatch(/- from: packaging\/linux\/polkit\n\s+to: resources\/polkit/u);
    const policy = read("packaging/linux/polkit/de.tbuck.tau.update.policy");
    expect(policy).toContain(`<action id="${UPDATE_POLKIT_ACTION}">`);
    expect(policy).toContain(`<annotate key="org.freedesktop.policykit.exec.path">${UPDATE_HELPER}</annotate>`);
    // Without the grant below, polkit asks an administrator.
    expect(policy).not.toMatch(/<allow_\w+>yes</u);
  });

  it("grants exactly that action to the machine's administrators, in both polkit formats", () => {
    const rules = read("packaging/linux/polkit/50-tau-update.rules");
    expect(rules).toContain(`action.id !== "${UPDATE_POLKIT_ACTION}"`);
    expect(rules.match(/polkit\.Result\.YES/gu)).toHaveLength(1);
    const pkla = read("packaging/linux/polkit/50-tau-update.pkla");
    expect(pkla).toContain(`Action=${UPDATE_POLKIT_ACTION}\n`);
    expect(pkla).toContain("Identity=unix-group:sudo;unix-group:admin;unix-group:wheel;unix-group:tau-update\n");
  });

  it("runs the helper on Tau's own binary with an empty environment and the caller's arguments only", () => {
    const wrapper = read("packaging/linux/tau-update-helper");
    expect(wrapper).toContain("exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 ELECTRON_RUN_AS_NODE=1");
    expect(wrapper).toContain("/opt/Tau/tau /opt/Tau/resources/app.asar.unpacked/bin/tau-update-helper.mjs \"$@\"");
    expect(statSync(join(ROOT, "packaging/linux/tau-update-helper")).mode & 0o111).toBe(0o111);
  });

  it("puts the polkit files in place on install and takes them away on removal only", () => {
    const install = read("packaging/linux/after-install.tpl");
    for (const file of POLKIT_FILES) expect(install).toContain(`install -D -m 0644 "$POLKIT_SOURCE/${file.split("/").pop()}" ${file}`);
    expect(install).toContain("chown root:root '/opt/${sanitizedProductName}/bin/tau-update-helper'");
    const remove = read("packaging/linux/after-remove.tpl");
    const upgradeGuard = remove.indexOf('if [ "$1" = upgrade ]');
    for (const file of POLKIT_FILES) expect(remove.indexOf(file)).toBeGreaterThan(upgradeGuard);
  });
});
