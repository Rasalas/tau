/**
 * The bridge's raw record indexes are metadata for routing/forking, not UI
 * indexes. Keep the message-id projection in one place so paging, cache
 * normalization, and live merges cannot drift apart.
 */
export function messageIdToRawIndexProjection<T extends { id: string }>(
  messages: readonly T[] | undefined,
  rawIndexes: readonly number[] | undefined,
): Map<string, number> | undefined {
  if (!messages || !rawIndexes) return undefined;
  const projection = new Map<string, number>();
  messages.forEach((message, index) => {
    const rawIndex = rawIndexes[index];
    if (Number.isSafeInteger(rawIndex) && rawIndex >= 0) projection.set(message.id, rawIndex);
  });
  return projection;
}

export function projectRawIndexesByMessageId<T extends { id: string }>(
  messages: readonly T[],
  projection: ReadonlyMap<string, number> | undefined,
): number[] | undefined {
  if (!projection) return undefined;
  const indexes = messages.map((message) => projection.get(message.id));
  return indexes.every((index): index is number => index !== undefined) ? indexes : undefined;
}

export function mergeProjectedRawIndexes<T extends { id: string }>(
  currentMessages: readonly T[] | undefined,
  currentIndexes: readonly number[] | undefined,
  incomingMessages: readonly T[] | undefined,
  incomingIndexes: readonly number[] | undefined,
  mergedMessages: readonly T[],
): number[] | undefined {
  const currentProjection = messageIdToRawIndexProjection(currentMessages, currentIndexes);
  const incomingProjection = messageIdToRawIndexProjection(incomingMessages, incomingIndexes);
  if (!currentProjection && !incomingProjection) return undefined;
  const projection = new Map(currentProjection ?? []);
  for (const [id, index] of incomingProjection ?? []) projection.set(id, index);
  return projectRawIndexesByMessageId(mergedMessages, projection);
}
