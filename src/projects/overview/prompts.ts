// What the model is asked for a project's overview, and how its answers are
// read (docs/project-overview-design.md §3). Two kinds of call, both on this
// computer's model, without tools nor reasoning:
//   - a document (or a piece of one) → its points, each with the document's
//     own words (`kind | point | quote`), checked by the server (quotes.ts);
//   - a section → its lines from the points of every document, each ending
//     with the points it rests on (`- line [i3, i12]`), checked by the server.

export const SECTIONS = ["brief", "decisions", "status", "next_steps", "open_questions"] as const;
export type SectionKind = (typeof SECTIONS)[number];

const SECTION_ASK: Record<SectionKind, { title: string; about: string; point: string }> = {
  brief: { title: "What the brief asks for", about: "goals, requirements, constraints, target audience, budget, deadlines set by the client or the brief", point: "what the brief or the client asks for: a goal, a requirement, a constraint, the audience, the budget, a deadline" },
  decisions: { title: "Decisions", about: "what was decided or chosen, when and by whom when it is said", point: "something decided, chosen, approved or rejected (by whom and when, when it says so)" },
  status: { title: "Where the project stands", about: "what is done, delivered, under way or waiting, as of the newest documents", point: "where the project stands: something done, delivered, sent, under way or waiting" },
  next_steps: { title: "Next steps", about: "what is to be done next, by whom and by when when it is said", point: "something to be done next (by whom and when, when it says so)" },
  open_questions: { title: "Open questions", about: "what is still to be clarified, checked or decided", point: "a question still open: something to clarify, check or decide" },
};

/// How a point's kind is written in the document's lines.
const POINT_KIND: Record<SectionKind, string> = { brief: "brief", decisions: "decision", status: "status", next_steps: "next_step", open_questions: "open_question" };

const ITEM_KINDS: Record<string, SectionKind> = {
  brief: "brief", requirement: "brief", requirements: "brief", goal: "brief", constraint: "brief",
  decision: "decisions", decisions: "decisions", decided: "decisions",
  status: "status", state: "status", progress: "status",
  next_step: "next_steps", next_steps: "next_steps", nextstep: "next_steps", todo: "next_steps", action: "next_steps",
  open_question: "open_questions", open_questions: "open_questions", question: "open_questions", openquestion: "open_questions",
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Brazilian Portuguese", nl: "Dutch", ja: "Japanese", zh: "Simplified Chinese", ko: "Korean",
};

/// « de-DE », « pt-BR », « zh-Hans » → the overview's language code; English
/// for anything else.
export function overviewLanguage(locale: unknown): string {
  const code = typeof locale === "string" ? locale.toLowerCase().slice(0, 2) : "";
  return code in LANGUAGE_NAMES ? code : "en";
}

export const MAX_POINTS_PER_PIECE = 15;

/// What one document (or one piece of it) is asked.
export function documentPrompt(args: { project: string; brief: string | null; language: string; name: string; date: string | null; piece: number; pieces: number; text: string }): Array<{ role: "system" | "user"; content: string }> {
  const language = LANGUAGE_NAMES[args.language] ?? "English";
  const kinds = SECTIONS.map((kind) => `${POINT_KIND[kind]} — ${SECTION_ASK[kind].point}`).join("\n");
  const system = [
    `You read one document of the project « ${args.project} » and note what it says about the project, for the project's overview.`,
    args.brief ? `About the project: ${args.brief.replace(/\s+/g, " ").slice(0, 400)}` : null,
    "Write one line per point, and nothing else:",
    `kind | the point, one short sentence in ${language} | the document's own words it rests on, copied exactly as they are written (at most 25 words)`,
    "kind is one of:",
    kinds,
    `Only what this document says — never a guess, never what is usual. Dates, names and figures as the document gives them. At most ${MAX_POINTS_PER_PIECE} lines, the most important first. When the document says nothing of the kinds above, write only: none`,
  ].filter(Boolean).join("\n");
  const head = `Document: « ${args.name} »${args.date ? ` (dated ${args.date})` : ""}${args.pieces > 1 ? ` — part ${args.piece} of ${args.pieces}` : ""}`;
  return [
    { role: "system", content: system },
    { role: "user", content: `${head}\n\n${args.text}` },
  ];
}

export interface RawPoint {
  kind: SectionKind;
  text: string;
  quote: string;
}

