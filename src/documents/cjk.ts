// Japanese, Chinese and Korean in keyword search (10/10/2026).
//
// FTS5's unicode61 tokenizer cuts words at spaces and punctuation. Japanese
// and Chinese do not space their words, and Korean glues its particles to
// them (« 기간은 », « 기간이 »): a whole clause was one token, and
// « 解約予告期間 », « 解除通知期 » or « 해지 예고 기간 » found nothing although
// the words were in the files (found while capturing the site's screenshots
// in its ten languages with 0.13.92).
//
// So every run of these scripts is also indexed as its overlapping pairs of
// characters — « 解約予告期間 » → 解約 約予 予告 告期 期間 — plus its last
// character alone, so that any character starts some token
// (`indexGrams`, in document_grams: migration 9). A question's runs are cut
// into words where Japanese particles, Chinese function words or Korean
// particles stand (`cjkWords`), and a word is found where most of its pairs
// are: inside a longer compound (« 解約の予告期間 »), before a particle,
// spaced or not. The other languages' words, their index and their stems
// are left exactly as they were (query.ts).
//
// Text is NFKC-folded here (half-width katakana, full-width digits,
// compatibility ideographs), never NFD: decomposing turned « が » into « か »
// once the marks were stripped, and hangul syllables into jamo.

const SCRIPT = [
  "\\u3005\\u3007", // 々 〇
  "\\u3040-\\u309f", // hiragana
  "\\u30a1-\\u30fa\\u30fc-\\u30ff", // katakana, without ・ (a separator)
  "\\u31f0-\\u31ff", // katakana extensions
  "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff", // Han
  "\\u2e80-\\u2fdf", // radicals some PDFs give for characters (NFKC folds them)
  "\\u{20000}-\\u{2fa1f}", // Han, supplementary planes
  "\\u1100-\\u11ff\\u3130-\\u318f\\uac00-\\ud7af", // hangul
  "\\uff66-\\uff9f", // half-width katakana (NFKC makes them whole)
].join("");

/// A character of these scripts.
export const CJK = new RegExp(`[${SCRIPT}]`, "u");
/// A run of them, with the digits written inside it (« 第4条 », « 3개월 »,
/// « 2026年11月30日 »).
const RUN = new RegExp(`[${SCRIPT}0-9\\uff10-\\uff19]*[${SCRIPT}][${SCRIPT}0-9\\uff10-\\uff19]*`, "gu");

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/// A line break between two of their characters: a PDF's or a scan's line
/// ends wherever the width did, often inside a word (« 解除通知期为三\n个月 »).
const WRAPPED = new RegExp(`([${SCRIPT}])[ \\t]*\\r?\\n[ \\t]*(?=[${SCRIPT}])`, "gu");

/// The runs of these scripts in a text, NFKC-folded, in order, a run carried
/// over a line break. Japanese writes « three months » 三か月, 三ヶ月, 三ケ月 or
/// 三カ月: one spelling here.
export function cjkRuns(text: string): string[] {
  if (!CJK.test(text)) return [];
  return [...text.replace(WRAPPED, "$1").matchAll(RUN)].map((match) => match[0].normalize("NFKC").replace(/[ヶケカヵ](?=月)/gu, "か"));
}

/// The text with its runs taken out (what the other languages' words are
/// read from), a space where each one was.
export function withoutCjk(text: string): string {
  return CJK.test(text) ? text.replace(RUN, " ") : text;
}

