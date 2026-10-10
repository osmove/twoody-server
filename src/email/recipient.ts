import { sqlite } from "../db.js";
import { aliasesOf, kinLabels, listEntities, memoryIdsOf, normaliseName, relationsOf, selfOf } from "../memory/entities.js";
import type { PersonalContact } from "../personalContext.js";
import { cleanAddress } from "./parse.js";
import { correspondentsNamed } from "./store.js";

// Whom « Dis à maman que… » goes to (10/10/2026). Told « oui » to « Voulez-
// vous que je rédige un e-mail à maman… ? », Qwen3.5 9B asked for Mum's
// address in ja, zh, it, ko and en although the person's Memories held it
// in French (« Ma mère s'appelle Nadine Douieb ; son e-mail : … »): it did
// not link « ママ », « mamma », « 엄마 », « Mom » to « ma mère » (bench
// agenda-mail of 10/10/2026: a draft to her address 14 times in 30).
// The server links them: the words for a relative in the ten languages of
// the app, the person's own entity graph (« mère » from them to Nadine),
// the memories that say the relative or the name with an address, their
// contacts and their e-mails' correspondents by that name. One address:
// the draft goes there. None or several: the model asks — never one made up.

/// A relative as the person may call them, in the app's ten languages:
/// what a recipient is matched on (accents and case folded) and what a
/// memory names them by. `owned`: only after « my », « his »… (« fille »,
/// « man », « Frau », « chef » say other things alone). `label`: a label of
/// the memory's kinship lexicon (entities.ts), whose relations count too.
interface Relative {
  key: string;
  label: string;
  words: string[];
  owned?: string[];
  /// Japanese, Chinese, Korean: found inside the text, not after these.
  cjk: string[];
}

