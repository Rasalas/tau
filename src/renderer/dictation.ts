/** Audio and recognition stay on the device. Finalized speech enters the draft without confirmation. */
export interface DictationUpdate {
  /** Cumulative finalized text; intermediate hypotheses never replace edited draft text. */
  text: string;
  preview?: string;
  level?: number;
  error?: string;
  cancelled?: boolean;
  limitReached?: boolean;
}

export interface DictationPort {
  languages(): Promise<{ available: boolean; defaultLanguage?: string; languages: Array<{ id: string; name: string; installed: boolean }> }>;
  download(language: string): Promise<void>;
  start(language: string): Promise<void>;
  finish(): Promise<string>;
  cancel(): Promise<void>;
  /** Native clients may stream results while the microphone remains open. */
  listen?(listener: (update: DictationUpdate) => void): Promise<() => void>;
}

/** Never pick the first language in a sorted list when the device's language is unsupported. */
export function dictationLanguage(languages: readonly { id: string }[], chosen: string, deviceLanguage: string): string | undefined {
  const requested = chosen || deviceLanguage;
  const normalize = (value: string) => value.replaceAll("_", "-").toLowerCase();
  return languages.find((entry) => normalize(entry.id) === normalize(requested))?.id
    ?? languages.find((entry) => normalize(entry.id).split("-")[0] === normalize(requested).split("-")[0])?.id;
}

export function insertDictation(text: string, start: number, end: number, transcript: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(start, text.length));
  const until = Math.max(at, Math.min(end, text.length));
  return { text: text.slice(0, at) + transcript + text.slice(until), caret: at + transcript.length };
}
