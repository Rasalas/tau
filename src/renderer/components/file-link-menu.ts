import { useContext, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { errorMessage } from "../../workbench/error-message";
import { isMacPlatform } from "../keybindings";
import { usePlatform } from "../platform-context";
import { LONG_PRESS_MS, SWIPE_SLOP_PX } from "../touch/swipe-gesture";
import { WorkbenchShellContext } from "../workbench-context";
import { transcriptFilePath, useWorkspaceResources } from "../workspace-resource-context";
import type { MenuSection } from "./Menu";
import { useContextMenu } from "./ui/ContextMenu";
import { tooltipProps } from "./ui/Tooltip";

export interface FileLinkPaths {
  /** Inside the thread's workspace: the only form the host's editor and file manager take. */
  relative?: string;
  /** Absolute on the thread's machine, when the link or the workspace root says so. */
  full?: string;
}

/** The forms of a link's path the menu copies and the host opens; a path core cannot read has none. */
export function fileLinkPaths(path: string, root: string | undefined): FileLinkPaths {
  let file: string;
  try { file = transcriptFilePath(path, root); } catch { return {}; }
  if (/^(?:\/|[A-Za-z]:\/)/u.test(file)) return { full: path };
  const relative = file.split("/").includes("..") ? undefined : file;
  const base = root?.replace(/[\\/]+$/u, "");
  const windows = Boolean(base?.includes("\\") && !base.includes("/"));
  const full = relative !== undefined && base ? (windows ? `${base}\\${relative.replace(/\//gu, "\\")}` : `${base}/${relative}`) : undefined;
  return { ...(relative !== undefined ? { relative } : {}), ...(full ? { full } : {}) };
}

/**
 * What a file link in a reply does besides opening the file on the stage: the
 * editor on a modifier click (⌘ on macOS, Ctrl elsewhere), and a menu on a right
 * click, the menu key, Shift+F10 or a long touch. Editor and file manager belong
 * to the host machine, so they are offered only where the thread's resources say so.
 */
export function useFileLinkMenu(path: string, open: () => void) {
  const resources = useWorkspaceResources();
  const platform = usePlatform();
  const actions = useContext(WorkbenchShellContext)?.actions;
  const openMenu = useContextMenu();
  const paths = fileLinkPaths(path, resources?.displayPath);
  const press = useRef<{ id: number; x: number; y: number; timer: number }>(undefined);
  const swallowUntil = useRef(0);
  const cancel = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = undefined; };
  useEffect(() => cancel, []);

  const files = () => paths.relative === undefined ? undefined : resources?.hostFiles?.();

  const copy = (text: string, what: string) => {
    platform.clipboard.writeText(text).then(
      () => actions?.notify(`Copied ${what}`),
      (error: unknown) => actions?.notify(`Could not copy the ${what}: ${errorMessage(error)}`, "error"),
    );
  };

  const show = (at: { clientX: number; clientY: number; currentTarget: Element; preventDefault?(): void }) => {
    const host = files();
    const sections: MenuSection[] = ([
      {
        items: [
          { id: "open", label: "Open" },
          ...(host?.editor ? [{ id: "editor", label: `Open in ${host.editor.name}` }] : []),
          ...(host?.fileManager ? [{ id: "reveal", label: `Reveal in ${host.fileManager.name}` }] : []),
        ],
      },
      {
        items: [
          ...(paths.relative !== undefined ? [{ id: "copy-relative", label: "Copy relative path" }] : []),
          ...(paths.full ? [{ id: "copy-full", label: "Copy full path" }] : []),
        ],
      },
    ] satisfies MenuSection[]).filter((section) => section.items.length > 0);
    void openMenu(at, sections).then((choice) => {
      if (choice === "open") open();
      else if (choice === "editor" && host?.editor && paths.relative !== undefined) host.open(paths.relative, host.editor.id);
      else if (choice === "reveal" && host?.fileManager && paths.relative !== undefined) host.open(paths.relative, host.fileManager.id);
      else if (choice === "copy-relative" && paths.relative !== undefined) copy(paths.relative, "relative path");
      else if (choice === "copy-full" && paths.full) copy(paths.full, "full path");
    });
  };

  return {
    /** Spread on the link or button that opens the file. */
    props: {
      onClick(event: MouseEvent<HTMLElement>) {
        event.preventDefault();
        if (performance.now() < swallowUntil.current) return;
        const host = (isMacPlatform() ? event.metaKey : event.ctrlKey) ? files() : undefined;
        if (host?.editor && paths.relative !== undefined) host.open(paths.relative, host.editor.id);
        else open();
      },
      onContextMenu(event: MouseEvent<HTMLElement>) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        // A long touch has opened it already; the browser's own context menu event follows.
        if (performance.now() < swallowUntil.current) return;
        show({ clientX: event.clientX, clientY: event.clientY, currentTarget: event.currentTarget });
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault();
        event.stopPropagation();
        show({ clientX: 0, clientY: 0, currentTarget: event.currentTarget });
      },
      onPointerDown(event: PointerEvent<HTMLElement>) {
        cancel();
        if (event.pointerType !== "touch") return;
        const { clientX, clientY, currentTarget } = event;
        press.current = {
          id: event.pointerId, x: clientX, y: clientY,
          timer: window.setTimeout(() => {
            press.current = undefined;
            swallowUntil.current = performance.now() + 1500;
            show({ clientX, clientY, currentTarget });
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const held = press.current;
        if (held && held.id === event.pointerId && Math.hypot(event.clientX - held.x, event.clientY - held.y) > SWIPE_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
    /** The full path on hover; a touch screen's long press belongs to the menu instead. */
    tooltip(): Record<string, string> {
      return document.body.dataset.profile === "compact" ? {} : tooltipProps(paths.full ?? path, { variant: "code" });
    },
  };
}