const RELATIVES: Relative[] = [
  { key: "mother", label: "mère",
    words: ["maman", "mom", "mum", "mommy", "mummy", "mama", "mami", "mutti", "mamá", "mamita", "mamma", "mammina", "mãe", "mamãe", "mainha", "moeder", "moeke", "mams", "mother", "mutter", "madre"],
    owned: ["mère"],
    cjk: ["お母さん", "おかあさん", "お母様", "母さん", "母親", "ママ", "おふくろ", "お袋", "妈妈", "我妈", "老妈", "母亲", "媽媽", "我媽", "老媽", "母親", "엄마", "어머니", "어머님", "어무니"] },
  { key: "father", label: "père",
    words: ["papa", "dad", "daddy", "vati", "papá", "babbo", "papà", "pai", "papai", "painho", "vader", "father", "vater", "padre", "pa"],
    owned: ["père"],
    cjk: ["お父さん", "おとうさん", "お父様", "父さん", "父親", "パパ", "親父", "おやじ", "爸爸", "我爸", "老爸", "父亲", "父親", "아빠", "아버지", "아버님"] },
  { key: "sister", label: "sœur",
    words: ["sister", "schwester", "hermana", "sorella", "irmã", "zus", "zusje", "zuster"],
    owned: ["sœur", "soeur", "sis"],
    cjk: ["お姉さん", "お姉ちゃん", "姉さん", "姉ちゃん", "妹さん", "姐姐", "妹妹", "언니", "누나", "여동생"] },
  { key: "brother", label: "frère",
    words: ["brother", "bruder", "hermano", "fratello", "irmão", "broer", "broertje"],
    owned: ["frère", "bro"],
    cjk: ["お兄さん", "お兄ちゃん", "兄さん", "兄貴", "弟さん", "哥哥", "弟弟", "오빠", "형", "남동생"] },
  { key: "wife", label: "femme",
    words: ["wife", "ehefrau", "esposa", "moglie", "echtgenote"],
    owned: ["femme", "épouse", "frau", "mujer", "mulher", "vrouw"],
    cjk: ["奥さん", "嫁さん", "家内", "老婆", "妻子", "太太", "아내", "와이프", "집사람"] },
  { key: "husband", label: "mari",
    words: ["husband", "ehemann", "marido", "esposo", "marito", "echtgenoot"],
    owned: ["mari", "époux", "mann", "man"],
    cjk: ["旦那さん", "旦那", "主人", "老公", "丈夫", "남편"] },
  { key: "partner", label: "partner",
    words: ["partner", "partnerin", "conjoint", "conjointe", "compagnon", "compagne", "pareja", "compagno", "compagna", "parceiro", "parceira", "companheiro", "companheira"],
    owned: ["copain", "copine", "freund", "freundin", "novio", "novia", "ragazzo", "ragazza", "namorado", "namorada", "vriend", "vriendin", "boyfriend", "girlfriend"],
    cjk: ["彼氏", "男朋友", "女朋友", "남자친구", "여자친구", "남친", "여친"] },
  { key: "son", label: "fils",
    words: ["sohn", "hijo", "figlio", "filho", "zoon"],
    owned: ["fils", "son"],
    cjk: ["息子", "儿子", "兒子", "아들"] },
  { key: "daughter", label: "fille",
    words: ["daughter", "tochter", "hija", "figlia", "filha", "dochter"],
    owned: ["fille"],
    cjk: ["娘さん", "女儿", "女兒", "딸"] },
  { key: "grandmother", label: "grand-mère",
    words: ["mamie", "grandma", "granny", "grandmother", "oma", "omi", "abuela", "abuelita", "nonna", "vovó", "grootmoeder"],
    owned: ["grand-mère", "nana"],
    cjk: ["おばあちゃん", "おばあさん", "祖母", "奶奶", "外婆", "姥姥", "할머니"] },
  { key: "grandfather", label: "grand-père",
    words: ["papi", "papy", "grandpa", "grandfather", "opa", "opi", "abuelo", "abuelito", "nonno", "vovô", "grootvader"],
    owned: ["grand-père"],
    cjk: ["おじいちゃん", "おじいさん", "祖父", "爷爷", "外公", "姥爷", "할아버지"] },
  { key: "boss", label: "chef",
    words: ["boss", "jefe", "jefa", "capo", "chefe", "baas", "leidinggevende", "vorgesetzter", "vorgesetzte"],
    owned: ["chef", "cheffe", "patron", "patronne", "manager"],
    cjk: ["上司", "部長", "課長", "社長", "老板", "领导", "領導", "사장님", "상사", "팀장님", "부장님"] },
  { key: "uncle", label: "oncle",
    words: ["oncle", "uncle", "onkel", "tío", "zio", "tio", "oom"],
    cjk: ["叔父さん", "伯父さん", "おじさん", "叔叔", "舅舅", "伯伯", "삼촌", "외삼촌"] },
  { key: "aunt", label: "tante",
    words: ["tante", "aunt", "auntie", "tía", "zia", "tia"],
    cjk: ["叔母さん", "伯母さん", "おばさん", "阿姨", "姑姑", "舅妈", "이모", "고모"] },
];

/// « ma », « my », « meine », « 我的 »… before whom: dropped from what was
/// said; in a memory, what makes « fille » a daughter. Third persons too: a
/// memory says « Sa mère s'appelle Nadine » of the person.
const OWNERS = new Set([
  "ma", "mon", "mes", "notre", "nos", "sa", "son", "ses", "leur", "leurs", "ta", "ton", "tes", "votre", "vos",
  "my", "our", "his", "her", "their", "your",
  "meine", "meiner", "meinem", "meinen", "mein", "unsere", "unserer", "unserem", "unseren", "unser", "seine", "seiner", "seinem", "seinen", "sein", "ihre", "ihrer", "ihrem", "ihren", "ihr", "deine", "deiner", "deinem", "deinen", "dein",
  "mi", "mis", "nuestra", "nuestro", "nuestras", "nuestros", "su", "sus", "tu", "tus",
  "mia", "mio", "mie", "miei", "nostra", "nostro", "sua", "suo", "tua", "tuo",
  "minha", "meu", "minhas", "meus", "nossa", "nosso", "seu", "teu",
  "mijn", "onze", "ons", "zijn", "haar", "hun", "je", "jouw",
].map(normaliseName));
/// Articles that may come before whom (« la mamma », « o Paul »).
const ARTICLES = new Set(["la", "le", "l", "les", "the", "der", "die", "dem", "den", "das", "el", "los", "las", "il", "lo", "gli", "o", "a", "os", "as", "de", "het"].map(normaliseName));
/// A relative word that is someone else's relative: « grand-mère », « belle-mère »,
/// « stepmother » said apart, « Schwieger… », « mother-in-law », « la mère de Paul ».
const NOT_BEFORE = new Set(["grand", "grands", "arriere", "belle", "beau", "step", "great", "god", "half", "demi", "schwieger", "suegra", "s"]);
const NOT_AFTER = new Set(["in", "de", "d", "du", "des", "of", "von", "vom", "der", "del", "della", "dello", "di", "do", "da", "dos", "das", "van"]);
/// …and in Japanese, Chinese, Korean: « 祖母 », « 義母 », « 婆婆 », « 시어머니 ».
const CJK_NOT_BEFORE = "祖義继繼後后岳叔伯姑舅外養乳保父婆公시장새양의붓";

