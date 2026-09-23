import { createRef, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { HostSnapshot } from "../shared/contracts";
import { Composer } from "./components/Composer";
import { ClientStorageProvider } from "./client-storage-context";
import { ExtensionRegistry, type ComposerInlineContribution } from "./extension-system";
import { RendererServicesProvider } from "./renderer-services-context";
import { createRendererServices } from "./renderer-services";
import { WorkbenchShellContext } from "./workbench-context";
import { ComposerScopeStore } from "../workbench/composer-scope-store";
import { createMemoryStorage } from "../workbench/client-storage";

/**
 * The composer on its own, typed into one character a frame. The timed span
 * per key is the `input` event's dispatch: React's controlled update, the
 * commit and the layout the auto-height reads, which is what stands between
 * a key and its paint.
 */
export interface ComposerTypingOptions {
  /** Draft already in the field before typing starts. */
  bytes: number;
  /** Characters typed, one per frame. */
  chars: number;
  /** Context chips a kit holds for the draft. */
  chips: number;
  onReady(): void;
  onUpdate(durationMs: number): void;
  onFinished(): void;
}

const SCOPE = "session:benchmark";

const snapshot: HostSnapshot = {
  cwd: "/benchmark", sessionId: "benchmark", sessionTitle: "Benchmark", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
  activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: false,
};

function draft(bytes: number): string {
  let text = "";
  for (let line = 0; text.length < bytes; line += 1) {
    text += `Line ${line} of a long prompt names src/module-${line % 37}.ts and asks for a careful change.\n`;
  }
  return text.slice(0, bytes);
}

/** A kit holding `count` file chips for the draft, the way Composer Context does; core draws them in the text. */
function chipContribution(count: number): ComposerInlineContribution {
  const chips = Array.from({ length: count }, (_, index) => ({ id: `chip-${index}`, label: `module-${index}.ts`, icon: FileText }));
  return {
    id: "benchmark.chips",
    chips: { list: () => chips, remove: () => {} },
    subscribe: () => () => {},
  };
}

export default function ComposerTypingScenario(options: ComposerTypingOptions) {
  const [setup] = useState(() => {
    const registry = new ExtensionRegistry();
    registry.activate({ id: "benchmark.context", name: "Benchmark Context", activate(context) { context.registerComposerInline({ ...chipContribution(options.chips), profiles: ["desktop"] }); } });
    return { registry, storage: createMemoryStorage(), services: createRendererServices(), scopeStore: new ComposerScopeStore(), seed: draft(options.bytes) };
  });

  useEffect(() => {
    let stopped = false;
    const nextFrame = (callback: () => void) => requestAnimationFrame(() => { if (!stopped) callback(); });
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    let typed = 0;
    const type = () => {
      const field = document.querySelector<HTMLTextAreaElement>(".composer-frame textarea");
      if (!field) { nextFrame(type); return; }
      if (typed === options.chars) { nextFrame(options.onFinished); return; }
      // Wait for core to have put the chips into the text.
      if (typed === 0 && options.chips > 0 && !field.value.includes("\u2063")) { nextFrame(type); return; }
      if (typed === 0) {
        field.focus();
        options.onReady();
      }
      const character = typed % 7 === 6 ? " " : String.fromCharCode(97 + (typed % 26));
      const end = field.value.length;
      field.setSelectionRange(end, end);
      const startedAt = performance.now();
      setValue.call(field, field.value + character);
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
      options.onUpdate(performance.now() - startedAt);
      typed += 1;
      nextFrame(type);
    };
    nextFrame(() => nextFrame(type));
    return () => { stopped = true; };
  // The scenario runs once per mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  return <ClientStorageProvider storage={setup.storage}>
    <RendererServicesProvider services={setup.services}>
      <WorkbenchShellContext.Provider value={{ registry: setup.registry, snapshot }}>
        <div className="composer-benchmark">
          <Composer
            snapshot={snapshot}
            scopeStore={setup.scopeStore}
            seed={setup.seed}
            draftStorageKey={SCOPE}
            queue={[]}
            contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
            textareaRef={createRef()}
            onSubmit={async () => ({ accepted: true })}
            onAbort={() => {}}
            onCancelQueued={() => {}}
            onSteerQueued={() => {}}
            onSetModel={() => {}}
            onSetThinking={() => {}}
            onCompactContext={() => {}}
          />
        </div>
      </WorkbenchShellContext.Provider>
    </RendererServicesProvider>
  </ClientStorageProvider>;
}
