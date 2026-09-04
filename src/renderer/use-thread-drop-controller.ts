import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { THREAD_DROP_FEEDBACK, classifyThreadDrop, type ThreadDropState } from "../shared/thread-drop";

export function useThreadDropController(
  supportsImageInput: boolean,
  addFiles: (files: FileList | readonly File[]) => void,
  existingAttachments: readonly { size: number }[] = [],
) {
  const [state, setState] = useState<ThreadDropState>("idle");
  const depthRef = useRef(0);

  const classify = useCallback((dataTransfer: DataTransfer): ThreadDropState => {
    const files = Array.from(dataTransfer.files ?? []);
    let fileIndex = 0;
    const items = Array.from(dataTransfer.items ?? []).map((item) => ({
      kind: item.kind,
      mimeType: item.type,
      size: item.kind === "file" ? files[fileIndex++]?.size : undefined,
    }));
    return classifyThreadDrop(
      Array.from(dataTransfer.types).includes("Files"),
      items,
      supportsImageInput,
      existingAttachments.length,
      existingAttachments.reduce((total, attachment) => total + attachment.size, 0),
    );
  }, [existingAttachments, supportsImageInput]);

  const cancel = useCallback(() => {
    depthRef.current = 0;
    setState("idle");
  }, []);

  useEffect(() => {
    if (state === "idle") return;
    const cancelKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("dragend", cancel);
    window.addEventListener("drop", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", cancelKey);
    return () => {
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("drop", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", cancelKey);
    };
  }, [cancel, state]);

  const onDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    const next = classify(event.dataTransfer);
    if (next === "idle") return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    event.preventDefault();
    depthRef.current += 1;
    setState(next);
  }, [classify]);

  const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    const next = classify(event.dataTransfer);
    if (next === "idle") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = THREAD_DROP_FEEDBACK[next].dropEffect;
    setState(next);
  }, [classify]);

  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (depthRef.current === 0) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setState("idle");
  }, []);

  const onDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (classify(event.dataTransfer) === "idle") return;
    event.preventDefault();
    depthRef.current = 0;
    setState("idle");
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }, [addFiles, classify]);

  return useMemo(
    () => ({ state, onDragEnter, onDragOver, onDragLeave, onDrop }),
    [onDragEnter, onDragLeave, onDragOver, onDrop, state],
  );
}