const WORD_TO_RELATIVE = (() => {
  const map = new Map<string, { relative: Relative; owned: boolean }>();
  for (const relative of RELATIVES) {
    for (const word of relative.words) map.set(normaliseName(word), { relative, owned: false });
    for (const word of relative.owned ?? []) if (!map.has(normaliseName(word))) map.set(normaliseName(word), { relative, owned: true });
  }
  return map;
})();

const CJK_PREFIX = /^(?:我的|我|私の|わたしの|僕の|ぼくの|俺の|うちの|내|우리|제|저희)\s*/u;
const HONORIFIC = /(?:さん|ちゃん|くん|君|様|さま|先生|氏|씨|님|께서)$/u;
const TITLES = new Set(["m", "mme", "mlle", "monsieur", "madame", "maitre", "me", "dr", "docteur", "mr", "mrs", "ms", "miss", "herr", "frau", "senor", "senora", "sr", "sra", "signor", "signora", "sig", "dott", "senhor", "senhora", "dona", "meneer", "mevrouw", "dhr", "mevr"]);

/// Which relative a recipient as said is (« Mama », « ma mère », « ママ »,
/// « 我妈 », « 어머니 »), or null for a name.
export function relativeIn(said: string): Relative | null {
  const trimmed = said.trim();
  // « お母さん » is the word itself; « 部長さん », « 엄마님 » carry an honorific.
  const forms = [trimmed, trimmed.replace(HONORIFIC, "")].flatMap((form) => [form, form.replace(CJK_PREFIX, "")]);
  for (const relative of RELATIVES) if (forms.some((form) => relative.cjk.includes(form))) return relative;
  // Japanese « 母 », « 父 » alone: said of one's own.
  if (forms.includes("母")) return RELATIVES.find((one) => one.key === "mother")!;
  if (forms.includes("父")) return RELATIVES.find((one) => one.key === "father")!;
  const words = normaliseName(said).split(" ").filter(Boolean);
  let owned = false;
  while (words.length > 1 && (OWNERS.has(words[0]!) || ARTICLES.has(words[0]!))) {
    if (OWNERS.has(words[0]!)) owned = true;
    words.shift();
  }
  const found = WORD_TO_RELATIVE.get(words.join(" "));
  if (!found) return null;
  // « fille », « Frau », « man » alone say other things; « au patron », « the boss » do not.
  return found.owned && !owned && !["chef", "cheffe", "patron", "patronne", "manager"].includes(words[0]!) ? null : found.relative;
}

/// The words a relative's relation may be labelled with (« mère »,
/// « mother », « Mutter », « お母さん »…), folded.
function relationLabels(relative: Relative): Set<string> {
  return new Set([...kinLabels(relative.label), ...relative.words.map(normaliseName), ...(relative.owned ?? []).map(normaliseName), ...relative.cjk]);
}

