import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CommandLineOp, CommandLineState } from "../../shared/window-shell";
import { errorMessage } from "../../workbench/error-message";
import { ConfirmDialog } from "../deferred-surfaces";
import { useHostClient } from "../host-client-context";
import { Button } from "./controls";
import { SettingRow } from "./settings-layout";
import { settingAnchor } from "./settings-search";

function describe(state: CommandLineState): ReactNode {
  const name = <code>{state.name}</code>;
  if (state.installedPath) {
    if (state.onPath) return `Installed at ${state.installedPath}. Open a new terminal to use it.`;
    return state.otherPath
      ? `Installed at ${state.installedPath}, but ${state.otherPath} comes first on your PATH.`
      : <>Installed at {state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run {name}.</>;
  }
  if (state.otherPath) return <>A {name} command is already on your PATH at {state.otherPath}.</>;
  if (!state.target) return <>No folder on your PATH is writable, so Tau cannot link {name}.</>;
  return <>Run Tau from any terminal as {name}: <code>{state.name} app .</code> opens a folder.</>;
}

/**
 * Settings → General → Terminal command: links the `tau` command into a
 * folder on PATH after asking, shows where it stands and removes it again
 * (T3 #16683). Only this machine's window can do it, and only an installed app.
 */
export function CommandLineRow({ onNotify }: { onNotify(message: string, level?: "info" | "warning" | "error"): void }) {
  const client = useHostClient();
  const [state, setState] = useState<CommandLineState>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback((op: CommandLineOp, folder?: string) => {
    if (!client) return Promise.resolve(undefined);
    return client.windowAction({ kind: "command-line", op, ...(folder ? { folder } : {}) }) as Promise<CommandLineState>;
  }, [client]);

  useEffect(() => {
    let live = true;
    run("state").then((next) => { if (live && next?.supported) setState(next); }, () => undefined);
    return () => { live = false; };
  }, [run]);

  if (!state) return null;
  const change = (op: "install" | "remove", folder?: string) => {
    setBusy(true);
    run(op, folder).then(
      (next) => { if (next) setState(next); },
      (error: unknown) => onNotify(`Could not ${op === "install" ? "install" : "remove"} ${state.name}: ${errorMessage(error)}`, "error"),
    ).finally(() => setBusy(false));
  };
  const installed = Boolean(state.installedPath);
  const canInstall = !installed && Boolean(state.target) && !state.otherPath;
  return (
    <>
      <SettingRow
        id={settingAnchor("Terminal command")}
        title="Terminal command"
        description={describe(state)}
        control={installed
          ? <Button busy={busy} onClick={() => change("remove")}>Remove</Button>
          : canInstall ? <Button busy={busy} onClick={() => setAsking(true)}>Install</Button> : null}
      />
      {asking && state.target ? (
        <ConfirmDialog
          title={`Install the ${state.name} command?`}
          message={`This links ${state.name} into ${state.target.folder}${state.target.onPath ? "" : ", which is not on your PATH yet"}. Remove undoes it.`}
          confirmLabel="Install"
          onConfirm={() => { setAsking(false); change("install", state.target!.folder); }}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}
