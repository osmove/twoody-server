import {isAbsolute, relative, sep} from 'node:path';

export type IndexedEntry = {id: string; name: string; path: string; status: string; modified_at: number};
/** Browse metadata already in the index; never enumerate the filesystem. */
export function indexedDirectory(root: string, files: IndexedEntry[], directory = '') {
  if (isAbsolute(directory) || directory.includes('\\') || directory.split('/').some(part => part === '..' || part === '.') || directory.includes('\0')) throw new Error('invalid_directory');
  const prefix = directory ? `${directory.replace(/\/$/, '')}/` : '';
  const folders = new Map<string, number>();
  const entries: Array<IndexedEntry & {type: 'file'}> = [];
  for (const file of files) {
    const local = relative(root, file.path);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) continue;
    const path = local.split(sep).join('/');
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) || 0) + 1);
    } else entries.push({...file, path, type: 'file'});
  }
  return [
    ...Array.from(folders, ([name, count]) => ({type: 'directory' as const, name, path: prefix + name, count})).sort((a,b)=>a.name.localeCompare(b.name)),
    ...entries.sort((a,b)=>a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  ];
}
