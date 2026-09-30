/** Native dictation records and transcribes locally. Only the reviewed text enters a draft. */
export interface DictationPort {
  languages(): Promise<{ available: boolean; languages: Array<{ id: string; name: string; installed: boolean }> }>;
  download(language: string): Promise<void>;
  start(language: string): Promise<void>;
  finish(): Promise<string>;
  cancel(): Promise<void>;
}

export function insertDictation(text: string, start: number, end: number, transcript: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(start, text.length));
  const until = Math.max(at, Math.min(end, text.length));
  return { text: text.slice(0, at) + transcript + text.slice(until), caret: at + transcript.length };
}
