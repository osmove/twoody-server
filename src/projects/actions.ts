import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { normaliseName } from "../memory/entities.js";
import { updateProject, PROJECT_STATUSES, type ProjectStatus } from "./projects.js";

// What the chat may do on the person's say (docs/projects-design.md §4, lot
// P4): a reminder, a task, a project's status or due date. Only when they
// ask (the system prompt says so); each one said under the answer, with
// « Annuler » (routes/queries.ts `actions`).

export interface ChatAction {
  /// "home": a device of the person's home switched (home/homeAssistant.ts).
  type: "reminder" | "task" | "project" | "home";
  id: string;
  title: string;
  /// When it is due or will ring (ISO), if it has a time.
  at: string | null;
  project: { id: string; title: string } | null;
  /// For a project: what changed.
  change?: { status?: string; due?: string | null; state?: string; brightness?: number | null };
}

export const ACTION_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "create_reminder",
      description:
        "Create a reminder for the user, that rings at a given time. Only when they ask to be reminded of something. " +
        "Optionally tied to one of their projects, by its name.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind them of, in their words and language." },
          when: { type: "string", description: "Local date and time, YYYY-MM-DDTHH:MM (their time zone). Default to 09:00 when they give only a day." },
          project: { type: "string", description: "The project's name, if it is about one." },
        },
        required: ["text", "when"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_task",
      description: "Add a task to the user's to-do list. Only when they ask to note something to do. Optionally with a due date and a project.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The task, in their words and language." },
          due: { type: "string", description: "Due date YYYY-MM-DD, if they give one." },
          project: { type: "string", description: "The project's name, if it is about one." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_project",
      description: "Change the status or due date of one of the user's projects, when they say it changed (bought, done, paused, dropped, a new date).",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "The project's name." },
          status: { type: "string", enum: [...PROJECT_STATUSES], description: "idea, active, paused, done or dropped." },
          due: { type: "string", description: "New due date YYYY-MM-DD." },
        },
        required: ["project"],
      },
    },
  },
];

export class ActionError extends Error {}

/// The project a name means: its title or one of its entity's names, the
/// same or one inside the other; not a dropped one, never an isolated one
/// (isolation.ts: no other conversation acts on a client file, nor learns
/// its name).
export function resolveProject(userId: string, name: unknown): { id: string; title: string } | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const wanted = normaliseName(name);
  if (!wanted) return null;
  const rows = sqlite.prepare(`SELECT p.id, p.title, e.norm AS entity_norm FROM projects p LEFT JOIN entities e ON e.id = p.entity_id
    WHERE p.user_id = ? AND p.status != 'dropped' AND p.isolated = 0 ORDER BY p.updated_at DESC`).all(userId) as Array<{ id: string; title: string; entity_norm: string | null }>;
  const aliases = (id: string) => (sqlite.prepare("SELECT a.norm FROM projects p JOIN entity_aliases a ON a.entity_id = p.entity_id WHERE p.id = ?").all(id) as Array<{ norm: string }>).map((row) => row.norm);
  for (const row of rows) {
    const names = [normaliseName(row.title), row.entity_norm, ...aliases(row.id)].filter((value): value is string => !!value);
    if (names.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value))) return { id: row.id, title: row.title };
  }
  return null;
}

/// « 2026-10-03T09:00 » in the person's time zone, as an instant.
export function zonedInstant(local: string, timeZone: string | null): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(local.trim());
  if (!match) {
    const parsed = Date.parse(local);
    if (Number.isNaN(parsed)) throw new ActionError("invalid_when");
    return new Date(parsed);
  }
  const [, y, mo, d, h = "09", mi = "00"] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (!timeZone) return new Date(asUtc);
  // The zone's offset at that moment: what its clock says for the UTC instant.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(asUtc))
    .reduce<Record<string, string>>((out, part) => ({ ...out, [part.type]: part.value }), {});
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(asUtc - (shown - asUtc));
}

