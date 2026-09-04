import { render, type RenderResult } from "@testing-library/react";
import App from "../App";
import { HostClientProvider, setHostClient } from "../host-client-context";
import type { HostClient } from "../host-client";

/**
 * Renders `App` behind the host-client provider tests exercise it through.
 * Also installs the ambient client `main.tsx` would, so module-scope
 * singletons (Workspace Kit's store) see the same fake the components do.
 */
export function renderApp(client: HostClient | undefined): RenderResult {
  setHostClient(client);
  return render(<HostClientProvider client={client}><App /></HostClientProvider>);
}
