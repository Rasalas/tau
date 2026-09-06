// Editor support for this example kept inside the Tau repository. Copy this
// file next to your own package and point the paths at your Tau checkout.
declare module "tau" {
  export * from "../../src/renderer/extension-api";
}

// The in-process host extension surface: types, `HostCommandError`, and the
// text projections a package that reads transcripts needs. A worker-isolated
// package uses "tau/host" instead; see examples/desktop-extensions/tau.d.ts.
declare module "tau/host-extension" {
  export * from "../../src/main/host-extension-api";
}
