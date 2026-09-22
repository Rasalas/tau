import { errorMessage, type WorkbenchActions } from "tau";
import type { PreviewAnnotationResult, PreviewPickedElement } from "./page-overlay.js";
import { annotationExcerpt, pickedElementExcerpt } from "./picks.js";
import type { ComposerContextChips, PreviewImage, PreviewRecording } from "./protocol.js";

/** Composer Context's own limit for a file a runtime opens itself. */
const MAX_FILE_CHIP_BYTES = 50 * 1024 * 1024;

type Actions = Pick<WorkbenchActions, "composerDraft" | "setComposerDraft" | "composerImages" | "setComposerImages" | "focusComposer">;

const done = (actions: Actions): undefined => {
  // The user asks about what they just handed over; the caret should be there.
  actions.focusComposer();
  return undefined;
};

/** Composer Context's chip service, while that kit is on. */
let chipService: ComposerContextChips | undefined;

export function holdChipService(chips: ComposerContextChips): () => void {
  chipService = chips;
  return () => { if (chipService === chips) chipService = undefined; };
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

/** Puts the image beside the draft's other images; `false` when this composer takes none. */
function addImage(actions: Actions, name: string, shot: PreviewImage | undefined): boolean {
  if (!shot || !actions.setComposerImages) return false;
  const current = actions.composerImages?.() ?? [];
  actions.setComposerImages([...current, { kind: "image", name, mimeType: "image/png", data: shot.data, size: decodedSize(shot.data) }]);
  return true;
}

/**
 * An excerpt chip through the chip service; without Composer Context the
 * same text goes into the draft. Answers an error message, or nothing.
 */
function addExcerpt(actions: Actions, excerpt: { label: string; source: string; text: string }, chips = chipService): string | undefined {
  try {
    if (chips) {
      chips.addChip({ kind: "text-excerpt", label: excerpt.label, payload: { source: excerpt.source, text: excerpt.text } });
    } else {
      const block = `From ${excerpt.source}:\n${excerpt.text}`;
      const draft = actions.composerDraft();
      if (actions.setComposerDraft) actions.setComposerDraft(draft ? `${draft}\n\n${block}` : block);
      else actions.focusComposer(block);
    }
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

export function attachPickedElement(actions: Actions, pick: { element: PreviewPickedElement; image?: PreviewImage }, chips = chipService): string | undefined {
  const withImage = Boolean(pick.image && actions.setComposerImages);
  const failure = addExcerpt(actions, pickedElementExcerpt(pick.element, withImage), chips);
  if (failure) return failure;
  if (withImage) addImage(actions, `preview-${pick.element.tag}.png`, pick.image);
  return done(actions);
}

export function attachAnnotations(actions: Actions, sent: { annotations: PreviewAnnotationResult; image?: PreviewImage }, chips = chipService): string | undefined {
  const withImage = Boolean(sent.image && actions.setComposerImages);
  const failure = addExcerpt(actions, annotationExcerpt(sent.annotations, withImage), chips);
  if (failure) return failure;
  if (withImage) addImage(actions, "preview-annotations.png", sent.image);
  return done(actions);
}

/** A recording is a file on the host: an attachment chip names its path. */
export function attachRecording(actions: Actions, recording: PreviewRecording, chips = chipService): string | undefined {
  const seconds = Math.max(1, Math.round(recording.durationMs / 1000));
  if (chips && recording.size <= MAX_FILE_CHIP_BYTES) {
    try {
      chips.addChip({
        kind: "attachment",
        label: `${recording.name} · ${seconds} s`,
        payload: { name: recording.name, mimeType: recording.mimeType, size: recording.size, path: recording.path },
      });
      return done(actions);
    } catch (error) {
      return errorMessage(error);
    }
  }
  return addExcerpt(actions, {
    label: `Recording · ${seconds} s`,
    source: "the Preview, a screen recording the user made",
    text: `${seconds} s of video (${recording.mimeType}), saved at ${recording.path}`,
  }, chips);
}
