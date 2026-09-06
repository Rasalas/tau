import { useState } from "react";
import type { DesktopExtension, DesktopExtensionContext, RegionProps } from "tau";

/**
 * The desktop half of the hello-package example. It renders one status item
 * — the smallest slot the workbench offers — and calls the host half's
 * `greet` command through `context.host`, the only bridge a package's
 * desktop bundle has back to its own host entry (`window.tau` is not
 * available here; see docs/EXTENSIONS.md).
 */
function createHelloStatusItem(host: DesktopExtensionContext["host"]) {
  return function HelloStatusItem(_props: RegionProps) {
    const [label, setLabel] = useState("Say hello");
    return (
      <button
        type="button"
        onClick={() => {
          setLabel("…");
          host.invoke("greet").then(
            (result) => setLabel((result as { greeting: string }).greeting),
            (error: unknown) => setLabel(error instanceof Error ? error.message : "hello failed"),
          );
        }}
        style={{
          font: "12px var(--sans)",
          color: "var(--ink-2)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {label}
      </button>
    );
  };
}

const extension: DesktopExtension = {
  id: "example.hello-package",
  name: "Hello Package",
  activate(context) {
    return context.registerStatusItem({
      id: "hello-package.status",
      align: "left",
      Component: createHelloStatusItem(context.host),
    });
  },
};

export default extension;
