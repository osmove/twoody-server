import { CJK, fold } from "../intentText.js";

// « Agir dans vos dossiers » (twoody-desktop docs/agent-in-chat.md, Jimmy,
// 16/10/2026): a request that means acting on the files of a folder —
// « range mes factures par mois », « renomme ces scans avec leur date »,
// « fais-moi un Word avec les délais de préavis de mes contrats », « compare
// ces deux contrats et fais un tableau Excel » — read here, without the
// model, in the ten languages of the app: Qwen3.5 9B does not reliably call
// a forced tool and says « C'est fait » without acting (root AGENTS.md §8).
// What is read is only what to propose; nothing is done before the person
// agrees (run.ts).

export type FileActionKind = "sort" | "rename" | "draft" | "table";
export type SortBy = "month" | "year" | "type";

export type FileIntent =
  | { kind: "sort"; by: SortBy; words: string[] }
  | { kind: "rename"; words: string[] }
  | { kind: "draft"; words: string[]; title: string | null }
  | { kind: "table"; words: string[]; title: string | null }
  | { kind: "delete"; words: string[] };

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const latin = (alternatives: string) => new RegExp(`${B}(?:${alternatives})${E}`, "u");

/// Sorting: « range », « trie », « classe », « organise »… (fold()ed).
const SORT_VERBS = new RegExp([
  latin(String.raw`rang(?:e|es|ez|er)|tri(?:e|es|ez|er)|class(?:e|es|ez|er)|organis(?:e|es|ez|er)|ordonn(?:e|es|ez|er)|mets? de l'ordre dans|mettez de l'ordre dans`),
  latin(String.raw`sort|organi[sz]e|arrange|tidy up|put (?:away|in order)`),
  latin(String.raw`sortier(?:e|en|st|t)?|ordne|ordnen|organisier(?:e|en|st)?|raume [\p{L}\s]{0,40}?auf|aufraumen|einordnen`),
  latin(String.raw`ordena(?:r|me|lo|los|las)?|organiza(?:r|me|lo|los|las)?|clasifica(?:r|lo|los|las)?`),
  latin(String.raw`ordina(?:re|mi|li|le)?|organizza(?:re|mi|li|le)?|riordina(?:re|mi|li|le)?|sistema(?:re|mi|li|le)?|archivia(?:re|mi|li|le)?`),
  latin(String.raw`organiz(?:e|a|ar)|orden(?:e|ar)|classifiqu(?:e)|classifica(?:r)?|arrum(?:e|a|ar)`),
  latin(String.raw`sorteer|sorteren|orden|ordenen|organiseer|organiseren|rangschik|rangschikken`),
].map((pattern) => pattern.source).join("|") + "|整理|仕分け|分類|振り分け|並べ替え|分类|归类|歸類|归档|歸檔|정리|분류", "u");

const BY_MONTH = new RegExp([
  String.raw`par mois|mois par mois|par mois et par annee|by month|per month|monthly|into months|month by month|nach monat(?:en)?|monatlich|monatsweise|por mes(?:es)?|mes a mes|per mese|mese per mese|mensilmente|por mes|mensalmente|per maand|maandelijks`,
  "月ごと|月別|月毎|月単位|按月|每月|逐月|월별|달별|매월",
].join("|"), "u");
const BY_YEAR = new RegExp([
  String.raw`par annee|par an${E}|by year|per year|yearly|annually|nach jahr(?:en)?|jahrlich|por ano|por anos|per anno|annualmente|per jaar|jaarlijks`,
  "年ごと|年別|年毎|按年|每年|연도별|년도별|해마다",
].join("|"), "u");
const BY_TYPE = new RegExp([
  String.raw`par type|par genre|par sorte|par format|par extension|by (?:file )?type|by kind|by format|by extension|nach (?:datei)?typ|nach art|nach format|por tipo|por formato|per tipo|per formato|per type|per soort|op type`,
  "種類ごと|種類別|形式別|拡張子|按类型|按格式|按种类|종류별|유형별|형식별",
].join("|"), "u");

