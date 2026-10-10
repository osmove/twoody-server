// The days and periods a message names, in the ten languages of the app
// (en, fr, de, es, it, pt, nl, ja, zh, ko) — shared by the agenda and
// contacts joined to a message (personalContext.ts dateWindow) and the
// e-mails' periods (email/chat.ts periodIn, periodSpanIn). 10/10/2026: both
// heard French and English only, and « Was habe ich am Freitag? », « ¿Me
// escribió Paul esta semana? », « 金曜日の予定は？ » got no day at all.
//
// Every pattern is matched on fold()ed text (intentText.ts): Latin accents
// removed, lower case, kana and hangul whole, full-width digits plain. The
// Latin ones are bounded by letters (B, E); Japanese, Chinese and Korean
// have no spaces between words and are matched anywhere.

export const B = String.raw`(?<![\p{L}\p{N}])`;
export const E = String.raw`(?![\p{L}\p{N}])`;

/// One pattern from a Latin part (bounded) and a CJK part (anywhere).
export function words(latin: string, cjk = ""): RegExp {
  return new RegExp([latin ? `${B}(?:${latin})${E}` : "", cjk].filter(Boolean).join("|"), "u");
}

/// Days after or before today, by name. Order matters where one holds
/// another: « après-demain » before « demain », « esta mañana » (this
/// morning) before « mañana » (tomorrow), « heute Morgen » before « morgen ».
export const DAY_AFTER_TOMORROW = words(
  String.raw`apres[- ]demain|day after tomorrow|ubermorgen|pasado manana|dopodomani|depois de amanha|overmorgen`,
  "明後日|あさって|后天|後天|모레",
);
export const DAY_BEFORE_YESTERDAY = words(
  String.raw`avant[- ]hier|day before yesterday|vorgestern|anteayer|antier|antes de ayer|l'altro ieri|l'altroieri|altroieri|ieri l'altro|anteontem|eergisteren`,
  "一昨日|おととい|おとつい|前天|그저께|그제",
);
export const TODAY = words(
  String.raw`aujourd'? ?hui|ce soir|ce matin|cet apres[- ]midi|today|tonight|this (?:morning|afternoon|evening)|heute(?: (?:morgen|abend|nachmittag|fruh))?|hoy|esta (?:noche|tarde|manana)|oggi|stasera|stamattina|stamani|stanotte|questo pomeriggio|questa sera|hoje|esta noite|vandaag|vanavond|vanmiddag|vanochtend|vanmorgen`,
  "今日|きょう|今夜|今晩|今朝|本日|今天|今晚|今早|오늘",
);
// « morgen »: tomorrow in German and Dutch, but « am Morgen », « guten
// Morgen », « de morgen » are the morning; « mañana »: tomorrow, but « la
// mañana », « por la mañana » are the morning.
export const TOMORROW = words(
  String.raw`demain|tomorrow|(?<!(?:guten|am|jeden|diesen|den|der|des|de|deze|elke|goede|'s|in de|van) )morgen(?:ochtend|middag|avond)?|(?<!(?:esta|la|por la|de la|cada|esa|una|toda la) )manana|domani|amanha`,
  "明日|あした|明天|내일",
);
/// « hier » is yesterday in French but « here » in German and Dutch: not
/// counted in a message with their words (« Was gibt es hier? »). The same
/// words tell German « Termine » from French « terminé ».
const HIER = String.raw`hier`;
export const GERMANIC = new RegExp(`${B}(?:ich|ist|das|der|die|und|nicht|habe|hast|haben|bin|wir|sind|mein|meine|was|gibt|wo|wie|du|kannst|ik|het|een|wat|niet|heb|hebt|zijn|ben|wij|mijn|jullie|er|is|ligt|staat|zit)${E}`, "u");
export const YESTERDAY = words(String.raw`yesterday|gestern|ayer|ieri|ontem|gisteren`, "昨日|きのう|昨天|어제");
export function namesYesterday(text: string): boolean {
  return YESTERDAY.test(text) || (new RegExp(`${B}${HIER}${E}`, "u").test(text) && !GERMANIC.test(text));
}
export const YESTERDAY_ANY = new RegExp(`${YESTERDAY.source}|${B}${HIER}${E}`, "u");

