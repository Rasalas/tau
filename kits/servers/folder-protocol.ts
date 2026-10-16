/** One explicitly opened directory. Names only; no recursive indexing or contents. */
export interface ServerFolderListing {
  root: string;
  path: string;
  entries: Array<{ name: string; directory: boolean }>;
  matches: number;
  localItems: number;
}

export interface ServerFolderMatch {
  weak: boolean;
  listing: ServerFolderListing;
}