/// A text names this relative: a word for them on its own (« maman »,
/// « ma mère », « 엄마 ») — never a grand-mother, a mother-in-law, someone
/// else's mother.
function mentionsRelative(text: string, relative: Relative): boolean {
  const tokens = normaliseName(text).split(" ").filter(Boolean);
  const singles = new Set(relative.words.map(normaliseName));
  const owned = new Set((relative.owned ?? []).map(normaliseName));
  const all = [...singles, ...owned];
  for (let index = 0; index < tokens.length; index++) {
    for (const word of all) {
      const parts = word.split(" ");
      if (parts.some((part, offset) => tokens[index + offset] !== part)) continue;
      const before = tokens[index - 1];
      const after = tokens[index + parts.length];
      if (before && NOT_BEFORE.has(before)) continue;
      if (after && NOT_AFTER.has(after)) continue;
      if (!singles.has(word) && !(before && OWNERS.has(before))) continue;
      return true;
    }
  }
  // One character is too little inside a text (« 딸기 » is a strawberry);
  // but Japanese « 母の… », « 父は… », not « 母校 », « 父兄 ».
  if (relative.key === "mother" || relative.key === "father") {
    const one = relative.key === "mother" ? "母" : "父";
    if (new RegExp(`(?<![${CJK_NOT_BEFORE}母父])${one}(?=[のはがにもへ、と])`, "u").test(text)) return true;
  }
  return relative.cjk.some((word) => word.length >= 2 && new RegExp(`(?<![${CJK_NOT_BEFORE}])${word}`, "u").test(text));
}

const ADDRESS_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/// The e-mail addresses a text holds, cleaned.
export function addressesIn(text: string): string[] {
  return [...new Set((text.match(ADDRESS_IN_TEXT) ?? []).map((one) => cleanAddress(one)).filter((one): one is string => !!one))];
}

/// The addresses a memory gives for whom it names: its only one, else the
/// ones in the sentences that name them (« Ma mère : a@… ; mon père : b@… »).
function addressesFor(text: string, names: (sentence: string) => boolean): string[] {
  const all = addressesIn(text);
  if (all.length <= 1) return all;
  const near = text.split(/(?<=[!?。！？;；\n])|(?<=\.)\s+/u).filter(names).flatMap(addressesIn);
  return near.length ? [...new Set(near)] : all;
}

/// The names a memory gives in capitals (« Ma mère s'appelle Nadine
/// Douieb » → « Nadine Douieb »), not the first word of a sentence, nor
/// a relative's word (« Maman a… »).
function capitalisedNames(text: string): string[] {
  const out: string[] = [];
  for (const found of text.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{Ll}'’-]+(?:[ -]\p{Lu}[\p{Ll}'’-]+)*/gu)) {
    const before = text.slice(0, found.index).trimEnd();
    if (!before || /[.!?:;\n]$/.test(before)) continue;
    const name = found[0];
    if (relativeIn(name) || normaliseName(name).split(" ").every((word) => OWNERS.has(word) || ARTICLES.has(word) || TITLES.has(word))) continue;
    out.push(name);
  }
  return out.slice(0, 4);
}

export interface RecipientCandidate {
  address: string;
  name: string | null;
  /// Where it was found: « Memories », « Contacts », « e-mails ».
  from: string[];
}

export interface RecipientResolution {
  /// Whom the person named, as said.
  said: string;
  /// The relative it is (« mother »), or null for a name.
  relative: string | null;
  /// The person's names found on the way (« Nadine Douieb »).
  names: string[];
  candidates: RecipientCandidate[];
}

export interface EntityView {
  name: string;
  aliases: string[];
  note: string | null;
  /// The labels of the relations from the person to it (« mère »).
  labels: string[];
  /// The memories linked to it.
  memories: string[];
}

export interface RecipientSources {
  memories: Array<{ title?: string | null; content: string; archived?: boolean }>;
  contacts: PersonalContact[];
  entities: EntityView[];
  /// The addresses the person's e-mails show for these names.
  correspondents: (names: string[]) => Array<{ name: string | null; address: string }>;
}

const SAME = (a: string, b: string) => normaliseName(a) === normaliseName(b);
/// A name of at least two words, or of two CJK characters, found in a text.
function nameIn(name: string, text: string): boolean {
  const norm = normaliseName(name);
  if (!norm) return false;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(norm)) return norm.replace(/\s+/g, "").length >= 2 && normaliseName(text).replace(/\s+/g, "").includes(norm.replace(/\s+/g, ""));
  return ` ${normaliseName(text)} `.includes(` ${norm} `);
}