/// Renaming, with the date: « renomme ces scans avec leur date ».
const RENAME_VERBS = new RegExp([
  latin(String.raw`renomm(?:e|es|ez|er)|rebaptis(?:e|es|ez|er)|change (?:le|les) noms?`),
  latin(String.raw`rename|re-name`),
  latin(String.raw`umbenennen|benenne [\p{L}\s]{0,40}?um|umbenenne|nenne [\p{L}\s]{0,40}?um`),
  latin(String.raw`renombra(?:r|lo|los|las)?|cambia(?:r)? (?:el|los) nombres?`),
  latin(String.raw`rinomina(?:re|li|le)?|cambia(?:re)? (?:il|i) nom[ei]`),
  latin(String.raw`renomei(?:e|a)|renomear|renomeie`),
  latin(String.raw`hernoem|hernoemen|wijzig de namen?`),
].map((pattern) => pattern.source).join("|") + "|名前を(?:変|付け)|リネーム|改名|重命名|이름을?\\s?(?:바꿔|변경)|이름\\s?변경", "u");
const DATE_WORDS = new RegExp(`${B}(?:date|dates|datum|data|fecha|fechas|datas|date)${E}|日付|日期|날짜`, "u");

/// Making a document: a verb of making or writing, and Word.
const MAKE_VERBS = new RegExp([
  latin(String.raw`fai[st]|faire|faites|cree|creer|creez|redige|rediger|redigez|ecri[st]|ecrire|ecrivez|prepare|preparer|preparez|genere|generer|produi[st]|sors|mets`),
  latin(String.raw`make|create|write|draft|prepare|generate|produce|put together|build|give me|export`),
  latin(String.raw`erstell(?:e|en)?|schreib(?:e|en)?|mach(?:e|en)?|verfass(?:e|en)?|leg [\p{L}\s]{0,20}?an|anlegen|gib mir`),
  latin(String.raw`haz|hacer|hazme|crea|crear|creame|redacta|redactar|escribe|escribir|prepara|preparar|genera|generar|dame`),
  latin(String.raw`fai|fammi|fare|scrivi|scrivere|redigi|redigere|prepara|preparare|genera|generare|crea|creare|dammi`),
  latin(String.raw`faca|faz|fazer|cria|criar|crie|escreva|escrever|redija|redigir|prepare|preparar|gere|gerar|me de|monte`),
  latin(String.raw`maak|maken|schrijf|schrijven|stel [\p{L}\s]{0,20}?op|opstellen|genereer|geef me`),
].map((pattern) => pattern.source).join("|") + "|作って|作成|書いて|まとめて|做(?:一|个|個|成)|写(?:一|个|個|成)|寫|生成|创建|製作|制作|만들어|작성|정리해", "u");
const WORD_DOCUMENT = new RegExp(`${B}(?:word|docx|\\.docx|ms word|microsoft word)${E}|ワード|word文書|word文档|word文件|워드`, "u");
const SPREADSHEET = new RegExp(`${B}(?:excel|xlsx|\\.xlsx|tableur|classeur excel|spreadsheet|tabellenkalkulation|hoja de calculo|foglio (?:di calcolo|excel)|planilha|rekenblad)${E}|エクセル|表計算|电子表格|電子表格|엑셀|스프레드시트`, "u");
const COMPARE = new RegExp(`${B}(?:compar(?:e|er|ez|es|ing|a|ar|are|ate|ison|aison)|vergleich(?:e|en|st)?|confronta(?:re)?|vergelijk(?:en)?)${E}|比較|比较|비교`, "u");
const TABLE = new RegExp(`${B}(?:tableau|table|tabelle|tabla|tabella|tabela|tabel)${E}|表|표`, "u");

