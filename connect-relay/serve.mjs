import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { readFileSync } from "node:fs";
import { createCloudRouteStore } from "./cloud-store.mjs";
import { createConnectRelay } from "./service.mjs";

const env = process.env;
const bind = env.TAU_CONNECT_BIND ?? "127.0.0.1";
const tls = env.TAU_CONNECT_TLS_CERT && env.TAU_CONNECT_TLS_KEY;
if (!tls && !["127.0.0.1", "::1"].includes(bind) && env.TAU_CONNECT_BEHIND_TLS_PROXY !== "1") throw new Error("External listeners require TLS or an explicitly configured TLS proxy.");
const server = tls ? httpsServer({ cert: readFileSync(env.TAU_CONNECT_TLS_CERT), key: readFileSync(env.TAU_CONNECT_TLS_KEY), minVersion: "TLSv1.2" }) : httpServer();
if (env.K_SERVICE && !env.TAU_CONNECT_FIRESTORE_PROJECT) throw new Error("Cloud Run requires durable Firestore storage.");
const routeStore = env.TAU_CONNECT_FIRESTORE_PROJECT ? createCloudRouteStore({
  project: env.TAU_CONNECT_FIRESTORE_PROJECT, database: env.TAU_CONNECT_FIRESTORE_DATABASE ?? "tau-connect", revision: env.K_REVISION,
}) : undefined;
const relay = await createConnectRelay(server, { routeStore, adminToken: env.TAU_CONNECT_ADMIN_TOKEN, store: env.TAU_CONNECT_STORE ?? "/data/routes.json" });
server.listen(Number(env.PORT ?? 8787), bind, () => console.log(`Tau Connect relay listening on ${bind}:${server.address().port}`));
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => { relay.close(); server.close(); });