function contactName(contact: PersonalContact): string | null {
  return contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null;
}

/// Whom « maman », « Mama », « ママ », « Paul » is, and their addresses,
/// from the person's data only. Several distinct addresses are all given:
/// the model asks which.
export function resolveRecipient(said: string, sources: RecipientSources): RecipientResolution {
  const relative = relativeIn(said);
  const found = new Map<string, RecipientCandidate>();
  const add = (address: string | null, name: string | null, from: string) => {
    const clean = address ? cleanAddress(address) : null;
    if (!clean) return;
    const key = clean.toLowerCase();
    const known = found.get(key);
    if (known) {
      if (!known.from.includes(from)) known.from.push(from);
      known.name ??= name;
    } else found.set(key, { address: clean, name, from: [from] });
  };
  const names = new Set<string>();
  const memories = sources.memories.filter((memory) => !memory.archived).map((memory) => `${memory.title ?? ""}\n${memory.content}`.trim());

  if (relative) {
    const labels = relationLabels(relative);
    // The graph: the person's relation to them, or an alias that is the word said.
    for (const entity of sources.entities) {
      const related = entity.labels.some((label) => labels.has(normaliseName(label)) || labels.has(label.trim()));
      const called = [entity.name, ...entity.aliases].some((alias) => SAME(alias, said) || relativeIn(alias)?.key === relative.key);
      if (!related && !called) continue;
      names.add(entity.name);
      for (const alias of entity.aliases) if (!relativeIn(alias)) names.add(alias);
      for (const address of addressesIn(entity.note ?? "")) add(address, entity.name, "Memories");
      for (const text of entity.memories) for (const address of addressesFor(text, (sentence) => mentionsRelative(sentence, relative) || [entity.name, ...entity.aliases].some((alias) => nameIn(alias, sentence)))) add(address, entity.name, "Memories");
    }
    // The memories that say the relative: their addresses, and the names
    // they give them (a contact's, an entity's).
    for (const text of memories) {
      if (!mentionsRelative(text, relative)) continue;
      const named = [...new Set([
        ...sources.contacts.map(contactName).filter((name): name is string => !!name && normaliseName(name).includes(" ") && nameIn(name, text)),
        ...sources.entities.map((entity) => entity.name).filter((name) => nameIn(name, text)),
        ...capitalisedNames(text),
      ])];
      named.forEach((name) => names.add(name));
      for (const address of addressesFor(text, (sentence) => mentionsRelative(sentence, relative))) add(address, named[0] ?? null, "Memories");
    }
    // A contact card called « Maman », « Mom », « お母さん », or by a name
    // the graph or a memory gives them.
    for (const contact of sources.contacts) {
      const name = contactName(contact);
      if (name && (relativeIn(name)?.key === relative.key || [...names].some((known) => SAME(known, name)))) contact.emails.forEach((address) => add(address, name, "Contacts"));
    }
  } else {
    // A name: « Paul », « Maître Dupont », « Paulさん ».
    const plain = said.trim().replace(HONORIFIC, "");
    const words = normaliseName(plain).split(" ").filter((word) => word && !TITLES.has(word) && !ARTICLES.has(word) && !OWNERS.has(word));
    if (!words.length) return { said, relative: null, names: [], candidates: [] };
    const wanted = words.join(" ");
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(wanted);
    const matches = (name: string) => {
      const norm = normaliseName(name);
      if (cjk) return norm.replace(/\s+/g, "").includes(wanted.replace(/\s+/g, ""));
      const theirs = norm.split(" ");
      return words.every((word) => theirs.includes(word));
    };
    for (const contact of sources.contacts) {
      const name = contactName(contact);
      if (name && matches(name)) {
        names.add(name);
        contact.emails.forEach((address) => add(address, name, "Contacts"));
      }
    }
    for (const entity of sources.entities) {
      if (![entity.name, ...entity.aliases].some(matches)) continue;
      names.add(entity.name);
      for (const address of addressesIn(entity.note ?? "")) add(address, entity.name, "Memories");
      for (const text of entity.memories) for (const address of addressesFor(text, (sentence) => [entity.name, ...entity.aliases].some((alias) => matches(alias) && nameIn(alias, sentence)) || nameIn(plain, sentence))) add(address, entity.name, "Memories");
    }
    for (const text of memories) {
      if (!nameIn(plain, text) && !(words.length === 1 && ` ${normaliseName(text)} `.includes(` ${wanted} `))) continue;
      for (const address of addressesFor(text, (sentence) => ` ${normaliseName(sentence)} `.includes(` ${wanted} `))) add(address, plain, "Memories");
    }
    names.add(plain);
  }
  // Whom the person's e-mails show by those names (« Nadine Douieb »).
  const asked = [...names].filter((name) => normaliseName(name));
  if (asked.length) for (const one of sources.correspondents(asked).slice(0, 6)) add(one.address, one.name, "e-mails");
  return { said, relative: relative?.key ?? null, names: [...names].filter((name) => !SAME(name, said)), candidates: [...found.values()] };
}