/// Deleting: refused, whatever asks it.
const DELETE_VERBS = new RegExp([
  latin(String.raw`supprim(?:e|es|ez|er)|effac(?:e|es|ez|er)|jett(?:e|es|ez|er)|vir(?:e|es|ez|er)|detrui[st]|detruire|mets? a la corbeille`),
  latin(String.raw`delete|remove|erase|trash|get rid of|wipe|throw away|clean out`),
  latin(String.raw`losch(?:e|en|t)?|entfern(?:e|en)?|wirf [\p{L}\s]{0,30}?weg|wegwerfen`),
  latin(String.raw`borra(?:r|lo|los|las)?|elimina(?:r|lo|los|las)?|suprime|tira`),
  latin(String.raw`cancella(?:re|li|le)?|elimina(?:re|li|le)?|butta(?:re|li|le)? via|rimuovi`),
  latin(String.raw`apag(?:a|ue|ar)|exclu(?:a|ir)|remov(?:a|er)|jogue fora`),
  latin(String.raw`verwijder(?:en)?|wis|gooi [\p{L}\s]{0,30}?weg`),
].map((pattern) => pattern.source).join("|") + "|削除|消して|消去|捨てて|删除|删掉|刪除|清除|삭제|지워", "u");

/// What a file is called, in each language: deleting « ce rappel » or « ce
/// souvenir » is no deleting of files.
const FILE_NOUNS = new RegExp([
  latin(String.raw`fichiers?|documents?|dossiers?|scans?|factures?|doublons?|pdfs?|photos?|images?|captures?|telechargements|contrats?|releves?|recus?|tickets?`),
  latin(String.raw`files?|folders?|duplicates?|invoices?|contracts?|receipts?|statements?|screenshots?|downloads|pictures?`),
  latin(String.raw`dateien|datei|dokumente?|ordner|rechnungen|rechnung|vertrage|vertrag|belege?|duplikate|bilder|fotos`),
  latin(String.raw`archivos?|documentos?|carpetas?|facturas?|contratos?|recibos?|duplicados?|fotos|imagenes|capturas`),
  latin(String.raw`file|cartelle|cartella|fatture|fattura|contratti|contratto|ricevute|duplicati|foto|immagini|documenti`),
  latin(String.raw`arquivos?|pastas?|faturas?|recibos|duplicatas|imagens`),
  latin(String.raw`bestanden|bestand|mappen|map|facturen|factuur|contracten|contract|bonnetjes|duplicaten|afbeeldingen`),
].map((pattern) => pattern.source).join("|") + "|ファイル|書類|フォルダ|請求書|契約書|スキャン|写真|文件|文件夹|發票|发票|合同|扫描|照片|파일|폴더|문서|청구서|계약서|스캔|사진", "u");

/// Asked how, or why — advice, not an order: « comment ranger mes factures ? ».
const ADVICE = new RegExp([
  String.raw`^(?:comment|pourquoi|quelle est la (?:meilleure|bonne) (?:facon|maniere)|est-ce que je (?:dois|devrais)|dois-je|faut-il|how|why|what(?:'s| is) the best way|should i|wie|warum|sollte ich|como|cual es la mejor|por que|deberia|come|perche|qual e il modo|dovrei|como|por que|qual a melhor|devo|hoe|waarom|moet ik)${E}`,
  "^(?:どうやって|どうすれば|どうしたら|なぜ|怎么|怎样|如何|为什么|為什麼|어떻게|왜)",
].join("|"), "u");

/// Said about the past: « j'ai rangé mes factures », « I sorted… ».
const PAST = new RegExp([
  String.raw`${B}(?:j'ai|on a|nous avons|tu as|vous avez) (?:deja )?(?:range|trie|classe|renomme|supprime|efface|organise|fait|cree|redige)${E}`,
  String.raw`${B}(?:i|we|you) (?:have |had |already )?(?:sorted|renamed|deleted|organi[sz]ed|made|created|wrote|written)${E}`,
  String.raw`${B}(?:habe|haben|hast|hatte) [\p{L}\s]{0,40}?(?:sortiert|umbenannt|geloscht|erstellt|geschrieben)${E}`,
].join("|"), "u");

