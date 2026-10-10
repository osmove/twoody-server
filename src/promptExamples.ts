// The examples the system prompt quotes — what a request for a reminder, a
// task, an e-mail period or a message to pass on sounds like, and a folder
// to list — in the language the conversation was frozen with (10/10/2026:
// they were French whatever the app's language, and a Japanese or Chinese
// answer copied the French words of an example given with the message).
//
// Only from ContextState.locale, which a conversation keeps from its first
// turn: the system prompt stays the same for the whole conversation and
// for every conversation in that language, as the runtime's cache needs it
// (chatContext.ts, AGENTS.md §7). No language given: French, the sentences
// as they were, so a French conversation's prompt did not change.

export interface PromptExamples {
  /// « rappelle-moi… », « note que je dois… », « c'est acheté »
  actions: string[];
  /// « cette semaine », « last month »
  periods: string[];
  /// « dis à X que… »
  passOn: string;
  /// A sub-folder of Documents, a path and a folder's name, as list_files
  /// takes them: « Documents/Factures », « jimmy/Desktop/Projets », « Factures ».
  invoicesPath: string;
  projectsPath: string;
  invoices: string;
}

const EXAMPLES: Record<string, PromptExamples> = {
  fr: {
    actions: ["rappelle-moi…", "note que je dois…", "c'est acheté"],
    periods: ["cette semaine", "last month"],
    passOn: "dis à X que…",
    invoicesPath: "Documents/Factures",
    projectsPath: "jimmy/Desktop/Projets",
    invoices: "Factures",
  },
  en: {
    actions: ["remind me…", "note that I have to…", "it's bought"],
    periods: ["this week", "last month"],
    passOn: "tell X that…",
    invoicesPath: "Documents/Invoices",
    projectsPath: "jimmy/Desktop/Projects",
    invoices: "Invoices",
  },
  de: {
    actions: ["erinnere mich…", "notiere mir, dass ich…", "ist gekauft"],
    periods: ["diese Woche", "letzten Monat"],
    passOn: "sag X, dass…",
    invoicesPath: "Dokumente/Rechnungen",
    projectsPath: "jimmy/Desktop/Projekte",
    invoices: "Rechnungen",
  },
  es: {
    actions: ["recuérdame…", "apunta que tengo que…", "ya está comprado"],
    periods: ["esta semana", "el mes pasado"],
    passOn: "dile a X que…",
    invoicesPath: "Documentos/Facturas",
    projectsPath: "jimmy/Desktop/Proyectos",
    invoices: "Facturas",
  },
  it: {
    actions: ["ricordami…", "annota che devo…", "l'ho comprato"],
    periods: ["questa settimana", "il mese scorso"],
    passOn: "di' a X che…",
    invoicesPath: "Documenti/Fatture",
    projectsPath: "jimmy/Desktop/Progetti",
    invoices: "Fatture",
  },
  pt: {
    actions: ["me lembre…", "anote que eu preciso…", "já comprei"],
    periods: ["esta semana", "o mês passado"],
    passOn: "diga a X que…",
    invoicesPath: "Documentos/Notas fiscais",
    projectsPath: "jimmy/Desktop/Projetos",
    invoices: "Notas fiscais",
  },
  nl: {
    actions: ["herinner me…", "noteer dat ik moet…", "het is gekocht"],
    periods: ["deze week", "vorige maand"],
    passOn: "zeg tegen X dat…",
    invoicesPath: "Documenten/Facturen",
    projectsPath: "jimmy/Desktop/Projecten",
    invoices: "Facturen",
  },
  ja: {
    actions: ["…をリマインドして", "…をやることに追加して", "もう買った"],
    periods: ["今週", "先月"],
    passOn: "Xに…と伝えて",
    invoicesPath: "書類/請求書",
    projectsPath: "jimmy/Desktop/プロジェクト",
    invoices: "請求書",
  },
  zh: {
    actions: ["提醒我…", "添加任务…", "已经买了"],
    periods: ["这周", "上个月"],
    passOn: "告诉X…",
    invoicesPath: "文稿/发票",
    projectsPath: "jimmy/Desktop/项目",
    invoices: "发票",
  },
  ko: {
    actions: ["…리마인드해 줘", "할 일에 추가해 줘", "샀어"],
    periods: ["이번 주", "지난달"],
    passOn: "X한테 …라고 전해 줘",
    invoicesPath: "문서/청구서",
    projectsPath: "jimmy/Desktop/프로젝트",
    invoices: "청구서",
  },
};

/// The examples for a conversation's locale (« de-DE », « pt-BR », « zh-Hans »):
/// French when none is given, English for a language the app does not speak.
export function promptExamples(locale: string | null | undefined): PromptExamples {
  if (!locale) return EXAMPLES.fr!;
  return EXAMPLES[locale.split(/[-_]/)[0]!.toLowerCase()] ?? EXAMPLES.en!;
}

/// « « a », « b », « c » »: as the system prompt quotes them.
export function quoted(examples: string[]): string {
  return examples.map((example) => `« ${example} »`).join(", ");
}
