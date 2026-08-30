import {
  Database,
  File,
  FileCode2,
  FileCog,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  Image,
} from "lucide-react";

const CODE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "jsx",
  "kt", "php", "py", "rb", "rs", "scss", "sh", "swift", "ts", "tsx", "vue",
]);
const TEXT_EXTENSIONS = new Set(["md", "mdx", "txt", "rst"]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const DATA_EXTENSIONS = new Set(["db", "sqlite", "sql"]);
const CONFIG_EXTENSIONS = new Set(["ini", "toml", "yaml", "yml"]);

export function FileKindIcon({
  name,
  directory = false,
  open = false,
  size = 13,
}: {
  name: string;
  directory?: boolean;
  open?: boolean;
  size?: number;
}) {
  if (directory) {
    const Icon = open ? FolderOpen : Folder;
    return <Icon aria-hidden="true" data-file-icon={open ? "folder-open" : "folder"} size={size} strokeWidth={1.7} />;
  }

  const normalized = name.toLowerCase();
  const extension = normalized.includes(".") ? normalized.split(".").pop() ?? "" : "";
  let Icon = File;
  let kind = "file";
  if (extension === "json") { Icon = FileJson2; kind = "json"; }
  else if (CODE_EXTENSIONS.has(extension)) { Icon = FileCode2; kind = "code"; }
  else if (TEXT_EXTENSIONS.has(extension)) { Icon = FileText; kind = "text"; }
  else if (IMAGE_EXTENSIONS.has(extension)) { Icon = Image; kind = "image"; }
  else if (DATA_EXTENSIONS.has(extension)) { Icon = Database; kind = "data"; }
  else if (CONFIG_EXTENSIONS.has(extension) || normalized === "dockerfile" || normalized.startsWith(".env")) {
    Icon = FileCog;
    kind = "config";
  }
  return <Icon aria-hidden="true" data-file-icon={kind} size={size} strokeWidth={1.7} />;
}