/// Overlapping pairs of characters: « 期間 » → [期間], « 予告期間 » → [予告,
/// 告期, 期間]; a single character as it is.
export function bigrams(run: string): string[] {
  const chars = [...run];
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/// What document_grams holds for a passage: each run's pairs and its last
/// character, separated by spaces (unicode61 then sees each as a token).
/// Empty when the passage has none of these scripts.
export function indexGrams(text: string): string {
  const tokens: string[] = [];
  for (const run of cjkRuns(text)) {
    const chars = [...run];
    tokens.push(...bigrams(run));
    if (chars.length > 1) tokens.push(chars[chars.length - 1]!);
  }
  return tokens.join(" ");
}

// Where a question's runs are cut. Japanese: hiragana are mostly particles
// and endings (« は », « の », « ですか »). Chinese: function and question
// words that are rarely part of another word. Korean: particles and endings
// at the end of a spaced word, and question words.
const HIRAGANA = /[぀-ゟ]+/u;
const ZH_FUNCTION = /什么|怎么样|怎么|怎样|多少|多久|哪里|哪儿|哪些|哪个|为什么|请问|是否|我们|你们|他们|这个|那个|这些|那些|告诉我|一下|可以|的|了|吗|呢|吧|啊|呀|嘛|是|我|你|您/u;
const KO_ENDINGS = [
  "에서는", "에게서", "으로는", "이라고", "입니까", "인가요", "인지요", "습니까", "이에요", "였나요", "했나요", "있나요", "있어요", "인데요",
  "에서", "에게", "한테", "으로", "까지", "부터", "처럼", "보다", "이나", "이랑", "은요", "는요", "이요", "예요", "이다", "인가", "나요", "가요", "는데",
  "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만", "요",
];
const KO_STOP = new Set(["얼마", "얼마나", "무엇", "뭐", "무슨", "언제", "어디", "어떻게", "어떤", "왜", "누구", "몇", "알려줘", "알려주세요", "주세요", "해줘", "뭔가요", "있나", "내", "제", "나", "저"]);

function stripKoreanEnding(word: string): string {
  for (const ending of KO_ENDINGS) {
    if (word.length - ending.length >= 2 && word.endsWith(ending)) return word.slice(0, -ending.length);
  }
  return word;
}

/// The words of these scripts a question holds, as search terms: its runs
/// cut at particles and function words, one-character pieces left out
/// unless nothing else is left.
export function cjkWords(text: string): string[] {
  const words: string[] = [];
  const singles: string[] = [];
  for (const run of cjkRuns(text)) {
    const pieces = /[가-힯]/u.test(run)
      ? [stripKoreanEnding(run)].filter((word) => !KO_STOP.has(word))
      : run.split(HIRAGANA).flatMap((piece) => piece.split(ZH_FUNCTION));
    for (const piece of pieces) {
      if (!piece) continue;
      if ([...piece].length === 1) {
        if (CJK.test(piece)) singles.push(piece);
      } else if (!words.includes(piece)) {
        words.push(piece);
      }
    }
  }
  return words.length ? words : [...new Set(singles)];
}

/// Whether a text holds a word of these scripts: most of its pairs (three
/// in five), so a compound said differently still counts; a single
/// character as it is.
export function cjkFound(text: string, word: string): boolean {
  const folded = cjkRuns(text).join(" ");
  const pairs = bigrams(word);
  if (pairs.length === 1) return folded.includes(pairs[0]!);
  const present = pairs.filter((pair) => folded.includes(pair)).length;
  return present >= Math.ceil(pairs.length * 0.6);
}

/// The MATCH expression on document_grams for these words: each word's
/// pairs OR-ed (BM25 ranks the passages holding more of them, and the
/// rarer ones, first), with the whole word as a phrase too, which ranks a
/// passage that holds it as written higher still. A single character
/// matches as the start of a token.
export function gramsMatch(words: string[], maxPairs = 32): string | null {
  const parts: string[] = [];
  let budget = maxPairs;
  for (const word of words) {
    if (budget <= 0) break;
    const pairs = bigrams(word).slice(0, budget);
    budget -= pairs.length;
    if (pairs.length === 1 && [...word].length === 1) {
      parts.push(`"${word}"*`);
      continue;
    }
    const alternatives = pairs.map((pair) => `"${pair}"`);
    if (pairs.length > 1) alternatives.unshift(`"${pairs.join(" ")}"`);
    parts.push(alternatives.join(" OR "));
  }
  return parts.length ? parts.join(" OR ") : null;
}

/// How many of these words a text holds (cjkFound).
export function cjkWordsFound(text: string, words: string[]): number {
  return words.filter((word) => cjkFound(text, word)).length;
}

/// A short extract of a text around the first of these words it holds, for
/// a passage found through document_grams (FTS5's snippet() only reads the
/// table it matched).
export function cjkSnippet(text: string, words: string[], length = 120): string {
  const folded = text.normalize("NFKC").replace(/[ヶケカヵ](?=月)/gu, "か");
  let at = -1;
  for (const word of words) {
    for (const piece of [word, ...bigrams(word)]) {
      const index = folded.indexOf(piece);
      if (index !== -1 && (at === -1 || index < at)) at = index;
    }
    if (at !== -1) break;
  }
  if (at === -1) return text.slice(0, length);
  const start = Math.max(0, at - Math.floor(length / 3));
  return `${start > 0 ? "…" : ""}${folded.slice(start, start + length)}${start + length < folded.length ? "…" : ""}`;
}

/// LIKE patterns for these words' pairs, where an index has no pairs of its
/// own (the conversations', the e-mails': their triggers are SQL, which
/// cannot cut text into pairs): a row holding any pair is a candidate, and
/// cjkWordsFound then says how many words it really holds.
export function likePatterns(words: string[], max = 16): string[] {
  return [...new Set(words.flatMap((word) => bigrams(word)))].slice(0, max).map((pair) => `%${pair}%`);
}
