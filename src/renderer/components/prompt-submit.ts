import { createContext, useContext, useEffect, useRef } from "react";

export interface PromptSubmitAction {
  label: string;
  disabled: boolean;
  submit(): void;
}

export const PromptSubmitContext = createContext<(action: PromptSubmitAction | undefined) => void>(() => {});

/** Lets a prompt renderer put its commit action in the composer's action row. */
export function usePromptSubmit(label: string | undefined, disabled: boolean, submit: (() => void) | undefined): void {
  const register = useContext(PromptSubmitContext);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const available = submit !== undefined;
  useEffect(() => {
    if (!label || !available) {
      register(undefined);
      return;
    }
    register({ label, disabled, submit: () => submitRef.current?.() });
    return () => register(undefined);
  }, [available, disabled, label, register]);
}
