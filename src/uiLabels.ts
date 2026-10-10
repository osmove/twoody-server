// The app's screens and buttons as the person sees them, in the language of
// their app (10/10/2026). The model was told « Capacités → Maison »,
// « Capacités › Connecteurs », « Ajouter un dossier » whatever the person's
// language: a German person was sent to screens their app does not show.
// Each label here is the Desktop's own, word for word
// (twoody-desktop/src/renderer/i18n.ts for en and fr,
// src/renderer/locales/<code>.ts for the others; test/uiLabels.test.ts
// compares them when the Desktop's checkout is beside this one).
//
// Only ever put on what rides with a turn — a tool result, a note on the
// last message — never in the system prompt, which must not move with the
// app's language (prefix cache, src/chatContext.ts).

export type UiLanguage = "en" | "fr" | "de" | "es" | "it" | "pt" | "nl" | "ja" | "zh" | "ko";

export interface UiLabels {
  /// nav.capabilities
  capabilities: string;
  /// caps.home.title
  home: string;
  /// caps.connectors.title
  connectors: string;
  /// caps.bank.title
  bank: string;
  /// caps.email.title
  email: string;
  /// nav.documents: the Documents screen
  documents: string;
  /// documents.add: its « add a folder » button
  addFolder: string;
  /// documents.shortcut.downloads / desktop / icloud: its one-click shortcuts
  downloads: string;
  desktop: string;
  icloud: string;
  /// chat.tools.title: the « Outils » button under the message field
  tools: string;
}

export const UI_LABELS: Record<UiLanguage, UiLabels> = {
  en: { capabilities: "Capabilities", home: "Home", connectors: "Connectors", bank: "Bank", email: "E-mails", documents: "Documents", addFolder: "Add a folder", downloads: "Downloads", desktop: "Desktop", icloud: "iCloud Drive", tools: "Tools" },
  fr: { capabilities: "Capacités", home: "Maison", connectors: "Connecteurs", bank: "Banque", email: "E-mails", documents: "Documents", addFolder: "Ajouter un dossier", downloads: "Téléchargements", desktop: "Bureau", icloud: "iCloud Drive", tools: "Outils" },
  de: { capabilities: "Fähigkeiten", home: "Zuhause", connectors: "Connectors", bank: "Bank", email: "E-Mails", documents: "Dokumente", addFolder: "Ordner hinzufügen", downloads: "Downloads", desktop: "Schreibtisch", icloud: "iCloud Drive", tools: "Werkzeuge" },
  es: { capabilities: "Capacidades", home: "Casa", connectors: "Conectores", bank: "Banco", email: "Correos", documents: "Documentos", addFolder: "Añadir una carpeta", downloads: "Descargas", desktop: "Escritorio", icloud: "iCloud Drive", tools: "Herramientas" },
  it: { capabilities: "Capacità", home: "Casa", connectors: "Connettori", bank: "Banca", email: "E-mail", documents: "Documenti", addFolder: "Aggiungi una cartella", downloads: "Download", desktop: "Scrivania", icloud: "iCloud Drive", tools: "Strumenti" },
  pt: { capabilities: "Capacidades", home: "Casa", connectors: "Conectores", bank: "Banco", email: "E-mails", documents: "Documentos", addFolder: "Adicionar uma pasta", downloads: "Downloads", desktop: "Área de Trabalho", icloud: "iCloud Drive", tools: "Ferramentas" },
  nl: { capabilities: "Mogelijkheden", home: "Thuis", connectors: "Koppelingen", bank: "Bank", email: "E-mail", documents: "Documenten", addFolder: "Map toevoegen", downloads: "Downloads", desktop: "Bureaublad", icloud: "iCloud Drive", tools: "Tools" },
  ja: { capabilities: "機能", home: "スマートホーム", connectors: "コネクタ", bank: "銀行", email: "メール", documents: "文書", addFolder: "フォルダを追加", downloads: "ダウンロード", desktop: "デスクトップ", icloud: "iCloud Drive", tools: "ツール" },
  zh: { capabilities: "能力", home: "家居", connectors: "连接器", bank: "银行", email: "电子邮件", documents: "文档", addFolder: "添加文件夹", downloads: "下载", desktop: "桌面", icloud: "iCloud Drive", tools: "工具" },
  ko: { capabilities: "기능", home: "홈", connectors: "커넥터", bank: "은행", email: "이메일", documents: "문서", addFolder: "폴더 추가", downloads: "다운로드", desktop: "데스크탑", icloud: "iCloud Drive", tools: "도구" },
};

/// The app's language for a locale as a client sends it (« de-DE »,
/// « pt-BR », « zh-Hans-CN »); English for none or another one, as the
/// Desktop reads a key it lacks.
export function uiLanguage(locale: string | null | undefined): UiLanguage {
  const primary = (locale ?? "").trim().split(/[-_]/)[0]!.toLowerCase();
  return primary in UI_LABELS ? (primary as UiLanguage) : "en";
}

export function uiLabels(locale: string | null | undefined): UiLabels {
  return UI_LABELS[uiLanguage(locale)];
}

export type CapabilityLabel = "home" | "connectors" | "bank" | "email";

/// Where a capability is set up, as the person's app names it:
/// « Fähigkeiten → Zuhause ».
export function capabilityPlace(locale: string | null | undefined, capability: CapabilityLabel): string {
  const labels = uiLabels(locale);
  return `${labels.capabilities} → ${labels[capability]}`;
}
