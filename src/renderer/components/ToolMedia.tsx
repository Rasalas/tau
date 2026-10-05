import type { UiToolRun } from "../../shared/contracts";
import { MessageImageGallery } from "./MessageImages";
import { WorkspaceVideo } from "./WorkspaceVideo";
import { WorkspaceImage } from "./WorkspaceImage";

const IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,[A-Za-z0-9+/=\s]+$/iu;
const EXTERNAL = /^https?:\/\//iu;

/** Media is a result the user can inspect, independent of the tool log disclosure. */
export function ToolMedia({ tool }: { tool: UiToolRun }) {
  const gallery = tool.media?.flatMap((media, index) => {
    const safe = EXTERNAL.test(media.url) || (media.type === "image" ? IMAGE.test(media.url) : /^data:video\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/iu.test(media.url));
    return safe && (media.type === "image" || media.type === "video") ? [{ key: `${tool.id}:${index}`, kind: media.type, src: media.url, alt: media.type === "image" ? "Tool result image" : "Tool result video" }] : [];
  }) ?? [];
  return <><MessageImageGallery origin="from a tool result" images={gallery} />{tool.media?.map((media, index) => {
    if (gallery.some((entry) => entry.key === `${tool.id}:${index}`)) return null;
    if (media.type === "image") return <WorkspaceImage key={index} src={media.url} alt="Tool result image" />;
    if (media.type === "audio" && (EXTERNAL.test(media.url) || /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/iu.test(media.url))) return <audio key={index} src={media.url} controls preload="metadata" />;
    if (media.type === "video") return <WorkspaceVideo key={index} src={media.url} alt="Tool result video" />;
    return null;
  })}</>;
}
