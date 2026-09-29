// Opens one app in the screen comparison's profile and keeps it open for
// inspection over CDP (`npm run cdp -- <port> snapshot`) until Ctrl-C.
// Usage: node scripts/compare/screens/hold.mjs <tau|reference> [--fresh] [--theme zinc] [--scheme light|dark]
import { openApp } from "./harness.mjs";

const [id, ...rest] = process.argv.slice(2);
const flag = (name) => { const index = rest.indexOf(name); return index < 0 ? undefined : rest[index + 1]; };
const ctx = await openApp(id, { fresh: rest.includes("--fresh"), theme: flag("--theme") });
if (flag("--scheme")) await ctx.scheme(flag("--scheme"));
console.log(`[screens] ${ctx.app.label} pid=${ctx.pid} port=${ctx.port} root=${ctx.root}`);
const shutdown = async () => { await ctx.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 60_000);
