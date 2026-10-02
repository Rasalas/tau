// Tau Dev (K132): electron-builder's configuration for a checkout's build that
// installs beside the released Tau. Every name comes from the app identity.

/** The base configuration with the identity's names, its icon, and no release feed. */
export function devBuilderConfig(identity, flavorField) {
  return {
    extends: "tooling/electron-builder.yml",
    appId: identity.appId,
    productName: identity.productName,
    extraMetadata: { [flavorField]: identity.flavor },
    // Plain Node reads it there: the `tau` CLI inside the bundle learns its flavor from it.
    asarUnpack: ["package.json"],
    directories: { output: "release/dev" },
    // No `app-update.yml`: the build never looks for a release.
    publish: null,
    // Arrays merge with the base's, so Info.plist lists both Bonjour types; Tau Dev uses its own.
    mac: { icon: "assets/icon/TauDev.icon", extendInfo: { NSBonjourServices: [identity.bonjourType] } },
  };
}
