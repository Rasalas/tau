import { Trash2 } from "lucide-react";
import type { ExtensionRegistry } from "../extension-system";
import { LazyFeatureBoundary } from "./LazyFeature";
import { Popover } from "./ui/Dialog";
import type { ComposerChipEntry } from "./useComposerChips";

/** What a click on a chip in the text opens: what it is, its own details, and Remove. */
export function ComposerChipPopover({ label, point, entry, scope, registry, onPreview, onRemove, onClose, onNotify }: {
  label: string;
  point: { x: number; y: number };
  entry?: ComposerChipEntry;
  scope: string;
  registry?: ExtensionRegistry;
  onPreview(imageId: number): void;
  onRemove(): void;
  onClose(): void;
  onNotify?(message: string): void;
}) {
  const Detail = entry?.Detail;
  return (
    <Popover anchor={point} side="top" align="start" label={label} className="composer-chip-popover" onClose={onClose}>
      <header>
        <strong>{label}</strong>
        <button type="button" className="icon-button" aria-label={`Remove ${label}`} onClick={() => { onRemove(); onClose(); }}>
          <Trash2 size={13} />
        </button>
      </header>
      {entry?.title ? <p className="composer-chip-title">{entry.title}</p> : null}
      {!entry ? <p className="composer-chip-title">Nothing holds this chip any more. It is sent as its label.</p> : null}
      {entry?.image ? (
        <button type="button" className="composer-chip-preview" aria-label={`Preview ${entry.image.name}`} onClick={() => { onPreview(entry.image!.id); onClose(); }}>
          <img src={entry.image.previewUrl} alt="" />
        </button>
      ) : null}
      {Detail && entry ? (
        <LazyFeatureBoundary
          label={entry.key}
          extensionId={entry.inline?.extensionId}
          extensionName={entry.inline?.extensionName}
          registry={registry}
          onNotify={onNotify}
        >
          <Detail scope={scope} chipId={entry.id} close={onClose} />
        </LazyFeatureBoundary>
      ) : null}
    </Popover>
  );
}
