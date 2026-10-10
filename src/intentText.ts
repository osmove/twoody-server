// Shared by the detectors that read what a message asks for at once —
// home commands, reminders, file listings, retries — in the ten languages
// of the app (en, fr, de, es, it, pt, nl, ja, zh, ko; 10/10/2026: they
// understood French and English only, and a German « Mach das Licht im
// Wohnzimmer an » was left to a model that wrote « Erledigt » without
// switching anything).

/// Accents of the Latin script removed, lower case, straight apostrophes,
/// full-width forms made plain (« ３０％ », « ？ »). Kana and hangul are
/// recomposed (NFKC), never stripped: « デスクトップ » stays itself, where
/// removing every combining mark made it « テスクトッフ » and decomposed
/// hangul into jamo that no pattern matched.
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFKC").toLowerCase().replace(/[’‘ʼ]/g, "'");
}

/// Japanese, Chinese and Korean: no space between words, so no \b either —
/// their patterns are matched anywhere.
export const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
export const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g;

/// A message about remembering, a reminder or a note: « rappelle-moi
/// d'éteindre la lumière », « erinnere mich, das Licht auszuschalten »,
/// « 电灯关了提醒我 » is no home command. Matched on fold()ed text.
export const ABOUT_REMINDING = new RegExp([
  String.raw`\b(?:rappel|remind|oublie|note|erinner|notier|merk dir|recuerd|recordar|recordatorio|apunta|anota|ricord|promemoria|annota|segna|lembr|anote|herinner|noteer|onthoud|vergeet)`,
  "リマインド|思い出させ|忘れ(?:ない|ず)|覚えて|メモ|提醒|记住|别忘|記住|알려\\s?줘|리마인드|기억|잊지|메모",
].join("|"));