export const THIS_WEEK = words(
  String.raw`cette semaine|this week|diese(?:r|n)? woche|esta semana|nesta semana|essa semana|questa settimana|deze week`,
  "今週|这周|這周|这个星期|這個星期|这星期|这礼拜|本周|本週|이번\\s?주",
);
export const NEXT_WEEK = words(
  String.raw`(?:la )?semaine prochaine|next week|nachste(?:n)? woche|kommende(?:n)? woche|(?:la )?semana que viene|(?:la )?proxima semana|semana que vem|(?:la )?prossima settimana|settimana prossima|volgende week|komende week`,
  "来週|らいしゅう|下周|下週|下星期|下个星期|下個星期|下礼拜|다음\\s?주",
);
export const LAST_WEEK = words(
  String.raw`(?:la )?semaine (?:derniere|passee)|last week|past week|letzte(?:n)? woche|vergangene(?:n)? woche|vorige(?:n)? woche|(?:la )?semana pasada|(?:la )?settimana (?:scorsa|passata)|(?:la )?scorsa settimana|(?:a )?semana passada|vorige week|afgelopen week|verleden week`,
  "先週|せんしゅう|上周|上週|上星期|上个星期|上個星期|上礼拜|지난\\s?주",
);
export const NEXT_WEEKEND = words(
  String.raw`next weekend|(?:le )?week-? ?end prochain|nachste(?:s|n)? wochenende|(?:el )?proximo fin de semana|(?:el )?fin de semana que viene|(?:il )?prossimo (?:fine settimana|weekend)|(?:o )?proximo fim de semana|volgend weekend|komend weekend`,
  "来週末|下周末|下週末|下个周末|下個週末|다음\\s?주말",
);
export const WEEKEND = words(
  String.raw`(?:ce |le )?week-? ?end|fin de semana|finde|fine settimana|fim de semana|wochenende`,
  "週末|周末|주말",
);
export const THIS_MONTH = words(
  String.raw`ce mois(?:-ci)?|this month|diese(?:n|m|r)? monat|este mes|neste mes|esse mes|questo mese|deze maand`,
  "今月|这个月|這個月|本月|이번\\s?달",
);
export const NEXT_MONTH = words(
  String.raw`(?:le )?mois prochain|next month|nachste(?:n|r)? monat|kommende(?:n)? monat|(?:el )?mes que viene|(?:el )?proximo mes|(?:o )?mes que vem|(?:il )?mese prossimo|(?:il )?prossimo mese|volgende maand|komende maand`,
  "来月|らいげつ|下个月|下個月|다음\\s?달",
);
export const LAST_MONTH = words(
  String.raw`(?:le )?mois (?:dernier|passe)|last month|past month|letzte(?:n|r)? monat|vergangene(?:n)? monat|vorige(?:n)? monat|(?:el )?mes pasado|(?:il )?mese (?:scorso|passato)|(?:lo )?scorso mese|(?:o )?mes passado|vorige maand|afgelopen maand`,
  "先月|せんげつ|上个月|上個月|上月|지난\\s?달",
);
/// For e-mails: « ces derniers jours », « in den letzten Tagen », « 这几天 ».
export const LAST_FEW_DAYS = words(
  String.raw`(?:ces )?derniers jours|(?:last|past) (?:few )?days|(?:in den )?letzten tagen?|die letzten tage|(?:en )?los ultimos dias|estos dias|(?:negli )?ultimi giorni|(?:nos )?ultimos dias|(?:de )?afgelopen dagen|(?:de )?laatste dagen`,
  "ここ数日|この数日|最近几天|这几天|這幾天|최근\\s?며칠|요\\s?며칠|지난\\s?며칠",
);
export const LAST_FEW_WEEKS = words(
  String.raw`(?:ces )?dernieres semaines|(?:last|past) (?:few )?weeks|depuis un mois|(?:in den )?letzten wochen|(?:en )?las ultimas semanas|(?:nelle )?ultime settimane|(?:nas )?ultimas semanas|(?:de )?afgelopen weken|(?:de )?laatste weken`,
  "ここ数週間|この数週間|最近几周|最近几个星期|这几周|최근\\s?몇\\s?주|지난\\s?몇\\s?주",
);
export const LAST_FEW_MONTHS = words(
  String.raw`(?:ces )?derniers mois|(?:last|past) (?:few |three |3 )?months|(?:in den )?letzten monaten|(?:en )?los ultimos meses|(?:negli )?ultimi mesi|(?:nos )?ultimos meses|(?:de )?afgelopen maanden|(?:de )?laatste maanden`,
  "ここ数ヶ月|ここ数か月|ここ数カ月|最近几个月|这几个月|這幾個月|최근\\s?몇\\s?(?:달|개월)|지난\\s?몇\\s?(?:달|개월)",
);

