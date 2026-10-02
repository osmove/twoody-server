// How much a memory matters, on four levels the person picks (Jimmy,
// 02/10/2026: « ajouter un poids ou importance aux souvenirs… 4 niveaux »):
//   0 Faible     — only with a message it bears on, never in the profile
//   1 Normal     — the default
//   2 Important  — in the profile before the rest
//   3 Essentiel  — always known (what « épinglé » was)
// Kept as a tag, as « pinned » always was, so that every device and the
// encrypted history carry it as they are: « minor », none, « important »,
// « pinned ».

export const IMPORTANCE_TAGS = ["minor", "important", "pinned"] as const;
export type Importance = 0 | 1 | 2 | 3;

export function importanceOf(tags: readonly string[]): Importance {
  if (tags.includes("pinned")) return 3;
  if (tags.includes("important")) return 2;
  if (tags.includes("minor")) return 0;
  return 1;
}

/// The tags with this level instead of the one they had.
export function withImportance(tags: readonly string[], level: Importance): string[] {
  const rest = tags.filter((tag) => !(IMPORTANCE_TAGS as readonly string[]).includes(tag));
  const tag = level === 3 ? "pinned" : level === 2 ? "important" : level === 0 ? "minor" : null;
  return tag ? [...rest, tag] : rest;
}

/// What a level adds to a memory's score when the messages are matched
/// (memory/rank.ts, term P).
export function importanceBonus(level: number | undefined): number {
  return level === 3 ? 0.06 : level === 2 ? 0.03 : level === 0 ? -0.04 : 0;
}
