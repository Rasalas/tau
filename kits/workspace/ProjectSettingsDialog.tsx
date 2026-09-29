import { createElement, useMemo, useRef, useState, type ComponentType } from "react";
import { icons, type LucideProps } from "lucide-react";
import { Dialog, MiddleTruncate, errorMessage, type UiProject } from "tau";
import {
  PROJECT_EMOJIS,
  PROJECT_ICON_HUES,
  emojiImage,
  firstEmoji,
  iconColor,
  imageFileImage,
  monogramImage,
  monogramText,
  svgElementImage,
  type ProjectIconChoice,
} from "./project-icons.js";

type Mode = "auto" | ProjectIconChoice["kind"];
const MODES: Array<{ id: Mode; label: string }> = [
  { id: "auto", label: "Automatic" },
  { id: "icon", label: "Icons" },
  { id: "emoji", label: "Emoji" },
  { id: "monogram", label: "Monogram" },
  { id: "image", label: "Image" },
];
const ICON_NAMES = Object.keys(icons);
const FIRST_ICONS = ["FolderCode", "Code", "Terminal", "Rocket", "Globe", "Database", "Server", "Smartphone", "Bot", "Brain", "Book", "Package", "Wrench", "FlaskConical", "Palette", "Gamepad2", "Leaf", "Zap", "Shield", "Cloud"];
const ICON_LIMIT = 80;

/** "FolderCode" reads as "Folder code". */
const iconLabel = (name: string) => name.replace(/(?<=[a-z0-9])(?=[A-Z])/gu, " ").replace(/ (\w)/gu, (_, letter: string) => ` ${letter.toLowerCase()}`);

export function filterIconNames(query: string): string[] {
  const needle = query.trim().toLowerCase().replace(/[\s-]+/gu, "");
  if (!needle) return FIRST_ICONS.filter((name) => name in icons);
  return ICON_NAMES.filter((name) => name.toLowerCase().includes(needle)).slice(0, ICON_LIMIT);
}

function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return monogramText(words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)) ?? "P";
}

/**
 * Project settings: the project's name and path, and its icon (a Lucide
 * icon in a colour, an emoji, a monogram, or an image).
 */
