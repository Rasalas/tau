/** Just enough of Electron's windows and views to follow where a preview view is and what size it has. */
export interface FakeView {
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  /** The size the native view has: Electron applies bounds only to a visible view. */
  nativeSize: string;
  parent: FakeContainer | undefined;
  setBounds(rect: FakeView["bounds"]): void;
  getBounds(): FakeView["bounds"];
  setVisible(visible: boolean): void;
  setBackgroundColor(): void;
}

export interface FakeContainer {
  children: FakeView[];
  addChildView(view: FakeView, index?: number): void;
  removeChildView(view: FakeView): void;
}

export interface FakeWindow {
  contentView: FakeContainer;
  minimized: boolean;
  visible: boolean;
  destroyed: boolean;
  handlers: Map<string, Set<() => void>>;
  emit(event: string): void;
  on(event: string, handler: () => void): void;
  once(event: string, handler: () => void): void;
  off(event: string, handler: () => void): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
  contentSizes: string[];
  setContentSize(width: number, height: number): void;
  destroy(): void;
  webContents: { getZoomFactor(): number };
}

const size = (rect: { width: number; height: number }) => `${rect.width}x${rect.height}`;

export function fakeContainer(): FakeContainer {
  const container: FakeContainer = {
    children: [],
    addChildView(view, index) {
      view.parent?.removeChildView(view);
      if (index === undefined) container.children.push(view);
      else container.children.splice(index, 0, view);
      view.parent = container;
      if (view.visible) view.nativeSize = size(view.bounds);
    },
    removeChildView(view) {
      container.children = container.children.filter((child) => child !== view);
      if (view.parent === container) view.parent = undefined;
    },
  };
  return container;
}

export function fakeView(): FakeView {
  const view: FakeView = {
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    visible: true,
    nativeSize: "0x0",
    parent: undefined,
    setBounds(rect) {
      view.bounds = { ...rect };
      if (view.visible && view.parent) view.nativeSize = size(rect);
    },
    getBounds: () => view.bounds,
    setVisible(visible) {
      view.visible = visible;
      if (visible && view.parent) view.nativeSize = size(view.bounds);
    },
    setBackgroundColor() {},
  };
  return view;
}

export function fakeWindow(): FakeWindow {
  const window: FakeWindow = {
    contentView: fakeContainer(),
    minimized: false,
    visible: true,
    destroyed: false,
    handlers: new Map(),
    emit(event) { for (const handler of [...window.handlers.get(event) ?? []]) handler(); },
    on(event, handler) {
      const set = window.handlers.get(event) ?? new Set();
      set.add(handler);
      window.handlers.set(event, set);
    },
    once(event, handler) { window.on(event, handler); },
    off(event, handler) { window.handlers.get(event)?.delete(handler); },
    isDestroyed: () => window.destroyed,
    isVisible: () => window.visible,
    isMinimized: () => window.minimized,
    getBounds: () => ({ x: 40, y: 30, width: 1_400, height: 900 }),
    contentSizes: [],
    setContentSize(width, height) { window.contentSizes.push(`${width}x${height}`); },
    destroy() { window.destroyed = true; },
    webContents: { getZoomFactor: () => 1 },
  };
  return window;
}
