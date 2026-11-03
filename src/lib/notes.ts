export type NoteInfo = {
  id: string;
  path: string;
  folder: string;
  title: string;
  mtime: number;
  pinned: boolean;
};

export type FolderInfo = { path: string; name: string };