/// The person's entities as resolveRecipient reads them: each one's names,
/// note, the labels of the relations from the person to it, its memories.
export function entityViews(userId: string, memoryText: (id: string) => string | null): EntityView[] {
  const self = selfOf(userId);
  const labels = new Map<string, string[]>();
  if (self) for (const relation of relationsOf(self.id)) labels.set(relation.to, [...(labels.get(relation.to) ?? []), relation.label]);
  return listEntities(userId)
    .filter((entity) => entity.kind === "person" || entity.kind === "other" || labels.has(entity.id))
    .slice(0, 500)
    .map((entity) => ({
      name: entity.name,
      aliases: aliasesOf(entity.id),
      note: entity.note,
      labels: labels.get(entity.id) ?? [],
      memories: memoryIdsOf(entity.id).slice(0, 40).map(memoryText).filter((text): text is string => !!text),
    }));
}

/// resolveRecipient on this person's data: their memories (when the turn
/// uses them), contacts, entity graph and e-mails.
export function recipientFor(userId: string, said: string, data: { memories: RecipientSources["memories"] | null; contacts: PersonalContact[] }): RecipientResolution {
  const useMemories = data.memories !== null;
  const memoryText = (id: string) => {
    const row = sqlite.prepare("SELECT title, content, tags FROM memories WHERE id = ? AND user_id = ? AND superseded_by_id IS NULL").get(id, userId) as { title: string | null; content: string; tags: string } | undefined;
    return row && !row.tags.includes("\"archive\"") ? `${row.title ?? ""}\n${row.content}`.trim() : null;
  };
  return resolveRecipient(said, {
    memories: data.memories ?? [],
    contacts: data.contacts,
    entities: useMemories ? entityViews(userId, memoryText) : [],
    correspondents: (names) => correspondentsNamed(userId, names),
  });
}

/// What the « yes » turn is told of whom the e-mail goes to.
export function recipientBlock(resolution: RecipientResolution): string {
  const whom = `« ${resolution.said.replace(/[«»\[\]\n]/g, " ").trim().slice(0, 80)} »`;
  const one = (candidate: RecipientCandidate) => `${candidate.name ? `${candidate.name.replace(/[«»\[\]<>\n]/g, " ").trim().slice(0, 80)} ` : ""}<${candidate.address}> (from the user's ${candidate.from.join(" and ")})`;
  if (resolution.candidates.length === 1) {
    const [only] = resolution.candidates;
    return `[Whom the user named, ${whom}: ${one(only!)}. Call draft_email with to: "${only!.address}" — do not ask them for the address.]`;
  }
  if (resolution.candidates.length > 1) {
    return `[${whom} may be ${resolution.candidates.slice(0, 5).map(one).join("; or ")}. Ask the user, in one short question in their language, which address to write to; call draft_email only once they said. Never pick one yourself.]`;
  }
  return `[No e-mail address for ${whom} in the user's Memories, Contacts or e-mails${resolution.names.length ? ` (known as ${resolution.names.slice(0, 3).join(", ")})` : ""}. Ask them for the address, in one short question in their language; never make one up, and do not call draft_email before they give it.]`;
}
