import { BaseWindow, type BrowserWindow, type WebContentsView } from "electron";
import type { PreviewRect } from "./host.js";

export interface PreviewPlacement {
  /** `offscreen`: while hidden, the page waits in the stage and paints there, as for another device. */
  place(rect: PreviewRect, visible: boolean, offscreen?: boolean): void;
  /** Whether the user can see the view now, so its compositor has a current frame. */
  onScreen(): boolean;
  destroy(): void;
}

const sizeOf = (rect: PreviewRect): string => `${rect.width}x${rect.height}`;

/**
 * Keeps the preview's page laid out at its rectangle whatever the window shows,
 * so another device can be sent pictures of it. Electron applies a view's
 * bounds only while it is visible: a view hidden from the start stays 0×0 and
 * one resized while hidden keeps its old size. A minimized or hidden window
 * paints nothing new at all; the view waits in a window that is never shown
 * until the user's window is back. A page laid out for another device waits
 * there too while the window hides it: hidden in the window it answers only
 * every other capture, and its timers are throttled.
 */
export function placePreviewView(window: BrowserWindow, view: WebContentsView): PreviewPlacement {
  let placed: { rect: PreviewRect; visible: boolean } | undefined;
  let sized: string | undefined;
  let stage: BaseWindow | undefined;
  let destroyed = false;
  let offscreen = false;

  const windowPaints = (): boolean => !window.isDestroyed() && window.isVisible() && !window.isMinimized();

  const apply = (): void => {
    if (destroyed || !placed) return;
    const { rect, visible } = placed;
    if (stage) {
      stage.setContentSize(Math.max(1, rect.width), Math.max(1, rect.height));
      view.setBounds({ x: 0, y: 0, width: rect.width, height: rect.height });
      sized = sizeOf(rect);
      return;
    }
    view.setBounds(rect);
    // Shown and hidden again within one task, the view takes its size and never reaches the screen.
    if (!visible && sized !== sizeOf(rect)) view.setVisible(true);
    view.setVisible(visible);
    sized = sizeOf(rect);
  };

  const staged = (): boolean => !windowPaints() || (offscreen && placed?.visible !== true);

  const toStage = (): void => {
    if (destroyed || stage || window.isDestroyed()) return;
    const { x, y } = window.getBounds();
    // At the window's place, so the page keeps that display's pixel density.
    stage = new BaseWindow({ show: false, x, y, width: 800, height: 600, focusable: false, skipTaskbar: true, hasShadow: false });
    window.contentView.removeChildView(view);
    stage.contentView.addChildView(view);
    view.setVisible(true);
    apply();
  };

  const fromStage = (): void => {
    if (destroyed || !stage || window.isDestroyed()) return;
    stage.contentView.removeChildView(view);
    stage.destroy();
    stage = undefined;
    view.setVisible(false);
    window.contentView.addChildView(view);
    sized = undefined;
    apply();
  };

  const sync = (): void => {
    if (window.isDestroyed()) return;
    if (staged()) toStage();
    else fromStage();
  };

  window.on("minimize", sync);
  window.on("hide", sync);
  window.on("restore", sync);
  window.on("show", sync);
  sync();

  return {
    place(rect, visible, away = false) {
      placed = { rect, visible };
      offscreen = away;
      // Moving calls `apply` itself.
      if (staged() !== Boolean(stage)) sync();
      else apply();
    },
    onScreen: () => !stage && placed?.visible === true && windowPaints(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.off("minimize", sync);
      window.off("hide", sync);
      window.off("restore", sync);
      window.off("show", sync);
      if (stage) {
        stage.contentView.removeChildView(view);
        stage.destroy();
        stage = undefined;
      } else if (!window.isDestroyed()) {
        window.contentView.removeChildView(view);
      }
    },
  };
}