/// The model's lines for a document: `kind | point | quote`. A line without
/// a known kind, a point or a quote is left out; so is a point repeated.
export function readPoints(answer: string): RawPoint[] {
  const out: RawPoint[] = [];
  const seen = new Set<string>();
  for (const raw of answer.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").split("\n")) {
    const line = raw.trim().replace(/^[-*•\d.)\s]+(?=[a-z_ ]+\s*\|)/i, "");
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const kind = ITEM_KINDS[parts[0]!.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z_]/g, "")];
    const text = parts.slice(1, -1).join("|").trim().replace(/^["“„«]+|["”“»]+$/g, "").trim();
    const quote = parts[parts.length - 1]!.trim().replace(/^["“„«‚‘]+|["”“»‘’]+$/g, "").trim();
    if (!kind || !text || !quote || text.length > 500 || quote.length > 600) continue;
    const key = `${kind}\u0000${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, text, quote });
  }
  return out;
}

export interface SectionPoint {
  /// Its id in the prompt (« i12 »).
  ref: string;
  date: string | null;
  document: string;
  text: string;
}

/// What a section is asked: its points (newest document first), and the
/// section as it stands when it is brought up to date.
export function sectionPrompt(args: { project: string; language: string; kind: SectionKind; points: SectionPoint[]; current?: Array<{ text: string; refs: string[] }> }): Array<{ role: "system" | "user"; content: string }> {
  const language = LANGUAGE_NAMES[args.language] ?? "English";
  const ask = SECTION_ASK[args.kind];
  const system = [
    `You write one section of the overview of the project « ${args.project} »: « ${ask.title} » — ${ask.about}.`,
    "You are given the points read in the project's documents, newest document first, each with its id, the document's date and its name.",
    `Write the section in ${language}: one line per point, each starting with "- ", at most 12 lines, the most important first.`,
    "End each line with the ids of the points it rests on, in square brackets, like [i3, i12].",
    "Merge the points that say the same thing into one line, with all their ids. When a newer document changes what an older one said, keep what the newer one says, and say in a few words what it replaced, with the ids of both.",
    args.kind === "status" ? "Say as of when, with the date of the newest document that says it." : null,
    "Use only these points: add nothing they do not say, no advice, no conclusion. Write only the lines.",
    args.current?.length
      ? "The section as it stands is given too. Keep each of its lines word for word when the points still say it (with their ids); change only what new or changed points change; leave out a line none of the points say any more."
      : null,
  ].filter(Boolean).join("\n");
  const points = args.points.map((point) => `[${point.ref}] (${point.date ?? "undated"}, ${point.document}) ${point.text}`).join("\n");
  const current = args.current?.length ? `\n\nThe section as it stands:\n${args.current.map((line) => `- ${line.text}${line.refs.length ? ` [${line.refs.join(", ")}]` : ""}`).join("\n")}` : "";
  return [
    { role: "system", content: system },
    { role: "user", content: `Points:\n${points}${current}` },
  ];
}

export const MAX_LINES = 12;

/// The model's lines for a section: `- line [i3, i12]`. A line whose ids
/// name none of the points given is left out: a line stands on the
/// documents or is not written.
export function readLines(answer: string, known: ReadonlySet<string>): Array<{ text: string; refs: string[] }> {
  const out: Array<{ text: string; refs: string[] }> = [];
  const seen = new Set<string>();
  for (const raw of answer.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^(?:[-*•]|\d+[.)])\s*/, "");
    const refs: string[] = [];
    // The ids at the end, in one or several brackets: [i3, i12] [i4] (i5).
    const tail = /\s*[[(]\s*((?:i\d+\s*[,;/]?\s*)+)[\])]\s*[.。]?\s*$/i;
    let match = tail.exec(line);
    while (match) {
      refs.unshift(...(match[1]!.match(/i\d+/gi) ?? []).map((ref) => ref.toLowerCase()));
      line = line.slice(0, match.index).trimEnd();
      match = tail.exec(line);
    }
    // Ids written inside the line (« … [i3] and … [i4] »): taken and removed.
    line = line.replace(/\s*\[\s*((?:i\d+\s*[,;]?\s*)+)\]/gi, (_all, ids: string) => {
      for (const ref of ids.match(/i\d+/gi) ?? []) refs.push(ref.toLowerCase());
      return "";
    }).trim();
    const valid = [...new Set(refs.filter((ref) => known.has(ref)))];
    if (!line || !valid.length || /^none\.?$/i.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: line, refs: valid });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}