/// `within`: the isolated project (client file) the conversation is in —
/// what is created there is its own (its deadlines), and no other project is
/// named or changed from it (isolation.ts).
export function runAction(userId: string, name: string, args: Record<string, unknown>, timeZone: string | null, now = new Date(), said = "", within: { id: string; title: string } | null = null): ChatAction {
  const project = within ?? resolveProject(userId, args.project);
  // The day the person named wins over the model's reading of it.
  const day = namedDay(said, timeZone, now);
  if (name === "create_reminder") {
    const text = typeof args.text === "string" ? args.text.trim().slice(0, 500) : "";
    if (!text || (typeof args.when !== "string" && !day)) throw new ActionError("text_and_when_required");
    const time = typeof args.when === "string" ? /(?:T|\s)(\d{2}:\d{2})/.exec(args.when)?.[1] ?? null : null;
    const at = zonedInstant(day ? `${day}T${time ?? "09:00"}` : (args.when as string), timeZone);
    const id = randomUUID();
    const stamp = now.getTime();
    sqlite.prepare(`INSERT INTO reminders (id, user_id, project_id, text, title, notify_at, status, channel, reminder_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 'push', 'once', ?, ?)`).run(id, userId, project?.id ?? null, text, text, at.getTime(), stamp, stamp);
    return { type: "reminder", id, title: text, at: at.toISOString(), project };
  }
  if (name === "create_task") {
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 500) : "";
    if (!title) throw new ActionError("title_required");
    const dueDay = day ?? (typeof args.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(args.due) ? args.due.slice(0, 10) : null);
    const due = dueDay ? zonedInstant(dueDay, timeZone) : null;
    const id = randomUUID();
    const stamp = now.getTime();
    sqlite.prepare("INSERT INTO tasks (id, user_id, title, due_at, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, title, due ? due.getTime() : null, project?.id ?? null, stamp, stamp);
    return { type: "task", id, title, at: due?.toISOString() ?? null, project };
  }
  if (name === "update_project") {
    if (!project || within) throw new ActionError("no_such_project");
    const status = typeof args.status === "string" && (PROJECT_STATUSES as readonly string[]).includes(args.status) ? (args.status as ProjectStatus) : undefined;
    const due = typeof args.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? `${args.due}T12:00:00.000Z` : undefined;
    if (!status && !due) throw new ActionError("nothing_to_change");
    updateProject(userId, project.id, { ...(status ? { status } : {}), ...(due ? { due_at: due } : {}) });
    return { type: "project", id: project.id, title: project.title, at: due ?? null, project, change: { ...(status ? { status } : {}), ...(due ? { due: args.due as string } : {}) } };
  }
  throw new ActionError("unknown_tool");
}

