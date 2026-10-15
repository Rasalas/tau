import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { AlarmClock, ArrowUp, CornerUpRight, ListPlus, type LucideIcon } from "lucide-react";
import { Popover } from "./ui/Dialog";
import { isImeComposing } from "../keybindings";
import "./composer-send-chooser.css";
import { sendChoices, type SendChoice } from "./composer-send-choice";


const CHOICES: Record<SendChoice, { label: string; detail: string; Icon: LucideIcon }> = {
  steer: { label: "Steer this turn", detail: "Lands in the running turn", Icon: CornerUpRight },
  queue: { label: "Queue after this turn", detail: "Sends when the turn ends", Icon: ListPlus },
  send: { label: "Send now", detail: "Starts a turn", Icon: ArrowUp },
  plan: { label: "Plan…", detail: "Send it at a time, or repeat it", Icon: AlarmClock },
};

/**
 * The menu over the send button (design C2): ↑↓ or a digit picks, Enter or the
 * chord that opened it does it, Escape closes it. It opens on `initial`, the
 * choice the chord stands for, so the chord twice still does what it always did.
 */
export function ComposerSendChooser({ anchor, streaming, initial, disabledReason, onChoose, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  /** A turn runs: steer and queue; at rest, send. Plan comes last either way. */
  streaming: boolean;
  initial: SendChoice;
  /** Why nothing can go yet, such as an empty draft; Plan stays open to it. */
  disabledReason?: string | undefined;
  onChoose(choice: SendChoice): void;
  onClose(): void;
}) {
  const choices = sendChoices(streaming, true);
  const [active, setActive] = useState(() => Math.max(0, choices.indexOf(initial)));
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  useLayoutEffect(() => { rows.current[active]?.focus({ preventScroll: true }); }, [active]);
  const blocked = (choice: SendChoice) => Boolean(disabledReason) && choice !== "plan";
  const choose = (choice: SendChoice) => { if (!blocked(choice)) onChoose(choice); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
      return;
    }
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setActive(digit - 1);
      choose(choices[digit - 1]!);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(choices[active]!);
    }
  };
  return (
    <Popover anchor={anchor} side="top" align="end" label="Send options" className="composer-send-chooser" onClose={onClose}>
      <div className="composer-send-chooser-list" role="menu" aria-label="Send options" tabIndex={-1} onKeyDown={onKeyDown}>
        {choices.map((choice, index) => {
          const { label, detail, Icon } = CHOICES[choice];
          return (
            <button
              key={choice}
              ref={(element) => { rows.current[index] = element; }}
              type="button"
              role="menuitem"
              className={`composer-send-choice${index === active ? " active" : ""}`}
              aria-disabled={blocked(choice) || undefined}
              {...(blocked(choice) && disabledReason ? { "data-tooltip": disabledReason, "data-tooltip-side": "left" } : {})}
              tabIndex={index === active ? 0 : -1}
              // A real move, not a menu opening under a resting pointer.
              onMouseMove={() => { if (index !== active) setActive(index); }}
              onClick={() => choose(choice)}
            >
              <Icon size={15} aria-hidden="true" />
              <span><em>{label}</em><small>{detail}</small></span>
              <kbd>{index + 1}</kbd>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
