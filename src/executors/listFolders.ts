import { grantedFolders } from "./folders.js";

export function runListFolders() {
  const folders = grantedFolders().map((folder) => ({
    id: folder.id,
    name: folder.name,
    path_display: folder.path,
    is_remote: false,
  }));
  return { folders };
}