/// A message that asks for a reminder or a task outright: the model is made
/// to call the tool (it said « rappel créé » without one, 2 times in 6 with
/// Qwen3.5 9B, 01/10/2026). In each language of the app (10/10/2026: only
/// French and English were heard, « Erinnere mich morgen um 9… » was left
/// to the model's own choice).
const ASKS_REMINDER = new RegExp([
  String.raw`(?<![\p{L}\p{N}])(?:rappelle[- ]?moi|rappelle[- ]nous|fais[- ]moi penser|n'oublie pas de me rappeler|pense [àa] me rappeler|remind me|reminder to|set a reminder)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:erinnere? (?:mich|uns)|erinnern sie (?:mich|uns)|(?:kannst du|könntest du|konntest du) mich (?:\S+ ){0,6}?erinnern|erinnerung (?:für|an|um)|stell(?:e)? (?:mir )?eine erinnerung)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:recu[ée]rd(?:a|e)me|recu[ée]rdanos|recordarme|(?:me )?(?:puedes|podr[íi]as) recordar|pon(?:me)? un recordatorio|crea un recordatorio)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:ricordami|ricordatemi|ricordarmi|ricordaci|mi (?:puoi|potresti) ricordare|(?:metti|imposta|crea) un promemoria)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:me lembr(?:e|a|ar)|lembr(?:e|a)-me|lembre a gente|(?:cria|crie|coloca|coloque) um lembrete)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:herinner (?:me|mij|ons)|(?:kun je|kan je|kunt u) (?:me|mij) (?:\S+ ){0,6}?herinneren|(?:zet|maak) een herinnering)(?![\p{L}\p{N}])`,
  "リマインド|リマインダー|思い出させて|通知して",
  "提醒我|提醒一下我|提醒下我|设(?:置)?(?:个|一个)?提醒|记得提醒",
  "리마인드|리마인더|알림\\s?(?:을\\s?)?(?:설정|맞춰|해\\s?줘)|(?:라고|하라고|도록)\\s?(?:나한테\\s?|저한테\\s?)?알려\\s?(?:줘|주세요|줄래)",
].join("|"), "iu");
const ASKS_TASK = new RegExp([
  String.raw`(?<![\p{L}\p{N}])(?:note que je dois|note[- ]moi de|ajoute (?:[àa] ma liste|une t[âa]che|dans mes t[âa]ches)|mets? (?:[çc]a )?dans mes t[âa]ches|add (?:a task|to my (?:to-?do|list|tasks)))(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:notier(?:e)? (?:mir|dir),? dass ich|setz(?:e)? (?:\S+ ){0,3}?auf meine (?:liste|to-?do-?liste|aufgabenliste)|neue aufgabe|(?:füg|fug)(?:e)? (?:\S+ ){0,4}?(?:zu meinen aufgaben|zur (?:aufgaben)?liste) hinzu)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:(?:apunta|anota) que tengo que|(?:a[ñn]ade|agrega) (?:una tarea|a mi lista|a mis tareas)|nueva tarea)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:(?:annota|segna) che devo|aggiungi (?:un compito|un'attivit[àa]|alla mia lista|ai miei compiti|alle mie attivit[àa])|nuova attivit[àa])(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:anot(?:a|e) que (?:eu )?(?:preciso|tenho que)|adicion(?:a|e) (?:uma tarefa|[àa] minha lista|nas minhas tarefas)|nova tarefa)(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])(?:noteer dat ik|zet (?:\S+ ){0,3}?op mijn (?:lijst|takenlijst|to-?do-?lijst)|voeg (?:\S+ ){0,4}?toe aan mijn (?:lijst|taken|takenlijst)|nieuwe taak)(?![\p{L}\p{N}])`,
  "タスク(?:に|を)追加|(?:ToDo|TODO|やること)(?:リスト)?に(?:追加|入れて)",
  "添加(?:一个)?任务|加(?:到|进)(?:我的)?(?:待办|任务)|新建任务|加个待办",
  "할\\s?일(?:\\s?목록)?에\\s?추가|작업\\s?추가|투두에\\s?추가",
].join("|"), "iu");

export function askedAction(text: string): "create_reminder" | "create_task" | null {
  const plain = text.normalize("NFC").replace(/[’‘ʼ]/g, "'");
  if (ASKS_REMINDER.test(plain)) return "create_reminder";
  if (ASKS_TASK.test(plain)) return "create_task";
  return null;
}