export function ProjectSettingsDialog({ project, current, automatic, onSave, onClose, onError }: {
  project: UiProject;
  current?: ProjectIconChoice;
  /** What the project shows without a choice: its favicon or `t3.json` icon. */
  automatic?: string;
  onSave(choice: ProjectIconChoice | undefined): void;
  onClose(): void;
  onError(message: string): void;
}) {
  const [mode, setMode] = useState<Mode>(current?.kind ?? "auto");
  const [name, setName] = useState(current?.kind === "icon" ? current.name : "FolderCode");
  const [hue, setHue] = useState<number>(current && "hue" in current ? current.hue : PROJECT_ICON_HUES[0].hue);
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [letters, setLetters] = useState(current?.kind === "monogram" ? current.text : initials(project.name));
  const [image, setImage] = useState(current?.kind === "image" ? current.image : undefined);
  const [query, setQuery] = useState("");
  const preview = useRef<HTMLSpanElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterIconNames(query), [query]);
  const monogram = monogramText(letters);
  const Icon = (icons as Record<string, ComponentType<LucideProps>>)[name];

  const choice = (): ProjectIconChoice | undefined | false => {
    if (mode === "auto") return undefined;
    if (mode === "emoji") return { kind: "emoji", emoji, image: emojiImage(emoji) };
    if (mode === "monogram") return monogram ? { kind: "monogram", text: monogram, hue, image: monogramImage(monogram, hue) } : false;
    if (mode === "image") return image ? { kind: "image", image } : false;
    const svg = preview.current?.querySelector("svg");
    return svg ? { kind: "icon", name, hue, image: svgElementImage(svg, hue) } : false;
  };
  const save = () => {
    const picked = choice();
    if (picked === false) return;
    onSave(picked);
  };

  const hues = (
    <div className="project-icon-hues" role="group" aria-label="Icon colour">
      {PROJECT_ICON_HUES.map((option) => (
        <button key={option.hue} type="button" aria-label={option.label} aria-pressed={hue === option.hue} onClick={() => setHue(option.hue)}>
          <i style={{ background: iconColor(option.hue) }} />
        </button>
      ))}
    </div>
  );

  return (
    <Dialog className="project-settings-dialog" label="Project settings" onClose={onClose}>
      <h2>Project settings</h2>
      <div className="project-settings-identity">
        <strong>{project.name}</strong>
        <MiddleTruncate value={project.displayPath ?? project.path} title={project.displayPath ?? project.path} />
      </div>
      <div className="settings-label">Icon</div>
      <div className="segmented" role="group" aria-label="Icon type">
        {MODES.map((entry) => (
          <button key={entry.id} type="button" className={mode === entry.id ? "active" : ""} aria-pressed={mode === entry.id} onClick={() => setMode(entry.id)}>{entry.label}</button>
        ))}
      </div>
      <div className="project-icon-body">
        {mode === "auto" ? (
          <p className="project-icon-note">
            {automatic ? <img src={automatic} alt="" /> : null}
            The project's favicon or <code>t3.json</code> icon when it has one, else its initial.
          </p>
        ) : mode === "icon" ? (
          <>
            <div className="project-icon-row">
              <span ref={preview} className="project-icon-preview" style={{ color: iconColor(hue) }}>{Icon ? createElement(Icon, { size: 22, "aria-hidden": true }) : null}</span>
              {hues}
            </div>
            <input type="search" value={query} aria-label="Search Lucide icons" placeholder="Search all Lucide icons" onChange={(event) => setQuery(event.target.value)} />
            <div className="project-icon-grid" role="group" aria-label="Icons">
              {shown.map((entry) => {
                const Glyph = (icons as Record<string, ComponentType<LucideProps>>)[entry]!;
                return (
                  <button key={entry} type="button" aria-label={iconLabel(entry)} aria-pressed={entry === name} onClick={() => setName(entry)}>
                    <Glyph size={17} aria-hidden="true" />
                  </button>
                );
              })}
              {shown.length === 0 ? <p>No icons found.</p> : null}
            </div>
          </>
        ) : mode === "emoji" ? (
          <>
            <div className="project-icon-grid emoji" role="group" aria-label="Emoji">
              {PROJECT_EMOJIS.map((entry) => (
                <button key={entry} type="button" aria-label={entry} aria-pressed={entry === emoji} onClick={() => setEmoji(entry)}>{entry}</button>
              ))}
            </div>
            <input aria-label="Any emoji" placeholder="Or type or paste any emoji" onChange={(event) => { const typed = firstEmoji(event.target.value); if (typed) setEmoji(typed); }} />
          </>
        ) : mode === "monogram" ? (
          <div className="project-icon-row">
            <img className="project-icon-preview" src={monogramImage(monogram ?? initials(project.name), hue)} alt="" />
            <label className="project-icon-letters">
              <span>Letters</span>
              <input value={letters} maxLength={4} aria-invalid={!monogram} onChange={(event) => setLetters(event.target.value)} />
              <small>One or two letters or numbers.</small>
            </label>
            {hues}
          </div>
        ) : (
          <div className="project-icon-row">
            {image ? <img className="project-icon-preview" src={image} alt="" /> : null}
            <button type="button" className="project-icon-file" onClick={() => file.current?.click()}>{image ? "Choose another image…" : "Choose an image…"}</button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) imageFileImage(picked).then(setImage, (error: unknown) => onError(`Could not read ${picked.name}: ${errorMessage(error)}`));
              }}
            />
          </div>
        )}
      </div>
      <footer>
        <button type="button" className="text-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={(mode === "monogram" && !monogram) || (mode === "image" && !image)} onClick={save}>Save</button>
      </footer>
    </Dialog>
  );
}
