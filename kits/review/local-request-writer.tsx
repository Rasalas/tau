import { useState } from "react";
import { ImagePlus, Sparkles } from "lucide-react";
import { errorMessage, Markdown, type PreferencesStore, type WorkbenchActions } from "tau";
import { chosenWritingModel, followRequestTemplate, writingInstructions } from "./commit-messages.js";
import { EvidenceThumb } from "./local-request-evidence.js";
import type { LocalRequestClient } from "./local-request-client.js";
import { evidenceKey, evidenceToken, findEvidenceTokens, insertEvidence, splitBody, type EvidenceMedia, type LocalEvidence, type UploadPlan } from "./local-request.js";
import { providerInfo, type ReviewRequest, type ReviewRequestStatus } from "./protocol.js";
import { openPullRequest } from "./pull-request-open.js";
import type { RequestClient } from "./requests.js";

export interface LocalForm {
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

type Step =
  | { kind: "edit" }
  | { kind: "confirm"; action: "create" | "attach"; media: EvidenceMedia[]; plan?: UploadPlan; planError?: string };

const count = (n: number) => `${n} ${n === 1 ? "picture" : "pictures"}`;

/**
 * The description and what happens to it: written by a small model only on
 * a click, edited by hand, previewed with its pictures, and — once the user
 * has seen which pictures go where — created as the request, or sent to an
 * open one as a comment.
 */
export function LocalRequestWriter({ form, onForm, status, branch, root, selected, frames, client, requests, actions, preferences, onCreated }: {
  form: LocalForm;
  onForm(update: Partial<LocalForm>): void;
  status: ReviewRequestStatus | undefined;
  branch: string | undefined;
  root: string;
  /** The chosen pictures, in the order the gallery shows them. */
  selected: readonly LocalEvidence[];
  /** Every picture of the branch by `evidenceKey`, for the preview. */
  frames: ReadonlyMap<string, LocalEvidence>;
  client: LocalRequestClient;
  requests: RequestClient;
  actions: WorkbenchActions;
  preferences: PreferencesStore;
  onCreated(request: ReviewRequestStatus): void;
}) {
  const [step, setStep] = useState<Step>({ kind: "edit" });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [writtenBy, setWrittenBy] = useState<string>();
  const { short, capabilities, noun } = providerInfo(status?.service ?? "github");
  const request = status?.request;
  const open: ReviewRequest | undefined = request && (request.state === undefined || request.state === "open") ? request : undefined;
  const media = selected.map((frame): EvidenceMedia => ({ threadId: frame.threadId, source: frame.source, id: frame.id, caption: frame.caption }));

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try { await work(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(undefined); }
  };

  const write = () => run("Writing the description…", async () => {
    const thread = actions.activeThread();
    const chosen = chosenWritingModel(preferences);
    const instructions = writingInstructions(preferences);
    const draft = await client.describe({
      ...(form.base.trim() ? { base: form.base.trim() } : {}),
      ...(chosen ? { model: chosen } : {}),
      ...(thread?.model ? { prefer: thread.model } : {}),
      ...(instructions ? { instructions } : {}),
      ...(followRequestTemplate(preferences) ? {} : { template: false }),
      evidence: media.map((entry) => entry.caption),
    });
    onForm({ title: draft.title, body: insertEvidence(draft.body, media), ...(form.base.trim() ? {} : { base: draft.base }) });
    setWrittenBy(draft.model ?? "the default model");
    setPreview(false);
  });

  const confirm = (action: "create" | "attach") => {
    const named = action === "create" ? findEvidenceTokens(form.body) : media;
    if (action === "create" && named.length === 0) { void create(false); return; }
    setStep({ kind: "confirm", action, media: named });
    (action === "attach" && open ? client.plan(open.url, branch) : client.plan()).then(
      (plan) => setStep((current) => current.kind === "confirm" ? { ...current, plan } : current),
      (reason: unknown) => setStep((current) => current.kind === "confirm" ? { ...current, planError: errorMessage(reason) } : current),
    );
  };

  const create = (withPictures: boolean) => run(withPictures ? "Uploading the pictures and creating…" : `Creating the ${short}…`, async () => {
    const result = await requests.create({ title: form.title.trim(), body: form.body, base: form.base.trim(), draft: form.draft, ...(withPictures ? { uploadConfirmed: true } : {}) });
    setStep({ kind: "edit" });
    onCreated(result.status);
    const created = result.status.request;
    const pictures = result.uploaded ? ` with ${count(result.uploaded)}` : result.kept ? `; ${count(result.kept)} stayed on this machine` : "";
    actions.notify(created ? `${short} #${created.number} created${pictures}.` : `${short} created${pictures}.`);
    if (created) openPullRequest(actions, created, root);
  });

  const attach = (target: ReviewRequest) => run("Uploading the pictures…", async () => {
    const body = `Pictures from Tau of \`${branch ?? "this branch"}\`:\n\n${media.map(evidenceToken).join("\n")}`;
    const result = await client.attach({ url: target.url, body, ...(branch ? { branch } : {}) });
    setStep({ kind: "edit" });
    actions.notify(`${count(result.uploaded)} added to ${short} #${target.number}.`);
  });

  const blocked = status?.problem;
  const inBody = findEvidenceTokens(form.body);

  if (step.kind === "confirm") {
    const { plan } = step;
    const going = plan && plan.kind !== "none";
    const verb = step.action === "create" ? `create the ${short} into ${form.base.trim() || status?.base || "its base"}` : `add them to ${short} #${open?.number ?? ""} as a comment`;
    return (
      <div className="lpr-confirm" role="group" aria-label={step.action === "create" ? `Create ${short}` : "Attach pictures"}>
        {step.planError ? <p className="pr-error" role="alert">{step.planError}</p> : null}
        {!plan && !step.planError ? <p className="pr-empty" role="status">Finding out where the pictures can go…</p> : null}
        {plan ? (
          <p className="lpr-confirm-text">
            {going
              ? <>Upload {count(step.media.length)} to <strong>{plan.destination}</strong>, then {verb}?</>
              : <>{count(step.media.length)} {step.media.length === 1 ? "stays" : "stay"} on this machine: {plan.reason} {step.action === "create" ? "They are taken out of the description." : ""}</>}
          </p>
        ) : null}
        <div className="lpr-strip lpr-confirm-strip" aria-label="Pictures that go with it">
          {step.media.map((entry) => {
            const frame = frames.get(evidenceKey(entry));
            return frame ? <EvidenceThumb key={evidenceKey(entry)} frame={frame} client={client} /> : <span key={evidenceKey(entry)} className="lpr-missing" title={entry.caption}>Gone</span>;
          })}
        </div>
        {error ? <p className="pr-error" role="alert">{error}</p> : null}
        {busy ? <p className="request-busy">{busy}</p> : null}
        <div className="commit-actions">
          {step.action === "create" ? (
            <button className="primary" disabled={!plan || Boolean(busy)} onClick={() => void create(true)}>
              {going ? `Upload and create ${short}` : `Create ${short} without pictures`}
            </button>
          ) : (
            <button className="primary" disabled={!going || Boolean(busy) || !open} onClick={() => { if (open) void attach(open); }}>Upload and comment</button>
          )}
          <button disabled={Boolean(busy)} onClick={() => { setStep({ kind: "edit" }); setError(undefined); }}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="lpr-writer">
      <input className="lpr-title" aria-label={`${short} title`} placeholder="Title" value={form.title} onChange={(event) => onForm({ title: event.target.value })} />
      <div className="lpr-writer-bar">
        <button className="mini-button" disabled={Boolean(busy)} onClick={() => void write()} title={`A small model writes the title and description from the commits${media.length ? " and the chosen pictures" : ""}`}>
          <Sparkles size={12} aria-hidden="true" /> {form.body.trim() ? "Rewrite description" : "Write description"}
        </button>
        <button className="mini-button" disabled={media.length === 0 || Boolean(busy)} onClick={() => onForm({ body: insertEvidence(form.body, media) })} title="Adds the chosen pictures under Screenshots">
          <ImagePlus size={12} aria-hidden="true" /> Insert {count(media.length)}
        </button>
        <span className="spacer" />
        {writtenBy ? <small className="lpr-note">Written by {writtenBy}</small> : null}
        <div className="toggle-group" role="tablist" aria-label="Description">
          <button role="tab" aria-selected={!preview} className={preview ? "" : "active"} onClick={() => setPreview(false)}>Write</button>
          <button role="tab" aria-selected={preview} className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button>
        </div>
      </div>
      {preview ? (
        <div className="lpr-preview" aria-label="Description preview">
          {form.body.trim() ? splitBody(form.body).map((segment, index) => segment.kind === "text"
            ? <Markdown key={index}>{segment.text}</Markdown>
            : <figure key={index} className="lpr-figure">
                {frames.get(evidenceKey(segment.media))
                  ? <EvidenceThumb frame={frames.get(evidenceKey(segment.media))!} client={client} />
                  : <span className="lpr-missing">Gone</span>}
                <figcaption>{segment.media.caption}</figcaption>
              </figure>) : <p className="pr-empty">Nothing written yet.</p>}
        </div>
      ) : (
        <textarea className="lpr-body" aria-label={`${short} description`} placeholder={`Describe the ${noun}, or let a small model write it`} value={form.body} onChange={(event) => onForm({ body: event.target.value })} />
      )}
      <div className="lpr-writer-foot">
        <label className="request-base">into <input aria-label="Base branch" value={form.base} placeholder={status?.base ?? "main"} onChange={(event) => onForm({ base: event.target.value })} /></label>
        {capabilities.draft ? <label className="request-draft"><input type="checkbox" checked={form.draft} onChange={(event) => onForm({ draft: event.target.checked })} /> Draft</label> : null}
        <span className="spacer" />
        {inBody.length > 0 ? <small className="lpr-note">{count(inBody.length)} in the description</small> : null}
        {open ? (
          <>
            <button onClick={() => openPullRequest(actions, open, root)}>Open {short} #{open.number}</button>
            <button className="primary" disabled={media.length === 0 || Boolean(busy)} onClick={() => confirm("attach")}>Attach {count(media.length)}…</button>
          </>
        ) : capabilities.create ? (
          <button className="primary" disabled={!form.title.trim() || Boolean(busy) || Boolean(blocked)} title={blocked} onClick={() => confirm("create")}>
            {form.draft ? `Create draft ${short}…` : `Create ${short}…`}
          </button>
        ) : null}
      </div>
      {blocked && !open ? <p className="request-problem" role="note">{blocked}</p> : null}
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
      {busy ? <p className="request-busy">{busy}</p> : null}
    </div>
  );
}