/// Weekdays, Monday first (localParts' numbering). Portuguese « segunda »,
/// « quinta », « sexta » are also « second », « fifth », « sixth »: the day
/// only with « -feira » or a word that names a day before it (« na sexta »).
const PT_DAY = (name: string) => String.raw`${name}(?:-feira| feira)|(?<=(?:na|nesta|esta|nessa|essa|proxima|ultima|de|desde|ate|toda|cada|numa) )${name}|${name}(?= (?:passada|que vem))`;
export const WEEKDAY_LATIN = [
  `lundi|monday|montag|lunes|lunedi|${PT_DAY("segunda")}|maandag`,
  `mardi|tuesday|dienstag|martes|martedi|${PT_DAY("terca")}|dinsdag`,
  `mercredi|wednesday|mittwoch|miercoles|mercoledi|${PT_DAY("quarta")}|woensdag`,
  `jeudi|thursday|donnerstag|jueves|giovedi|${PT_DAY("quinta")}|donderdag`,
  `vendredi|friday|freitag|viernes|venerdi|${PT_DAY("sexta")}|vrijdag`,
  "samedi|saturday|samstag|sonnabend|sabado|sabato|zaterdag",
  "dimanche|sunday|sonntag|domingo|domenica|zondag",
];
export const WEEKDAY_CJK = [
  "月曜|星期一|周一|週一|礼拜一|禮拜一|월요일",
  "火曜|星期二|周二|週二|礼拜二|禮拜二|화요일",
  "水曜|星期三|周三|週三|礼拜三|禮拜三|수요일",
  "木曜|星期四|周四|週四|礼拜四|禮拜四|목요일",
  "金曜|星期五|周五|週五|礼拜五|禮拜五|금요일",
  "土曜|星期六|周六|週六|礼拜六|禮拜六|토요일",
  "日曜|星期日|星期天|周日|週日|礼拜天|禮拜天|礼拜日|일요일",
];
/// A weekday, its index in group 2 (the Latin name, plural or « -s »
/// adverb allowed: « mondays », « freitags ») or found by WEEKDAY_CJK.
export function weekdayPattern(index: number): RegExp {
  return new RegExp(`${B}(?:${WEEKDAY_LATIN[index]})s?${E}|${WEEKDAY_CJK[index]}`, "gu");
}

/// Words that make a weekday the next or the last one, before or after it
/// (« next Friday », « vendredi prochain », « el viernes pasado », « vorige
/// vrijdag »), on the few words around it.
export const NEXT_BEFORE = new RegExp(`${B}(?:next|this coming|nachste(?:n|r)?|kommende(?:n|r)?|(?:el )?proximo|(?:la )?proxima|(?:il )?prossimo|(?:la )?prossima|volgende|komende)\\s+(?:am\\s+|el\\s+)?$`, "u");
export const NEXT_AFTER = new RegExp(`^\\s*(?:prochain(?:e)?|que viene|que vem|prossim[oa]|next)${E}`, "u");
export const LAST_BEFORE = new RegExp(`${B}(?:last|past|letzte(?:n|r)?|vergangene(?:n|r)?|vorige(?:n|r)?|(?:el )?pasado|(?:l')?ultim[oa]|(?:lo |la )?scors[oa]|afgelopen|jongstleden)\\s+(?:am\\s+|el\\s+)?$`, "u");
export const LAST_AFTER = new RegExp(`^\\s*(?:dernier|passee?|pasado|scors[oa]|passat[oa]|passad[oa]|jongstleden|j\\.?l\\.?)${E}`, "u");