// The days in each language of the app (10/10/2026: « morgen », « mañana »,
// « 明日 » were not read, and the model's own date was kept — Qwen3.5 9B
// gets « vendredi » wrong). Matched on the text in lower case, NFC.
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const day = (latin: string, cjk: string) => new RegExp(`${B}(?:${latin})${E}|${cjk}`, "u");
const WEEKDAYS: Array<[RegExp, number]> = [
  [day("dimanche|sunday|sonntag|domingo|domenica|zondag", "日曜|星期日|星期天|周日|礼拜天|일요일"), 0],
  [day("lundi|monday|montag|lunes|luned[iì]|segunda(?:-feira| feira)?|maandag", "月曜|星期一|周一|礼拜一|월요일"), 1],
  [day("mardi|tuesday|dienstag|martes|marted[iì]|ter[çc]a(?:-feira| feira)?|dinsdag", "火曜|星期二|周二|礼拜二|화요일"), 2],
  [day("mercredi|wednesday|mittwoch|mi[ée]rcoles|mercoled[iì]|quarta(?:-feira| feira)|woensdag", "水曜|星期三|周三|礼拜三|수요일"), 3],
  [day("jeudi|thursday|donnerstag|jueves|gioved[iì]|quinta(?:-feira| feira)|donderdag", "木曜|星期四|周四|礼拜四|목요일"), 4],
  [day("vendredi|friday|freitag|viernes|venerd[iì]|sexta(?:-feira| feira)?|vrijdag", "金曜|星期五|周五|礼拜五|금요일"), 5],
  [day("samedi|saturday|samstag|sonnabend|s[áa]bado|sabato|zaterdag", "土曜|星期六|周六|礼拜六|토요일"), 6],
];
const DATE_GIVEN = new RegExp([
  String.raw`\b\d{1,2}(?:er)?\s+(?:janv|f[ée]vr|mars|avr|mai|juin|juil|ao[ûu]t|sept|oct|nov|d[ée]c)`,
  String.raw`\b\d{1,2}\/\d{1,2}\b`,
  String.raw`\b\d{1,2}\.\s?(?:\d{1,2}\.|jan|feb|f[äa]b|m[äa]r|apr|mai|jun|jul|aug|sep|okt|nov|dez)`,
  String.raw`\b\d{1,2}\s+(?:de\s+)?(?:ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|out|nov|dic|dez|gen|mag|giu|lug|ott|jan|fev|mrt|mei|okt|dec)`,
  String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b`,
  String.raw`\d{1,2}\s?月\s?\d{1,2}\s?[日号]|\d{1,2}\s?월\s?\d{1,2}\s?일`,
].join("|"), "u");
const NEXT_WEEK = /\b(?:semaine prochaine|next week|n[äa]chste woche|semana que viene|pr[óo]xima semana|semana que vem|prossima settimana|settimana prossima|volgende week)\b|来週|下周|下星期|下礼拜|다음\s?주/u;
const DAY_AFTER = new RegExp(`${B}(?:apr[èe]s[- ]demain|day after tomorrow|[üu]bermorgen|pasado ma[ñn]ana|dopodomani|depois de amanh[ãa]|overmorgen)${E}|明後日|あさって|后天|後天|모레`, "u");
// « heute Morgen », « esta mañana »: this morning, not tomorrow.
const TOMORROW = new RegExp(`${B}(?:demain|tomorrow|(?<!heute |guten |am |jeden |diesen )morgen|(?<!esta |la |por la |de la |cada )ma[ñn]ana|morgen(?:ochtend|middag|avond)|domani|amanh[ãa])${E}|明日|あした|あす|明天|내일`, "u");
const TODAY = new RegExp(`${B}(?:aujourd'hui|ce soir|cet apr[èe]s[- ]midi|today|tonight|heute|heute (?:abend|morgen|nachmittag)|hoy|esta (?:noche|tarde|ma[ñn]ana)|oggi|stasera|stamattina|hoje|esta noite|hoje [àa] noite|vandaag|vanavond|vanmiddag)${E}|今日|きょう|今夜|今晩|今天|今晚|今夜|오늘`, "u");

/// The day the person named — « demain », « après-demain », « vendredi »
/// (the next one), and the same in each language of the app — as
/// YYYY-MM-DD in their zone; null when they named none or gave a date of
/// their own (« le 12 »), which the model reads.
export function namedDay(text: string, timeZone: string | null, now = new Date()): string | null {
  const plain = text.normalize("NFC").replace(/[’‘ʼ]/g, "'").toLowerCase();
  if (DATE_GIVEN.test(plain)) return null;
  const local = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const weekdayOf = (at: Date) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? undefined, weekday: "short" }).format(at));
  const plus = (days: number) => local(new Date(now.getTime() + days * 86_400_000));
  if (DAY_AFTER.test(plain)) return plus(2);
  if (TOMORROW.test(plain)) return plus(1);
  if (TODAY.test(plain)) return plus(0);
  for (const [pattern, weekday] of WEEKDAYS) {
    if (!pattern.test(plain)) continue;
    const today = weekdayOf(now);
    let ahead = (weekday - today + 7) % 7;
    if (ahead === 0) ahead = 7;
    // « 下周五 », « vendredi de la semaine prochaine »: that day of the week
    // that starts next Monday — on a Saturday, six days ahead, not thirteen.
    if (NEXT_WEEK.test(plain)) ahead = ((8 - today) % 7 || 7) + ((weekday + 6) % 7);
    return plus(ahead);
  }
  return null;
}
