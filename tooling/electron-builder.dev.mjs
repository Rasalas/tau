// Tau Dev: `npx electron-builder -c tooling/electron-builder.dev.mjs --mac --dir` after `npm run build`,
// or `npm run install:mac -- --local`. The identity module is read from the build.
import { APP_IDENTITIES, FLAVOR_FIELD } from "../dist-electron/main/app-identity.js";
import { devBuilderConfig } from "../scripts/packaging/dev-app.mjs";

export default devBuilderConfig(APP_IDENTITIES.dev, FLAVOR_FIELD);