/// What may name the folder: a quoted name, a path, the word after
/// « dossier », the noun after « mes » / « ces » / my / these…
const FOLDER_WORD = String.raw`(?:dossier|repertoire|folder|directory|ordner|verzeichnis|carpeta|directorio|cartella|pasta|map)`;
const POSSESSIVE = String.raw`(?:mes|ces|les|tous mes|toutes mes|tous les|toutes les|my|these|those|the|all my|all the|meine|meinen|meiner|meinem|diese|dieser|alle meine|mis|estos|estas|los|las|todos mis|todas mis|todos los|todas las|i miei|le mie|i|gli|le|questi|queste|tutti i miei|tutte le mie|tutti i|tutte le|meus|minhas|esses|essas|estes|os|as|todos os meus|todas as minhas|todos os|todas as|mijn|deze|die|al mijn|alle)`;

function stripped(word: string): string {
  return word.replace(/^[«"“'‘「『\s]+|[»"”'’」』\s.,;:!?？。]+$/g, "").trim();
}

/// The words of the message that may name a folder, most precise first.
export function folderWords(original: string): string[] {
  const found: string[] = [];
  const add = (word: string | undefined) => {
    // « Tessane par », « Rechnungen nach »: the words after the name are not it.
    const parts = stripped(word ?? "").split(/\s+/);
    while (parts.length > 1 && STOP_FOLDER_WORDS.has(fold(parts[parts.length - 1]!))) parts.pop();
    const clean = parts.join(" ");
    if (clean && clean.length <= 120 && !found.some((each) => fold(each) === fold(clean))) found.push(clean);
  };
  // « Factures », "Documents/Factures", 「請求書」.
  for (const match of original.matchAll(/[«"“「『]\s*([^»"”」』]{1,120}?)\s*[»"”」』]/gu)) add(match[1]);
  // A path: « Documents/Factures », « ~/Bureau/Scans ».
  for (const match of original.matchAll(/(?:^|\s)(~?\/?[\p{L}\p{N}_.()-]+(?:\/[\p{L}\p{N}_ .()-]+)+)/gu)) add(match[1]?.replace(/\s+(?:par|by|nach|por|per|op|avec|with|mit|con|com|met)\s.*$/u, ""));
  const folded = fold(original);
  // « le dossier Factures », « the Invoices folder », « den Ordner Rechnungen ».
  for (const match of folded.matchAll(new RegExp(`${B}${FOLDER_WORD}s?\\s+(?:de |des |du |d'|of |der |von |del |de la |di |dei |da |do |dos |van )?([\\p{L}\\p{N}_-]+(?:\\s[\\p{L}\\p{N}_-]+)?)`, "gu"))) add(originalWord(original, match[1]!));
  for (const match of folded.matchAll(new RegExp(`${B}([\\p{L}\\p{N}_-]+)[ -]${FOLDER_WORD}${E}`, "gu"))) add(originalWord(original, match[1]!));
  // « mes factures », « ces scans », « my invoices », « meine Rechnungen ».
  for (const match of folded.matchAll(new RegExp(`${B}${POSSESSIVE}\\s+(?:deux |two |zwei |dos |due |dois |twee )?([\\p{L}\\p{N}_-]{3,})(?:\\s([\\p{L}\\p{N}_-]{3,}))?`, "gu"))) {
    const first = originalWord(original, match[1]!);
    const second = match[2] ? originalWord(original, match[2]) : null;
    if (second && !STOP_FOLDER_WORDS.has(match[2]!)) add(`${first} ${second}`);
    add(first);
    if (second) add(second);
  }
  // « dans Téléchargements », « in Downloads », « im Ordner Belege ».
  for (const match of folded.matchAll(new RegExp(`${B}(?:dans|depuis|in|from|im|aus|en|nel|nella|dalla|no|na|em|da|op|uit|van)\\s+(?:(?:le|la|les|mon|ma|mes|the|my|meinem|meinen|dem|der|mi|mis|el|il|lo|la mia|o|a|meu|minha|de|het|mijn)\\s+)?([\\p{L}\\p{N}_-]{3,})`, "gu"))) add(originalWord(original, match[1]!));
  // Japanese, Chinese, Korean: the document words themselves.
  if (CJK.test(original)) for (const match of original.matchAll(/請求書|契約書|スキャン|書類|領収書|发票|發票|合同|扫描|收据|청구서|계약서|스캔|영수증/gu)) add(match[0]);
  return found.filter((word) => !STOP_FOLDER_WORDS.has(fold(word)));
}

/// The words as typed (their accents and case) for a folded match.
function originalWord(original: string, folded: string): string {
  const words = original.split(/[\s,;:!?]+/u);
  return folded.split(" ").map((part) => words.find((word) => fold(stripped(word)) === part) ?? part).join(" ");
}

/// Words the patterns above take that name no folder.
const STOP_FOLDER_WORDS = new Set([
  "fichiers", "fichier", "documents", "document", "files", "file", "dateien", "datei", "archivos", "archivo", "file", "arquivos", "arquivo", "bestanden", "bestand",
  "dossiers", "dossier", "folders", "folder", "ordner", "carpetas", "cartelle", "pastas", "mappen", "deux", "two", "mois", "month", "months", "date", "dates",
  "noms", "names", "nombres", "nomi", "nomes", "namen", "delais", "elements", "items", "choses", "things", "par", "with", "avec",
  "le", "la", "les", "l'", "the", "un", "une", "a", "an", "mon", "ma", "ce", "cette", "der", "den", "das", "dem", "die", "ein", "eine", "el", "il", "lo", "o", "het", "de", "een", "este", "esta", "questo", "questa",
  "nach", "por", "per", "con", "com", "mit", "met", "by", "in", "into", "dans", "en", "au", "aux", "to", "im", "nel", "na", "no", "op", "dossier", "folder",
  "vieux", "vieilles", "anciens", "anciennes", "old", "alten", "viejos", "vecchi", "antigos", "oude", "nouveaux", "new", "neuen", "recents", "recent", "derniers", "last", "letzten",
]);

/// A short title for the document asked: « les délais de préavis de mes
/// contrats » → « Délais de préavis ». Null when none can be read.
export function titleFrom(original: string): string | null {
  const patterns = [
    /(?:avec|sur|listant|qui liste|résumant|récapitulant|des?|du)\s+(?:les|la|le|l'|des|tous les|toutes les)?\s*([^,.;!?]{3,80}?)\s+(?:de|des|du|dans)\s+(?:mes|ces|nos|tous mes|toutes mes|mon|ma|ce|cette)\s/iu,
    /(?:with|of|listing|about|on|summarising|summarizing)\s+(?:the|all the|all)?\s*([^,.;!?]{3,80}?)\s+(?:of|from|in)\s+(?:my|these|those|our|all my)\s/iu,
    /(?:mit|über|uber)\s+(?:den|die|der|allen)?\s*([^,.;!?]{3,80}?)\s+(?:meiner|meinen|aus meinen|dieser|aller)\s/iu,
    /(?:con|sobre)\s+(?:los|las|el|la|todos los|todas las|i|le|gli|il)?\s*([^,.;!?]{3,80}?)\s+(?:de|dei|delle|degli|di)\s+(?:mis|estos|estas|miei|mie|questi|queste)\s/iu,
    /(?:com|sobre)\s+(?:os|as|o|a)?\s*([^,.;!?]{3,80}?)\s+(?:dos|das|de)\s+(?:meus|minhas|esses|essas)\s/iu,
    /(?:met|over)\s+(?:de|het|alle)?\s*([^,.;!?]{3,80}?)\s+(?:van|uit)\s+(?:mijn|deze|al mijn)\s/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(original);
    const title = match?.[1]?.replace(/^(?:un|une|a|an|ein|eine|einen)\s+/iu, "").trim();
    if (title && !WORD_DOCUMENT.test(fold(title)) && !SPREADSHEET.test(fold(title))) return capitalised(title);
  }
  return null;
}

function capitalised(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/// Where an order starts: the message's start, after a comma or a full
/// stop, after « et » / and / und…, a greeting or « Twoody, » before it.
const CLAUSE_START = String.raw`(?:^|[,.;:!?]\s*|\s(?:et|puis|ensuite|and|then|und|dann|y|luego|e|poi|en|dan|daarna)\s+)(?:(?:alors|bon|ok|okay|hey|salut|bonjour|hello|hi|so|now|maintenant|twoody|hallo|hola|ciao|ola|hoi)[\s,]+)*`;
/// A request put politely, the verb wherever the language puts it:
/// « peux-tu ranger… », « kannst du meine Rechnungen nach Monat sortieren ? ».
const POLITE = new RegExp(String.raw`(?:^|[\s,])(?:peux-tu|pourrais-tu|pouvez-vous|pourriez-vous|tu peux|vous pouvez|tu pourrais|vous pourriez|je veux que tu|je voudrais que tu|j'aimerais que tu|merci de|s'il te plait|s'il vous plait|can you|could you|would you|will you|please|i want you to|i'd like you to|i would like you to|kannst du|konntest du|konnen sie|konnten sie|bitte|puedes|podrias|puede|podria|por favor|quiero que|puoi|potresti|puo|per favore|vorrei che|voce pode|pode|poderia|quero que|kun je|kunt u|zou je|wil je|alsjeblieft)(?=[\s,]|$)`, "u");

/// The verb as an order: where a clause starts, or anywhere in a polite
/// request; in Japanese, Chinese and Korean, anywhere (« 請求書を月ごとに整理して »).
/// « What's the price range of my invoices? » is no « range ».
function ordered(text: string, verbs: RegExp): boolean {
  if (!verbs.test(text)) return false;
  if (CJK.test(text) || POLITE.test(text)) return true;
  return new RegExp(`${CLAUSE_START}(?:${verbs.source})`, "u").test(text);
}

/// What the message asks to do with files, or null when it asks nothing of
/// the kind (a question, advice, something said about the past).
export function fileActionIntent(message: string): FileIntent | null {
  const original = message.replace(/\s+/g, " ").trim();
  if (!original || original.length > 600) return null;
  const text = fold(original);
  if (ADVICE.test(text) || PAST.test(text)) return null;
  const words = folderWords(original);
  if (SPREADSHEET.test(text) && (MAKE_VERBS.test(text) || COMPARE.test(text) || TABLE.test(text))) return { kind: "table", words, title: titleFrom(original) };
  if (WORD_DOCUMENT.test(text) && MAKE_VERBS.test(text)) return { kind: "draft", words, title: titleFrom(original) };
  if (ordered(text, RENAME_VERBS) && DATE_WORDS.test(text)) return { kind: "rename", words };
  if (ordered(text, SORT_VERBS) && (FILE_NOUNS.test(text) || words.length > 0) && !RENAME_VERBS.test(text)) {
    const by: SortBy = BY_YEAR.test(text) && !BY_MONTH.test(text) ? "year" : BY_TYPE.test(text) && !BY_MONTH.test(text) ? "type" : "month";
    return { kind: "sort", by, words };
  }
  if (ordered(text, DELETE_VERBS) && FILE_NOUNS.test(text)) return { kind: "delete", words };
  return null;
}

/// « oui », « vas-y », « yes », « ja », « はい »… alone (or nearly): the
/// person agreeing to what was just proposed.
const YES = new RegExp([
  String.raw`^\s*(?:oui|ouais|yes|yep|yeah|ok|okay|d'accord|dac|vas-y|allez-y|go|go ahead|volontiers|parfait|bien sur|absolument|fais-le|faites-le|c'est parti|on y va|sure|of course|do it|please do|ja|jawohl|gerne?|klar|mach (?:das|es|nur)|los|si|claro|vale|dale|hazlo|adelante|de acuerdo|certo|va bene|fallo|procedi|sim|pode|faca|faz|beleza|graag|doe maar|ga je gang|prima|zeker)(?:[\s,.!]+(?:merci|thanks|thank you|danke|gracias|grazie|obrigad[oa]|bedankt|please|s'il (?:te|vous) plait|stp|svp|bitte|por favor|per favore|alsjeblieft|vas-y|go|fais-le|faites-le|c'est bon|do it|mach es|hazlo|fallo))*[\s.!]*$`,
  "^\\s*(?:はい|ええ|うん|お願い(?:します)?|おねがい|そうして|やって|是的|好的|好|可以|行|做吧|네|예|응|좋아|그래|해\\s?줘|부탁(?:해요|합니다)?)[\\s。.!！]*$",
].join("|"), "u");
const NO = new RegExp([
  String.raw`^\s*(?:non|non merci|pas maintenant|laisse tomber|annule|no|no thanks|nope|not now|cancel|nein|nein danke|lieber nicht|no gracias|mejor no|cancela|no grazie|annulla|nao|nao obrigad[oa]|cancele|nee|nee dank je|niet doen)[\s.!]*$`,
  "^\\s*(?:いいえ|いや|やめて|キャンセル|不|不要|不用|算了|取消|아니(?:요)?|아니오|취소|됐어)[\\s。.!！]*$",
].join("|"), "u");

export function saysYes(message: string): boolean {
  const text = message.trim();
  return text.length <= 80 && YES.test(fold(text));
}

export function saysNo(message: string): boolean {
  const text = message.trim();
  return text.length <= 60 && NO.test(fold(text));
}

/// The language a request is written in, from its words of order and of
/// place (« rinomina … le scansioni … loro data » is Italian, though « le »
/// and « la » are French words too): null when it does not tell.
const REQUEST_WORDS: Array<[string, RegExp]> = [
  ["fr", latin(String.raw`range|ranger|trie|trier|classe|renomme|renommer|fais|faire|redige|supprime|efface|mes|ces|par mois|par annee|avec leur|dossier|factures|contrats|tableau`)],
  ["en", latin(String.raw`sort|organi[sz]e|rename|make|write|create|delete|remove|my|these|the|by month|by year|with their|folder|invoices|contracts|spreadsheet|table`)],
  ["de", latin(String.raw`sortiere|sortieren|ordne|benenne|umbenennen|erstelle|schreib|losche|loschen|meine|meiner|diese|nach monat|nach jahr|mit ihrem|ordner|rechnungen|vertrage`)],
  ["es", latin(String.raw`ordena|organiza|renombra|haz|hazme|crea|borra|elimina|mis|estos|estas|por mes|por ano|con su|carpeta|facturas|contratos|tabla`)],
  ["it", latin(String.raw`ordina|riordina|organizza|rinomina|fammi|crea|cancella|elimina|i miei|le mie|questi|queste|per mese|per anno|con la loro|cartella|fatture|contratti|scansioni|tabella`)],
  ["pt", latin(String.raw`organize|ordene|renomeie|faca|crie|apague|exclua|meus|minhas|estes|estas|por mes|com a data|pasta|faturas|contratos|planilha`)],
  ["nl", latin(String.raw`sorteer|orden|hernoem|maak|schrijf|verwijder|mijn|deze|per maand|per jaar|met hun|map|facturen|contracten|tabel`)],
];

export function requestLanguage(message: string): string | null {
  const text = fold(message);
  if (CJK.test(text)) return null;
  const scores = REQUEST_WORDS.map(([language, pattern]) => [language, (text.match(new RegExp(pattern.source, "gu")) ?? []).length] as const).sort((a, b) => b[1] - a[1]);
  return scores[0]![1] > 0 && scores[0]![1] > scores[1]![1] ? scores[0]![0] : null;
}
