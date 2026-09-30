const API = "https://firestore.googleapis.com/v1";

function encode(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number" && Number.isSafeInteger(value)) return { integerValue: String(value) };
  if (value === null) return { nullValue: null };
  if (value && typeof value === "object" && !Array.isArray(value)) return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } };
  throw new Error("Invalid relay state value.");
}
function decode(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decode(item)]));
  throw new Error("Invalid relay state value.");
}

/** Runtime identity only. No service account key or push-relay credential is used. */
export function metadataAccessToken(fetchImpl = fetch) {
  let cached;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const response = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error("Runtime identity is unavailable.");
    const token = await response.json();
    if (typeof token.access_token !== "string" || !(token.expires_in > 60)) throw new Error("Runtime identity is invalid.");
    cached = { token: token.access_token, until: Date.now() + (token.expires_in - 60) * 1_000 };
    return cached.token;
  };
}

/** A single bounded state document; optimistic retries use Firestore's transaction isolation. */
export function createFirestoreDocument({ project, database = "tau-connect", fetchImpl = fetch, tokenProvider = metadataAccessToken(fetchImpl) }) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(project ?? "") || !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u.test(database)) throw new Error("Invalid Firestore project or database.");
  const base = `projects/${project}/databases/${database}/documents`;
  const name = `${base}/tauConnect/state`;
  const call = async (path, method, body) => {
    const response = await fetchImpl(`${API}/${path}`, {
      method, headers: { Authorization: `Bearer ${await tokenProvider()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4_000),
    });
    // Google supplies the time used to compare leases; local clocks cannot acquire early.
    const now = Date.parse(response.headers.get("date"));
    if (!Number.isFinite(now)) throw new Error("Firestore response lacks server time.");
    if (response.status === 404 && method === "GET") return { body: {}, now };
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(`Firestore request failed (${response.status}).`);
      error.retryable = result.error?.status === "ABORTED";
      throw error;
    }
    return { body: result, now };
  };
  return {
    async update(mutate) {
      for (let attempt = 0; attempt < 5; attempt++) {
        let transaction;
        try {
          transaction = (await call(`${base}:beginTransaction`, "POST", { options: { readWrite: {} } })).body.transaction;
          if (typeof transaction !== "string") throw new Error("Firestore returned an invalid transaction.");
          const read = await call(`${name}?transaction=${encodeURIComponent(transaction)}`, "GET");
          const state = read.body.fields ? decode({ mapValue: { fields: read.body.fields } }) : { routes: {}, allowedRevision: null, lease: null };
          const before = JSON.stringify(state);
          const result = mutate(state, read.now);
          const writes = before === JSON.stringify(state) ? [] : [{ update: { name, fields: encode(state).mapValue.fields } }];
          await call(`${base}:commit`, "POST", { transaction, writes });
          return { state, result };
        } catch (error) {
          if (transaction) await call(`${base}:rollback`, "POST", { transaction }).catch(() => {});
          if (!error.retryable || attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
    },
  };
}
