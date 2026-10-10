// German, Spanish, Italian, Portuguese and Dutch in the documents' keyword
// search (10/10/2026). Its stopwords and its crude stems were French and
// English only: « Wie lang ist die Kündigungsfrist? » searched « wie », « ist »
// and « die » as much as the notice period, and « Rechnungen », « fatture »
// or « facturen » never met « Rechnung », « fattura » or « factuur ».
//
// A question is taken for one of these languages when more of its words are
// that language's small words than French or English ones (two at least);
// its small words are then left out too, and each word is reduced to the
// part its singular and plural share, searched as a prefix — « rechnung* »,
// « fattur* », « factu* ». A French or English question never comes here:
// its search is exactly what it was (query.ts).
//
// Words are seen as the tokenizer sees them: lower case, accents removed
// (« für » → « fur », « ação » → « acao »).

export type SearchLanguage = "de" | "es" | "it" | "pt" | "nl";

const SMALL_WORDS: Record<SearchLanguage, Set<string>> = {
  de: new Set([
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einem", "einen", "eines", "und", "oder", "aber", "ist", "sind", "war", "waren",
    "wird", "werden", "wurde", "hat", "haben", "habe", "hatte", "ich", "du", "er", "sie", "es", "wir", "ihr", "mein", "meine", "meinen", "meinem", "meiner",
    "dein", "deine", "sein", "seine", "ihre", "ihren", "unser", "unsere", "mit", "von", "vom", "zu", "zum", "zur", "im", "in", "an", "am", "auf", "aus", "bei",
    "fur", "uber", "unter", "nach", "vor", "bis", "wie", "was", "wer", "wo", "wann", "warum", "welche", "welcher", "welches", "wieviel", "viel", "viele",
    "nicht", "kein", "keine", "auch", "noch", "nur", "so", "dass", "da", "hier", "dort", "mir", "mich", "dir", "dich", "ihm", "ihn", "uns", "kann", "konnen",
    "muss", "musste", "soll", "gibt", "sag", "sage", "zeig", "zeige", "bitte", "danke", "lang", "lange",
  ]),
  es: new Set([
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "y", "o", "que", "cual", "cuales", "quien", "como", "cuando", "donde",
    "cuanto", "cuanta", "cuantos", "cuantas", "es", "son", "esta", "estan", "fue", "ser", "era", "hay", "mi", "mis", "tu", "tus", "su", "sus", "nuestro",
    "nuestra", "en", "con", "por", "para", "sin", "sobre", "entre", "lo", "le", "les", "se", "me", "te", "nos", "no", "si", "muy", "mas", "pero", "este",
    "estos", "esa", "ese", "eso", "puedes", "dime", "muestra", "favor", "gracias", "tengo", "tiene",
  ]),
  it: new Set([
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della", "dei", "delle", "degli", "dello", "da", "dal", "dalla", "in", "nel",
    "nella", "con", "su", "sul", "sulla", "per", "tra", "fra", "e", "o", "che", "chi", "come", "quando", "dove", "quanto", "quanta", "quanti", "quale",
    "quali", "sono", "era", "mio", "mia", "miei", "mie", "tuo", "tua", "suo", "sua", "nostro", "nostra", "non", "piu", "ma", "questo", "questa", "quello",
    "quella", "mi", "ti", "ci", "si", "puoi", "dimmi", "mostrami", "grazie", "ho", "ha", "hanno", "qual", "al", "allo", "alla", "ai", "agli", "alle",
    "dallo", "dai", "dagli", "dalle", "nello", "nei", "negli", "nelle", "sullo", "sui", "sugli", "sulle", "dello", "col", "coi",
  ]),
  pt: new Set([
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas", "por", "para", "com", "sem",
    "sobre", "e", "ou", "que", "qual", "quais", "quem", "como", "quando", "onde", "quanto", "quanta", "quantos", "sao", "foi", "ser", "meu", "minha",
    "meus", "minhas", "seu", "sua", "nosso", "nossa", "nao", "mais", "mas", "este", "esta", "esse", "essa", "isso", "me", "te", "se", "voce", "pode",
    "diga", "mostre", "obrigado", "obrigada", "tenho", "tem",
  ]),
  nl: new Set([
    "de", "het", "een", "en", "of", "maar", "is", "zijn", "was", "waren", "wordt", "worden", "heeft", "hebben", "heb", "ik", "jij", "je", "hij", "zij",
    "ze", "wij", "we", "mijn", "jouw", "haar", "ons", "onze", "van", "in", "op", "aan", "met", "voor", "bij", "naar", "uit", "over", "tot", "om", "dat",
    "die", "dit", "deze", "wat", "wie", "waar", "wanneer", "waarom", "hoe", "hoeveel", "welke", "welk", "niet", "geen", "ook", "nog", "wel", "er", "kan",
    "kun", "kunt", "moet", "mij", "me", "mag", "graag", "dank", "bedankt", "lang",
  ]),
};

const LANGUAGES = Object.keys(SMALL_WORDS) as SearchLanguage[];

/// The language of a question's words (folded), among these five; null for
/// French, English, or when its words do not say.
export function searchLanguage(words: string[], frenchOrEnglish: ReadonlySet<string>): SearchLanguage | null {
  const theirs = words.filter((word) => frenchOrEnglish.has(word)).length;
  let best: SearchLanguage | null = null;
  let most = 0;
  let tie = false;
  for (const language of LANGUAGES) {
    const count = words.filter((word) => SMALL_WORDS[language].has(word)).length;
    if (count > most) { best = language; most = count; tie = false; }
    else if (count === most && count > 0) tie = true;
  }
  return best && !tie && most >= 2 && most > theirs ? best : null;
}

export function smallWord(language: SearchLanguage, word: string): boolean {
  return SMALL_WORDS[language].has(word);
}

const VOWELS = "aeiou";

/// What a word's singular and plural share, null when it is the word
/// itself. Not linguistics: the commonest endings of nouns.
export function languageStem(language: SearchLanguage, word: string): string | null {
  if (word.length < 5 || /\d/.test(word)) return null;
  let stem = word;
  switch (language) {
    case "de":
      // Rechnungen → rechnung, Verträge → vertrag, Vertrages → vertrag.
      stem = word.endsWith("ungen") ? word.slice(0, -2) : word.replace(/(?:ern|en|er|es|em|e|n|s)$/, "");
      break;
    case "es":
      // contratos → contrato, rescisiones → rescision.
      stem = word.endsWith("ciones") ? word.slice(0, -2) : word.replace(/(?:es|s)$/, "");
      break;
    case "it":
      // fatture / fattura → fattur, contratti → contratt.
      stem = word.replace(/[aeio]$/, "");
      break;
    case "pt":
      // rescisões / rescisão → rescis, faturas → fatura.
      stem = /(?:oes|aes|ao)$/.test(word) ? word.replace(/(?:oes|aes|ao)$/, "") : word.replace(/s$/, "");
      break;
    case "nl":
      // facturen / factuur → factu, contracten / contract → contrac: the
      // ending, the last consonant, a doubled vowel.
      stem = word.replace(/(?:en|s|e)$/, "");
      if (!VOWELS.includes(stem.at(-1)!)) stem = stem.slice(0, -1);
      if (stem.length >= 2 && stem.at(-1) === stem.at(-2) && VOWELS.includes(stem.at(-1)!)) stem = stem.slice(0, -1);
      break;
  }
  return stem.length >= 4 && stem !== word ? stem : null;
}
