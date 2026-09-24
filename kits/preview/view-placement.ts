import { BaseWindow, type BrowserWindow, type WebContentsView } from "electron";
import type { PreviewRect } from "./host.js";

export interface PreviewPlacement {
  place(rect: PreviewRect, visible: boolean): void;
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
 * until the user's window is back.
 */
export function placePreviewView(window: BrowserWindow, view: WebContentsView): PreviewPlacement {
  let placed: { rect: PreviewRect; visible: boolean } | undefined;
  let sized: string | undefined;
  let stage: BaseWindow | undefined;
  let destroyed = false;

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

  const toStage = (): void => {
    if (destroyed || stage || window.isDestroyed() || windowPaints()) return;
    const { x, y } = window.getBounds();
    // At the window's place, so the page keeps that display's pixel density.
    stage = new BaseWindow({ show: false, x, y, width: 800, height: 600, focusable: false, skipTaskbar: true, hasShadow: false });
    window.contentView.removeChildView(view);
    stage.contentView.addChildView(view);
    view.setVisible(true);
    apply();
  };

  const fromStage = (): void => {
    if (destroyed || !stage || !windowPaints()) return;
    stage.contentView.removeChildView(view);
    stage.destroy();
    stage = undefined;
    view.setVisible(false);
    window.contentView.addChildView(view);
    sized = undefined;
    apply();
  };

  window.on("minimize", toStage);
  window.on("hide", toStage);
  window.on("restore", fromStage);
  window.on("show", fromStage);
  toStage();

  return {
    place(rect, visible) {
      placed = { rect, visible };
      apply();
    },
    onScreen: () => !stage && placed?.visible === true && windowPaints(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.off("minimize", toStage);
      window.off("hide", toStage);
      window.off("restore", fromStage);
      window.off("show", fromStage);
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
