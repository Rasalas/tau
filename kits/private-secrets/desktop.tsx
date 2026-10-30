import { lazy, Suspense } from "react";
import type { DesktopExtension } from "tau";
import { SecretFilesFeed } from "./feed.js";
import { PRIVATE_SECRETS_ID } from "./protocol.js";

const Cards = lazy(() => import("./card.js"));
const privateSecrets: DesktopExtension = {
  id: PRIVATE_SECRETS_ID, name: "Private secrets",
  activate(context) {
    const feed = new SecretFilesFeed(context.host);
    context.registerRegion({ id: "private-secrets.commands", placement: "composer-above", order: 16, profiles: ["desktop", "web", "compact"], Component: (props) => <Suspense fallback={null}><Cards {...props} feed={feed} /></Suspense> });
  },
};
export default privateSecrets;