/// Months by name and the usual short forms — not the ones that are also
/// common words (« set », « out », « ago », « gen », « mag »).
export const MONTHS: Array<[number, string[]]> = [
  [1, ["janvier", "janv", "january", "jan", "januar", "janner", "enero", "ene", "gennaio", "janeiro", "januari"]],
  [2, ["fevrier", "fevr", "fev", "february", "feb", "februar", "febrero", "febbraio", "fevereiro", "februari"]],
  [3, ["mars", "march", "mar", "marz", "mrz", "marzo", "marco", "maart", "mrt"]],
  [4, ["avril", "avr", "april", "apr", "abril", "abr", "aprile"]],
  [5, ["mai", "may", "mayo", "maggio", "maio", "mei"]],
  [6, ["juin", "june", "jun", "juni", "junio", "giugno", "giu", "junho"]],
  [7, ["juillet", "juil", "july", "jul", "juli", "julio", "luglio", "lug", "julho"]],
  [8, ["aout", "august", "aug", "agosto", "augustus"]],
  [9, ["septembre", "sept", "sep", "september", "septiembre", "setiembre", "settembre", "sett", "setembro"]],
  [10, ["octobre", "oct", "october", "oktober", "okt", "octubre", "ottobre", "ott", "outubro"]],
  [11, ["novembre", "nov", "november", "noviembre", "novembro"]],
  [12, ["decembre", "dec", "december", "dezember", "dez", "diciembre", "dic", "dicembre", "dezembro"]],
];
export const MONTH_OF = new Map<string, number>(MONTHS.flatMap(([month, names]) => names.map((name) => [name, month] as [string, number])));
export const MONTH_WORDS = [...MONTH_OF.keys()].sort((a, b) => b.length - a.length).join("|");

/// « since Monday », « depuis hier », « seit Montag », « desde ayer », « 月曜から »:
/// the day the span starts — a weekday's index (0 Monday), or "yesterday",
/// "today"; null when the message says no such thing.
export function sinceDay(text: string): number | "yesterday" | "today" | "day_before_yesterday" | null {
  const latinSince = String.raw`depuis|since|seit|desde|da|dal|sinds`;
  const cjkAfter = "から|以来|开始|開始|到现在|부터|이후";
  const said = (latin: string, cjk: string) =>
    new RegExp(`${B}(?:${latinSince})\\s+(?:(?:el|le|il|lo|o|a)\\s+)?(?:${latin})${E}|(?:从|從|自从|自從)?(?:${cjk})(?:の?\\s?(?:${cjkAfter}))`, "u").test(text) ||
    (cjk !== "" && new RegExp(`(?:从|從|自从|自從)(?:${cjk})`, "u").test(text));
  if (said(DAY_BEFORE_YESTERDAY_LATIN, "一昨日|おととい|前天|그저께|그제")) return "day_before_yesterday";
  if (said(`yesterday|hier|gestern|ayer|ieri|ontem|gisteren`, "昨日|きのう|昨天|어제")) return "yesterday";
  if (said(`this morning|ce matin|heute morgen|heute fruh|esta manana|stamattina|esta manha|vanochtend|vanmorgen`, "今朝|今天早上|오늘\\s?아침")) return "today";
  for (let index = 0; index < 7; index += 1) {
    if (said(WEEKDAY_LATIN[index]!, `(?:${WEEKDAY_CJK[index]})日?`)) return index;
  }
  return null;
}
const DAY_BEFORE_YESTERDAY_LATIN = String.raw`avant[- ]hier|the day before yesterday|vorgestern|anteayer|l'altro ieri|anteontem|eergisteren`;
