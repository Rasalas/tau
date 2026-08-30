import { useState, type RefObject } from "react";
import { ArrowUp, ChevronDown, CornerDownRight, Lock, LockOpen, Sparkles, X, Zap } from "lucide-react";
import type { HostSnapshot, UiContextUsage, WorkspaceInfo } from "../../shared/contracts";
import { ACCESS_LEVELS, type AccessLevel } from "../preferences";
import { ContextMeter, type ContextBreakdown } from "./ContextMeter";
import { Menu } from "./Menu";
import { ModelPicker, modelKey } from "./ModelPicker";
import { WorkspaceBar } from "./WorkspaceBar";

type OpenMenu = "thinking" | "access" | undefined;

export function Composer({
  snapshot,
  value,
  queue,
  accessLevel,
  contextUsage,
  contextBreakdown,
  textareaRef,
  onChange,
  onSubmit,
  onAbort,
  onCancelQueued,
  onSetModel,
  onSetThinking,
  onSetAccess,
  onCompactContext,
  workspace,
  workspaceBusy,
  onOpenWorktree,
  onCreateWorktree,
  onSwitchRef,
}: {
  snapshot?: HostSnapshot;
  value: string;
  queue: string[];
  accessLevel: AccessLevel;
  contextUsage?: UiContextUsage;
  contextBreakdown: ContextBreakdown;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange(value: string): void;
  onSubmit(): void;
  onAbort(): void;
  onCancelQueued(index: number): void;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  onSetAccess(level: AccessLevel): void;
  onCompactContext(): void;
  workspace?: WorkspaceInfo;
  workspaceBusy: boolean;
  onOpenWorktree(path: string): void;
  onCreateWorktree(branch: string): void;
  onSwitchRef(ref: string): void;
}) {
  const [menu, setMenu] = useState<OpenMenu>();
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const streaming = Boolean(snapshot?.isStreaming);
  const accessLabel = ACCESS_LEVELS.find((level) => level.id === accessLevel)?.label ?? accessLevel;

  return (
    <footer className="composer-zone">
      {queue.length > 0 ? (
        <div className="composer-queue">
          {queue.map((entry, index) => (
            <div className="composer-queue-item" key={`${index}-${entry}`}>
              <CornerDownRight size={13} />
              <span title={entry}>{entry}</span>
              <button onClick={() => onCancelQueued(index)} title="Drop this queued message">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={`composer-frame ${queue.length > 0 ? "stacked" : ""}`}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={
            streaming
              ? "Steer the run — ↵ queues it for the agent"
              : "Direct the agent — @ files, / commands, ⇧↵ newline"
          }
        />

        <div className="composer-toolbar">
          <button className="runtime-chip" onClick={() => setModelPickerOpen(true)}>
            <Sparkles size={13} className="accent" />
            {snapshot?.model?.name ?? "select model"}
            <ChevronDown size={12} className="chev" />
          </button>

          <span className="menu-anchor">
            <button className="runtime-chip" onClick={() => setMenu(menu === "thinking" ? undefined : "thinking")}>
              <Zap size={13} />
              {snapshot?.thinkingLevel ?? "—"}
              <ChevronDown size={12} className="chev" />
            </button>
            {menu === "thinking" ? (
              <Menu
                placement="above"
                heading="Thinking"
                items={(snapshot?.thinkingLevels ?? []).map((level) => ({
                  id: level,
                  label: level,
                  selected: level === snapshot?.thinkingLevel,
                }))}
                onSelect={onSetThinking}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          <span className="menu-anchor">
            <button className="runtime-chip" onClick={() => setMenu(menu === "access" ? undefined : "access")}>
              {accessLevel === "full" ? <LockOpen size={13} /> : <Lock size={13} />}
              {accessLabel}
              <ChevronDown size={12} className="chev" />
            </button>
            {menu === "access" ? (
              <Menu
                placement="above"
                heading="Access"
                items={ACCESS_LEVELS.map((level) => ({
                  id: level.id,
                  label: level.label,
                  selected: level.id === accessLevel,
                }))}
                onSelect={(id) => onSetAccess(id as AccessLevel)}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          <span className="spacer" />

          {contextUsage ? (
            <ContextMeter usage={contextUsage} breakdown={contextBreakdown} onCompact={onCompactContext} />
          ) : null}

          {streaming ? (
            <button className="send-button stop" title="Stop the run" onClick={onAbort}><i /></button>
          ) : (
            <button
              className="send-button"
              title="Send"
              disabled={value.trim().length === 0}
              onClick={onSubmit}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>

      {modelPickerOpen ? (
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={(model) => onSetModel(model.provider, model.id)}
          onClose={() => setModelPickerOpen(false)}
        />
      ) : null}

      <WorkspaceBar
        info={workspace}
        busy={workspaceBusy}
        onOpenWorktree={onOpenWorktree}
        onCreateWorktree={onCreateWorktree}
        onSwitchRef={onSwitchRef}
      />
    </footer>
  );
}
