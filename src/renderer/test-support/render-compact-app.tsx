import { render } from "@testing-library/react";
import type { DesktopExtension } from "../extension-system.js";
import type { HostClient } from "../../workbench/host-client.js";
import { createMemoryStorage, setClientStorage } from "../../workbench/client-storage.js";
import { setHostClient } from "../host-client-context.js";
import { createRendererServices } from "../renderer-services.js";
import { WebWorkbench, webClientEnvironment } from "../../web/WebWorkbench.js";

/** A compact browser client with the supplied kits and its own storage. */
export function renderCompactApp(client: HostClient, extensions: readonly DesktopExtension[]) {
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  return render(<WebWorkbench client={client} storage={storage} services={createRendererServices(extensions)} environment={webClientEnvironment("compact")} />);
}
