import { appendUsageTurn, type UiModelBilling, type UsageTurn } from "tau/host-extension";
import { ClaudeProjectParser, CodexRolloutParser, RereadNeeded, type OutsideRecord, type OutsideSink } from "./outside-logs.js";

/**
 * What one CLI session cost, as a thread imported from it keeps it: the
 * responses its log counts, read by the same parsers as work outside Tau,
 * summed per prompt and model.
 */

function collect(read: (sink: OutsideSink) => void): OutsideRecord[] {
  const records: OutsideRecord[] = [];
  const seen = new Set<string>();
  read({
    add: (record) => {
      if (seen.has(record.key)) return false;
      seen.add(record.key);
      records.push(record);
      return true;
    },
    replace: (previous, next) => { records[records.indexOf(previous)] = next; },
  });
  return records;
}

function codexRecords(lines: readonly string[], sessionId: string): OutsideRecord[] {
  const read = (modernSince?: number) => collect((sink) => {
    const parser = new CodexRolloutParser(sessionId, sink, undefined, modernSince);
    for (const line of lines) parser.line(line);
  });
  try {
    return read();
  } catch (error) {
    if (error instanceof RereadNeeded) return read(error.modernSince);
    throw error;
  }
}

function claudeRecords(lines: readonly string[], sessionId: string): OutsideRecord[] {
  return collect((sink) => {
    const parser = new ClaudeProjectParser(sessionId, sink);
    for (const line of lines) parser.line(line);
    parser.identity();
  });
}

/**
 * A session log's turns: one per prompt and model, dated at its last
 * response; the prompt counts once, on the model that answered first.
 * Responses before the first prompt belong to it.
 */
export function sessionUsageTurns(format: "codex" | "agent-sdk", lines: readonly string[], options: { sessionId: string; prompts: readonly number[]; billing?: UiModelBilling }): UsageTurn[] {
  const records = (format === "codex" ? codexRecords : claudeRecords)(lines, options.sessionId).sort((left, right) => left.at - right.at);
  const prompts = [...options.prompts].sort((left, right) => left - right);
  const turns = new Map<string, UsageTurn>();
  const counted = new Set<number>();
  let prompt = 0;
  for (const record of records) {
    while (prompt + 1 < prompts.length && prompts[prompt + 1]! <= record.at) prompt += 1;
    const key = `${prompt}\u0000${record.provider ?? ""}\u0000${record.model}`;
    let turn = turns.get(key);
    if (!turn) {
      turn = {
        ...(record.provider ? { provider: record.provider } : {}),
        model: record.model,
        ...(options.billing ? { billing: options.billing } : {}),
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0,
        turns: counted.has(prompt) ? 0 : 1,
        at: record.at,
      };
      counted.add(prompt);
      turns.set(key, turn);
    }
    turn.inputTokens += record.input;
    turn.outputTokens += record.output;
    turn.cacheReadTokens += record.cacheRead;
    turn.cacheWriteTokens += record.cacheWrite;
    turn.totalTokens += record.total;
    turn.costUsd += record.cost;
    turn.at = record.at;
  }
  // Past the turns a thread keeps, the oldest fold together as they would have in Tau.
  return [...turns.values()].reduce<UsageTurn[]>((list, turn) => appendUsageTurn(list, turn), []);
}
