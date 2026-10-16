// The relations a person may have with the people of their life, and how
// they are said in the app's ten languages (docs/people-design.md §4).
//
// A relation has a fixed kind (« mother », « colleague »…) and a free label
// (the person's own word, « maman », « Schwiegermama »). The kinds are what
// the server reasons with; the words below are how a message or a memory
// says them — « ma mère », « my mum », « meine Mutter », « mi madre »,
// « mia mamma », « minha mãe », « mijn moeder », « 母 », « 我妈妈 »,
// « 우리 엄마 » — and whether it is the person's own relative or someone
// else's (« la mère de Paul », « Pauls Mutter », « 友達の母 », « 친구의 엄마 »).
//
// Latin scripts are read word by word on the folded text (accents, case and
// punctuation aside, entities.ts normaliseName); Japanese, Chinese and
// Korean on the text itself, a word found inside it (they are not written
// with spaces, and Korean glues its particles to the word).

export const RELATION_KINDS = [
  "mother", "father", "parent", "son", "daughter", "child", "sister", "brother", "sibling",
  "wife", "husband", "spouse", "partner",
  "grandmother", "grandfather", "grandparent", "grandson", "granddaughter", "grandchild",
  "aunt", "uncle", "niece", "nephew", "cousin",
  "mother_in_law", "father_in_law", "sister_in_law", "brother_in_law", "son_in_law", "daughter_in_law",
  "godparent", "godchild", "relative",
  "friend", "colleague", "manager", "employee", "client", "neighbour", "doctor", "other",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const LANGUAGES = ["en", "fr", "de", "es", "it", "pt", "nl", "ja", "zh", "ko"] as const;
export type Language = (typeof LANGUAGES)[number];

export type KindGroup = "family" | "couple" | "friends" | "work" | "other";

export const KIND_GROUP: Record<RelationKind, KindGroup> = {
  mother: "family", father: "family", parent: "family", son: "family", daughter: "family", child: "family",
  sister: "family", brother: "family", sibling: "family",
  wife: "couple", husband: "couple", spouse: "couple", partner: "couple",
  grandmother: "family", grandfather: "family", grandparent: "family", grandson: "family", granddaughter: "family", grandchild: "family",
  aunt: "family", uncle: "family", niece: "family", nephew: "family", cousin: "family",
  mother_in_law: "family", father_in_law: "family", sister_in_law: "family", brother_in_law: "family", son_in_law: "family", daughter_in_law: "family",
  godparent: "family", godchild: "family", relative: "family",
  friend: "friends", colleague: "work", manager: "work", employee: "work", client: "work", neighbour: "other", doctor: "other", other: "other",
};

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === "string" && (RELATION_KINDS as readonly string[]).includes(value);
}

/// Each kind's word in each language: the label a relation gets when the
/// person picks the kind without writing one, and how the app names it.
export const KIND_WORDS: Record<RelationKind, Record<Language, string>> = {
  mother: { en: "mother", fr: "mère", de: "Mutter", es: "madre", it: "madre", pt: "mãe", nl: "moeder", ja: "母", zh: "母亲", ko: "어머니" },
  father: { en: "father", fr: "père", de: "Vater", es: "padre", it: "padre", pt: "pai", nl: "vader", ja: "父", zh: "父亲", ko: "아버지" },
  parent: { en: "parent", fr: "parent", de: "Elternteil", es: "padre o madre", it: "genitore", pt: "pai ou mãe", nl: "ouder", ja: "親", zh: "父母", ko: "부모" },
  son: { en: "son", fr: "fils", de: "Sohn", es: "hijo", it: "figlio", pt: "filho", nl: "zoon", ja: "息子", zh: "儿子", ko: "아들" },
  daughter: { en: "daughter", fr: "fille", de: "Tochter", es: "hija", it: "figlia", pt: "filha", nl: "dochter", ja: "娘", zh: "女儿", ko: "딸" },
  child: { en: "child", fr: "enfant", de: "Kind", es: "hijo o hija", it: "figlio o figlia", pt: "filho ou filha", nl: "kind", ja: "子ども", zh: "孩子", ko: "자녀" },
  sister: { en: "sister", fr: "sœur", de: "Schwester", es: "hermana", it: "sorella", pt: "irmã", nl: "zus", ja: "姉妹", zh: "姐妹", ko: "자매" },
  brother: { en: "brother", fr: "frère", de: "Bruder", es: "hermano", it: "fratello", pt: "irmão", nl: "broer", ja: "兄弟", zh: "兄弟", ko: "형제" },
  sibling: { en: "sibling", fr: "frère ou sœur", de: "Geschwister", es: "hermano o hermana", it: "fratello o sorella", pt: "irmão ou irmã", nl: "broer of zus", ja: "きょうだい", zh: "兄弟姐妹", ko: "형제자매" },
  wife: { en: "wife", fr: "épouse", de: "Ehefrau", es: "esposa", it: "moglie", pt: "esposa", nl: "echtgenote", ja: "妻", zh: "妻子", ko: "아내" },
  husband: { en: "husband", fr: "mari", de: "Ehemann", es: "marido", it: "marito", pt: "marido", nl: "echtgenoot", ja: "夫", zh: "丈夫", ko: "남편" },
  spouse: { en: "spouse", fr: "conjoint", de: "Ehepartner", es: "cónyuge", it: "coniuge", pt: "cônjuge", nl: "echtgenoot of echtgenote", ja: "配偶者", zh: "配偶", ko: "배우자" },
  partner: { en: "partner", fr: "compagnon ou compagne", de: "Partner", es: "pareja", it: "partner", pt: "companheiro ou companheira", nl: "partner", ja: "パートナー", zh: "伴侣", ko: "연인" },
  grandmother: { en: "grandmother", fr: "grand-mère", de: "Großmutter", es: "abuela", it: "nonna", pt: "avó", nl: "grootmoeder", ja: "祖母", zh: "祖母", ko: "할머니" },
  grandfather: { en: "grandfather", fr: "grand-père", de: "Großvater", es: "abuelo", it: "nonno", pt: "avô", nl: "grootvader", ja: "祖父", zh: "祖父", ko: "할아버지" },
  grandparent: { en: "grandparent", fr: "grand-parent", de: "Großelternteil", es: "abuelo o abuela", it: "nonno o nonna", pt: "avô ou avó", nl: "grootouder", ja: "祖父母", zh: "祖父母", ko: "조부모" },
  grandson: { en: "grandson", fr: "petit-fils", de: "Enkel", es: "nieto", it: "nipote", pt: "neto", nl: "kleinzoon", ja: "孫息子", zh: "孙子", ko: "손자" },
  granddaughter: { en: "granddaughter", fr: "petite-fille", de: "Enkelin", es: "nieta", it: "nipote", pt: "neta", nl: "kleindochter", ja: "孫娘", zh: "孙女", ko: "손녀" },
  grandchild: { en: "grandchild", fr: "petit-enfant", de: "Enkelkind", es: "nieto o nieta", it: "nipote", pt: "neto ou neta", nl: "kleinkind", ja: "孫", zh: "孙辈", ko: "손주" },
  aunt: { en: "aunt", fr: "tante", de: "Tante", es: "tía", it: "zia", pt: "tia", nl: "tante", ja: "おば", zh: "阿姨", ko: "이모·고모" },
  uncle: { en: "uncle", fr: "oncle", de: "Onkel", es: "tío", it: "zio", pt: "tio", nl: "oom", ja: "おじ", zh: "叔叔", ko: "삼촌" },
  niece: { en: "niece", fr: "nièce", de: "Nichte", es: "sobrina", it: "nipote", pt: "sobrinha", nl: "nicht", ja: "姪", zh: "侄女", ko: "조카딸" },
  nephew: { en: "nephew", fr: "neveu", de: "Neffe", es: "sobrino", it: "nipote", pt: "sobrinho", nl: "neef", ja: "甥", zh: "侄子", ko: "조카" },
  cousin: { en: "cousin", fr: "cousin", de: "Cousin", es: "primo", it: "cugino", pt: "primo", nl: "neef of nicht", ja: "いとこ", zh: "表亲", ko: "사촌" },
  mother_in_law: { en: "mother-in-law", fr: "belle-mère", de: "Schwiegermutter", es: "suegra", it: "suocera", pt: "sogra", nl: "schoonmoeder", ja: "義母", zh: "岳母或婆婆", ko: "장모·시어머니" },
  father_in_law: { en: "father-in-law", fr: "beau-père", de: "Schwiegervater", es: "suegro", it: "suocero", pt: "sogro", nl: "schoonvader", ja: "義父", zh: "岳父或公公", ko: "장인·시아버지" },
  sister_in_law: { en: "sister-in-law", fr: "belle-sœur", de: "Schwägerin", es: "cuñada", it: "cognata", pt: "cunhada", nl: "schoonzus", ja: "義理の姉妹", zh: "嫂子或小姑", ko: "시누이·올케" },
  brother_in_law: { en: "brother-in-law", fr: "beau-frère", de: "Schwager", es: "cuñado", it: "cognato", pt: "cunhado", nl: "zwager", ja: "義理の兄弟", zh: "姐夫或小舅子", ko: "매형·처남" },
  son_in_law: { en: "son-in-law", fr: "gendre", de: "Schwiegersohn", es: "yerno", it: "genero", pt: "genro", nl: "schoonzoon", ja: "義理の息子", zh: "女婿", ko: "사위" },
  daughter_in_law: { en: "daughter-in-law", fr: "belle-fille", de: "Schwiegertochter", es: "nuera", it: "nuora", pt: "nora", nl: "schoondochter", ja: "義理の娘", zh: "儿媳", ko: "며느리" },
  godparent: { en: "godparent", fr: "parrain ou marraine", de: "Pate oder Patin", es: "padrino o madrina", it: "padrino o madrina", pt: "padrinho ou madrinha", nl: "peetouder", ja: "代父母", zh: "教父或教母", ko: "대부모" },
  godchild: { en: "godchild", fr: "filleul ou filleule", de: "Patenkind", es: "ahijado o ahijada", it: "figlioccio o figlioccia", pt: "afilhado ou afilhada", nl: "petekind", ja: "代子", zh: "教子", ko: "대자녀" },
  relative: { en: "relative", fr: "membre de la famille", de: "Verwandte", es: "familiar", it: "parente", pt: "parente", nl: "familielid", ja: "親戚", zh: "亲戚", ko: "친척" },
  friend: { en: "friend", fr: "ami", de: "Freund", es: "amigo", it: "amico", pt: "amigo", nl: "vriend", ja: "友人", zh: "朋友", ko: "친구" },
  colleague: { en: "colleague", fr: "collègue", de: "Kollege", es: "colega", it: "collega", pt: "colega", nl: "collega", ja: "同僚", zh: "同事", ko: "동료" },
  manager: { en: "manager", fr: "supérieur", de: "Vorgesetzter", es: "jefe", it: "responsabile", pt: "chefe", nl: "leidinggevende", ja: "上司", zh: "上司", ko: "상사" },
  employee: { en: "employee", fr: "collaborateur", de: "Mitarbeiter", es: "empleado", it: "dipendente", pt: "funcionário", nl: "medewerker", ja: "部下", zh: "下属", ko: "부하 직원" },
  client: { en: "client", fr: "client", de: "Kunde", es: "cliente", it: "cliente", pt: "cliente", nl: "klant", ja: "顧客", zh: "客户", ko: "고객" },
  neighbour: { en: "neighbour", fr: "voisin", de: "Nachbar", es: "vecino", it: "vicino", pt: "vizinho", nl: "buur", ja: "隣人", zh: "邻居", ko: "이웃" },
  doctor: { en: "doctor", fr: "médecin", de: "Arzt", es: "médico", it: "medico", pt: "médico", nl: "arts", ja: "医師", zh: "医生", ko: "의사" },
  other: { en: "other", fr: "autre", de: "Sonstige", es: "otro", it: "altro", pt: "outro", nl: "anders", ja: "その他", zh: "其他", ko: "기타" },
};

/// The word for a kind in a language (English when the language is none of
/// the ten).
export function kindWord(kind: RelationKind, language: string | null | undefined): string {
  const code = (language ?? "en").split(/[-_]/)[0]!.toLowerCase() as Language;
  return KIND_WORDS[kind][(LANGUAGES as readonly string[]).includes(code) ? code : "en"];
}

/// The wider kinds a kind is one of: a sister is a sibling and a relative.
const WIDER: Partial<Record<RelationKind, RelationKind[]>> = {
  mother: ["parent"], father: ["parent"], son: ["child"], daughter: ["child"], sister: ["sibling"], brother: ["sibling"],
  wife: ["spouse", "partner"], husband: ["spouse", "partner"], spouse: ["partner"],
  grandmother: ["grandparent"], grandfather: ["grandparent"], grandson: ["grandchild"], granddaughter: ["grandchild"],
};

/// Whether two kinds can say the same relation (one is the other, or wider):
/// « sibling » and « sister », « relative » and any family kind.
export function compatibleKinds(a: RelationKind, b: RelationKind): boolean {
  if (a === b) return true;
  if (WIDER[a]?.includes(b) || WIDER[b]?.includes(a)) return true;
  if ((a === "relative" && KIND_GROUP[b] === "family") || (b === "relative" && KIND_GROUP[a] === "family")) return true;
  return false;
}

/// Of two compatible kinds, the narrower (« sister » rather than « sibling »).
export function narrower(a: RelationKind, b: RelationKind): RelationKind {
  if (a === b) return a;
  if (WIDER[a]?.includes(b) || b === "relative") return a;
  return b;
}

// ── The words, language by language ─────────────────────────────────────
// [kinds, words that need « my »/« our » before them, words that say one's
// own alone]. Latin words are folded at build time (« Großmutter » →
// « grossmutter » is not done: ß stays, folded on both sides alike).

type Entry = [RelationKind | RelationKind[], string[], string[]?];

interface LatinLexicon {
  /// « my », « our »: what makes a relative the person's own.
  owners: string[];
  entries: Entry[];
}

const LATIN: Record<"en" | "fr" | "de" | "es" | "it" | "pt" | "nl", LatinLexicon> = {
  en: {
    owners: ["my", "our"],
    entries: [
      ["mother", ["mother", "mom", "mum", "mommy", "mummy", "mama"], ["mom", "mum", "mommy", "mummy"]],
      ["father", ["father", "dad", "daddy", "papa"], ["dad", "daddy"]],
      ["parent", ["parents", "parent", "folks"]],
      ["son", ["son"]], ["daughter", ["daughter"]], ["child", ["children", "kids", "kid", "child"]],
      ["sister", ["sister", "sis", "little sister", "big sister", "older sister", "younger sister"]],
      ["brother", ["brother", "bro", "little brother", "big brother", "older brother", "younger brother"]],
      ["sibling", ["siblings", "sibling"]],
      ["wife", ["wife"]], ["husband", ["husband"]], ["spouse", ["spouse"]],
      ["partner", ["partner", "boyfriend", "girlfriend", "fiance", "fiancee"]],
      ["grandmother", ["grandmother", "grandma", "granny", "nana", "gran"], ["grandma", "granny"]],
      ["grandfather", ["grandfather", "grandpa", "granddad", "grandad"], ["grandpa"]],
      ["grandparent", ["grandparents"]], ["grandson", ["grandson"]], ["granddaughter", ["granddaughter"]], ["grandchild", ["grandchildren", "grandkids", "grandchild"]],
      ["aunt", ["aunt", "auntie"]], ["uncle", ["uncle"]], ["niece", ["niece"]], ["nephew", ["nephew"]], ["cousin", ["cousin", "cousins"]],
      ["mother_in_law", ["mother in law"]], ["father_in_law", ["father in law"]], ["sister_in_law", ["sister in law"]], ["brother_in_law", ["brother in law"]],
      ["son_in_law", ["son in law"]], ["daughter_in_law", ["daughter in law"]],
      ["godparent", ["godmother", "godfather"]], ["godchild", ["godson", "goddaughter", "godchild"]],
      ["relative", ["relative", "relatives", "family"]],
      ["friend", ["friend", "best friend", "friends", "buddy", "pal", "mate"]],
      ["colleague", ["colleague", "coworker", "co worker", "colleagues", "coworkers"]],
      ["manager", ["boss", "manager", "supervisor"]], ["employee", ["assistant", "employee", "report"]],
      ["client", ["client", "customer"]], ["neighbour", ["neighbour", "neighbor"]], ["doctor", ["doctor", "gp"]],
    ],
  },
  fr: {
    owners: ["ma", "mon", "mes", "notre", "nos"],
    entries: [
      ["mother", ["mère", "maman", "mère"], ["maman"]],
      ["father", ["père", "papa"], ["papa"]],
      ["parent", ["parents"]],
      ["son", ["fils", "garçon"]], ["daughter", ["fille"]], ["child", ["enfant", "enfants", "gosses", "gamins", "petits"]],
      ["sister", ["sœur", "petite sœur", "grande sœur", "frangine"]],
      ["brother", ["frère", "petit frère", "grand frère", "frangin"]],
      ["sibling", ["frères et sœurs"]],
      ["wife", ["femme", "épouse"]], ["husband", ["mari", "époux"]], ["spouse", ["conjoint", "conjointe"]],
      ["partner", ["compagnon", "compagne", "copain", "copine", "chéri", "chérie", "fiancé", "fiancée", "petit ami", "petite amie"]],
      ["grandmother", ["grand-mère", "mamie", "mémé", "mamy", "grand-maman"], ["mamie", "mémé", "mamy"]],
      ["grandfather", ["grand-père", "papi", "pépé", "papy", "grand-papa"], ["papi", "pépé", "papy"]],
      ["grandparent", ["grands-parents"]], ["grandson", ["petit-fils"]], ["granddaughter", ["petite-fille"]], ["grandchild", ["petits-enfants", "petit-enfant"]],
      ["aunt", ["tante", "tata", "tatie"], ["tata", "tatie"]], ["uncle", ["oncle", "tonton"], ["tonton"]], ["niece", ["nièce"]], ["nephew", ["neveu"]], ["cousin", ["cousin", "cousine", "cousins"]],
      ["mother_in_law", ["belle-mère"]], ["father_in_law", ["beau-père"]], ["sister_in_law", ["belle-sœur"]], ["brother_in_law", ["beau-frère"]],
      ["son_in_law", ["gendre", "beau-fils"]], ["daughter_in_law", ["belle-fille", "bru"]],
      ["godparent", ["parrain", "marraine"]], ["godchild", ["filleul", "filleule"]],
      ["relative", ["famille", "proche"]],
      ["friend", ["ami", "amie", "meilleur ami", "meilleure amie", "pote", "amis", "amies"]],
      ["partner", ["copain", "copine"]], ["friend", ["copain", "copine", "copains", "copines"]],
      ["colleague", ["collègue", "collègues"]],
      ["manager", ["chef", "cheffe", "patron", "patronne", "manager", "supérieur", "supérieure", "n+1", "responsable"]],
      ["employee", ["assistant", "assistante", "employé", "employée", "collaborateur", "collaboratrice", "stagiaire"]],
      ["client", ["client", "cliente"]], ["neighbour", ["voisin", "voisine", "voisins"]], ["doctor", ["médecin", "docteur", "généraliste"]],
    ],
  },
  de: {
    owners: ["mein", "meine", "meinem", "meinen", "meiner", "meines", "unser", "unsere", "unserem", "unseren", "unserer", "unseres"],
    entries: [
      ["mother", ["Mutter", "Mama", "Mami", "Mutti"], ["Mama", "Mami", "Mutti"]],
      ["father", ["Vater", "Papa", "Papi", "Vati"], ["Papa", "Papi", "Vati"]],
      ["parent", ["Eltern"]],
      ["son", ["Sohn"]], ["daughter", ["Tochter"]], ["child", ["Kind", "Kinder", "Kids"]],
      ["sister", ["Schwester", "kleine Schwester", "große Schwester", "ältere Schwester", "jüngere Schwester"]],
      ["brother", ["Bruder", "kleiner Bruder", "großer Bruder", "älterer Bruder", "jüngerer Bruder"]],
      ["sibling", ["Geschwister"]],
      ["wife", ["Frau", "Ehefrau", "Gattin"]], ["husband", ["Mann", "Ehemann", "Gatte"]], ["spouse", ["Ehepartner", "Ehepartnerin"]],
      ["partner", ["Partner", "Partnerin", "Lebensgefährte", "Lebensgefährtin", "Verlobter", "Verlobte"]],
      [["partner", "friend"], ["Freund", "Freundin"]],
      ["grandmother", ["Großmutter", "Oma", "Omi"], ["Oma", "Omi"]],
      ["grandfather", ["Großvater", "Opa", "Opi"], ["Opa", "Opi"]],
      ["grandparent", ["Großeltern"]], ["grandson", ["Enkel", "Enkelsohn"]], ["granddaughter", ["Enkelin", "Enkeltochter"]], ["grandchild", ["Enkelkind", "Enkelkinder", "Enkel"]],
      ["aunt", ["Tante"]], ["uncle", ["Onkel"]], ["niece", ["Nichte"]], ["nephew", ["Neffe"]], ["cousin", ["Cousin", "Cousine", "Kusine", "Vetter"]],
      ["mother_in_law", ["Schwiegermutter", "Schwiegermama"]], ["father_in_law", ["Schwiegervater", "Schwiegerpapa"]],
      ["sister_in_law", ["Schwägerin"]], ["brother_in_law", ["Schwager"]], ["son_in_law", ["Schwiegersohn"]], ["daughter_in_law", ["Schwiegertochter"]],
      ["godparent", ["Patin", "Pate", "Patentante", "Patenonkel"]], ["godchild", ["Patenkind", "Patensohn", "Patentochter"]],
      ["relative", ["Verwandte", "Verwandter", "Familie"]],
      ["friend", ["bester Freund", "beste Freundin", "Freunde", "Kumpel"]],
      ["colleague", ["Kollege", "Kollegin", "Kollegen"]],
      ["manager", ["Chef", "Chefin", "Vorgesetzter", "Vorgesetzte", "Vorgesetzten"]],
      ["employee", ["Mitarbeiter", "Mitarbeiterin", "Assistent", "Assistentin"]],
      ["client", ["Kunde", "Kundin", "Mandant", "Mandantin"]], ["neighbour", ["Nachbar", "Nachbarin"]], ["doctor", ["Arzt", "Ärztin", "Hausarzt", "Hausärztin"]],
    ],
  },
  es: {
    owners: ["mi", "mis", "nuestro", "nuestra", "nuestros", "nuestras"],
    entries: [
      ["mother", ["madre", "mamá", "mami", "mama"], ["mamá", "mami"]],
      ["father", ["padre", "papá", "papi"], ["papá", "papi"]],
      ["parent", ["padres"]],
      ["son", ["hijo"]], ["daughter", ["hija"]], ["child", ["hijos", "niños", "chicos"]],
      ["sister", ["hermana", "hermanita"]], ["brother", ["hermano", "hermanito"]], ["sibling", ["hermanos"]],
      ["wife", ["esposa", "mujer"]], ["husband", ["marido", "esposo"]], ["spouse", ["cónyuge"]],
      ["partner", ["pareja", "novio", "novia", "prometido", "prometida", "compañero", "compañera"]],
      ["grandmother", ["abuela", "abuelita"], ["abuelita"]], ["grandfather", ["abuelo", "abuelito"], ["abuelito"]],
      ["grandparent", ["abuelos"]], ["grandson", ["nieto"]], ["granddaughter", ["nieta"]], ["grandchild", ["nietos"]],
      ["aunt", ["tía"]], ["uncle", ["tío"]], ["niece", ["sobrina"]], ["nephew", ["sobrino"]], ["cousin", ["primo", "prima", "primos"]],
      ["mother_in_law", ["suegra"]], ["father_in_law", ["suegro"]], ["sister_in_law", ["cuñada"]], ["brother_in_law", ["cuñado"]],
      ["son_in_law", ["yerno"]], ["daughter_in_law", ["nuera"]],
      ["godparent", ["madrina", "padrino"]], ["godchild", ["ahijado", "ahijada"]],
      ["relative", ["familiar", "pariente", "familia"]],
      ["friend", ["amigo", "amiga", "mejor amigo", "mejor amiga", "amigos", "amigas"]],
      ["colleague", ["colega", "compañero de trabajo", "compañera de trabajo", "colegas"]],
      ["manager", ["jefe", "jefa", "superior"]], ["employee", ["empleado", "empleada", "asistente"]],
      ["client", ["cliente", "clienta"]], ["neighbour", ["vecino", "vecina"]], ["doctor", ["médico", "médica", "doctor", "doctora"]],
    ],
  },
  it: {
    owners: ["mio", "mia", "miei", "mie", "nostro", "nostra", "nostri", "nostre"],
    entries: [
      ["mother", ["madre", "mamma", "mammina"], ["mamma", "mammina"]],
      ["father", ["padre", "papà", "babbo", "papa"], ["papà", "babbo"]],
      ["parent", ["genitori"]],
      ["son", ["figlio"]], ["daughter", ["figlia"]], ["child", ["figli", "bambini", "ragazzi"]],
      ["sister", ["sorella", "sorellina"]], ["brother", ["fratello", "fratellino"]], ["sibling", ["fratelli"]],
      ["wife", ["moglie"]], ["husband", ["marito"]], ["spouse", ["coniuge"]],
      ["partner", ["compagno", "compagna", "ragazzo", "ragazza", "fidanzato", "fidanzata", "partner"]],
      ["grandmother", ["nonna", "nonnina"], ["nonna"]], ["grandfather", ["nonno"], ["nonno"]],
      ["grandparent", ["nonni"]], [["grandchild", "grandson", "granddaughter", "nephew", "niece"], ["nipote", "nipoti"]],
      ["aunt", ["zia"]], ["uncle", ["zio"]], ["cousin", ["cugino", "cugina", "cugini"]],
      ["mother_in_law", ["suocera"]], ["father_in_law", ["suocero"]], ["sister_in_law", ["cognata"]], ["brother_in_law", ["cognato"]],
      ["son_in_law", ["genero"]], ["daughter_in_law", ["nuora"]],
      ["godparent", ["madrina", "padrino"]], ["godchild", ["figlioccio", "figlioccia"]],
      ["relative", ["parente", "parenti", "famiglia"]],
      ["friend", ["amico", "amica", "migliore amico", "migliore amica", "amici", "amiche"]],
      ["colleague", ["collega", "colleghi", "colleghe"]],
      ["manager", ["capo", "responsabile", "superiore"]], ["employee", ["dipendente", "assistente", "collaboratore", "collaboratrice"]],
      ["client", ["cliente"]], ["neighbour", ["vicino", "vicina", "vicino di casa", "vicina di casa"]], ["doctor", ["medico", "dottore", "dottoressa"]],
    ],
  },
  pt: {
    owners: ["meu", "minha", "meus", "minhas", "nosso", "nossa", "nossos", "nossas"],
    entries: [
      ["mother", ["mãe", "mamãe", "mainha"], ["mamãe", "mainha"]],
      ["father", ["pai", "papai", "painho"], ["papai", "painho"]],
      ["parent", ["pais"]],
      ["son", ["filho"]], ["daughter", ["filha"]], ["child", ["filhos", "crianças"]],
      ["sister", ["irmã", "irmãzinha"]], ["brother", ["irmão", "irmãozinho"]], ["sibling", ["irmãos"]],
      ["wife", ["esposa", "mulher"]], ["husband", ["marido", "esposo"]], ["spouse", ["cônjuge"]],
      ["partner", ["namorado", "namorada", "companheiro", "companheira", "parceiro", "parceira", "noivo", "noiva"]],
      // « avó » and « avô » fold to the same word.
      [["grandmother", "grandfather"], ["avó", "avô"]], ["grandmother", ["vovó"], ["vovó"]], ["grandfather", ["vovô"], ["vovô"]],
      ["grandparent", ["avós"]], ["grandson", ["neto"]], ["granddaughter", ["neta"]], ["grandchild", ["netos"]],
      ["aunt", ["tia"]], ["uncle", ["tio"]], ["niece", ["sobrinha"]], ["nephew", ["sobrinho"]], ["cousin", ["primo", "prima", "primos"]],
      ["mother_in_law", ["sogra"]], ["father_in_law", ["sogro"]], ["sister_in_law", ["cunhada"]], ["brother_in_law", ["cunhado"]],
      ["son_in_law", ["genro"]], ["daughter_in_law", ["nora"]],
      ["godparent", ["madrinha", "padrinho"]], ["godchild", ["afilhado", "afilhada"]],
      ["relative", ["parente", "parentes", "família"]],
      ["friend", ["amigo", "amiga", "melhor amigo", "melhor amiga", "amigos", "amigas"]],
      ["colleague", ["colega", "colega de trabalho", "colegas"]],
      ["manager", ["chefe", "gerente", "superior"]], ["employee", ["funcionário", "funcionária", "assistente"]],
      ["client", ["cliente"]], ["neighbour", ["vizinho", "vizinha"]], ["doctor", ["médico", "médica"]],
    ],
  },
  nl: {
    owners: ["mijn", "onze", "ons", "m'n"],
    entries: [
      ["mother", ["moeder", "mama", "mam", "moeke"], ["mama", "mam"]],
      ["father", ["vader", "papa", "pap"], ["papa", "pap"]],
      ["parent", ["ouders"]],
      ["son", ["zoon", "zoontje"]], ["daughter", ["dochter", "dochtertje"]], ["child", ["kinderen", "kind", "kids"]],
      ["sister", ["zus", "zusje", "zuster"]], ["brother", ["broer", "broertje"]], ["sibling", ["broers en zussen"]],
      ["wife", ["vrouw", "echtgenote"]], ["husband", ["man", "echtgenoot"]],
      ["partner", ["partner", "verloofde"]], [["partner", "friend"], ["vriend", "vriendin"]],
      ["grandmother", ["oma", "grootmoeder"], ["oma"]], ["grandfather", ["opa", "grootvader"], ["opa"]],
      ["grandparent", ["grootouders"]], ["grandson", ["kleinzoon"]], ["granddaughter", ["kleindochter"]], ["grandchild", ["kleinkinderen", "kleinkind"]],
      ["aunt", ["tante"]], ["uncle", ["oom"]], [["niece", "cousin"], ["nicht", "nichtje"]], [["nephew", "cousin"], ["neef", "neefje"]],
      ["mother_in_law", ["schoonmoeder"]], ["father_in_law", ["schoonvader"]], ["sister_in_law", ["schoonzus", "schoonzuster"]], ["brother_in_law", ["zwager"]],
      ["son_in_law", ["schoonzoon"]], ["daughter_in_law", ["schoondochter"]],
      ["godparent", ["peetoom", "peettante", "meter", "peter"]], ["godchild", ["petekind", "peetkind"]],
      ["relative", ["familielid", "familie"]],
      ["friend", ["beste vriend", "beste vriendin", "vrienden"]],
      ["colleague", ["collega", "collega's"]],
      ["manager", ["baas", "leidinggevende", "manager", "chef"]], ["employee", ["medewerker", "medewerkster", "assistent", "assistente"]],
      ["client", ["klant", "cliënt"]], ["neighbour", ["buurman", "buurvrouw", "buren"]], ["doctor", ["dokter", "huisarts", "arts"]],
    ],
  },
};

interface CjkLexicon {
  /// « 私の », « 我的 », « 우리 »: one's own before the word.
  owners: string[];
  /// What makes the word someone else's when just before it (« の », « 的 »,
  /// « 의 ») — unless an owner of the person's comes before it.
  of: string[];
  /// Words that make it someone else's just before it (« 他 », « 她 »).
  others: string[];
  /// [kinds, words that say one's own alone, words that need an owner].
  entries: Array<[RelationKind | RelationKind[], string[], string[]?]>;
}

const CJK: Record<"ja" | "zh" | "ko", CjkLexicon> = {
  ja: {
    owners: ["私の", "わたしの", "僕の", "ぼくの", "俺の", "おれの", "うちの", "我が"],
    of: ["の"],
    others: ["彼の", "彼女の", "あなたの", "君の"],
    entries: [
      ["mother", ["母", "母親", "お母さん", "母さん", "ママ", "お袋", "おふくろ", "おかあさん"]],
      ["father", ["父", "父親", "お父さん", "父さん", "パパ", "親父", "おやじ", "おとうさん"]],
      ["parent", ["両親", "親"]],
      ["son", ["息子"]], ["daughter", ["娘"]], ["child", ["子供", "子ども", "子どもたち", "子供たち"]],
      ["sister", ["姉", "妹", "お姉さん", "お姉ちゃん", "姉さん", "姉ちゃん"]],
      ["brother", ["兄", "弟", "お兄さん", "お兄ちゃん", "兄さん", "兄貴"]],
      ["sibling", ["兄弟", "きょうだい", "兄妹", "姉妹"]],
      ["wife", ["妻", "嫁", "家内", "女房"]], ["husband", ["夫", "主人", "旦那"]],
      ["spouse", ["配偶者"]], ["partner", ["彼氏", "パートナー", "婚約者", "恋人"]],
      ["grandmother", ["祖母", "おばあちゃん", "おばあさん"]], ["grandfather", ["祖父", "おじいちゃん", "おじいさん"]],
      ["grandparent", ["祖父母"]], ["grandson", ["孫息子"]], ["granddaughter", ["孫娘"]], ["grandchild", ["孫"]],
      ["aunt", ["叔母", "伯母", "おばさん"]], ["uncle", ["叔父", "伯父", "おじさん"]], ["niece", ["姪"]], ["nephew", ["甥"]],
      ["cousin", ["いとこ", "従兄弟", "従姉妹", "従兄", "従姉", "従弟", "従妹"]],
      ["mother_in_law", ["義母", "姑", "お義母さん"]], ["father_in_law", ["義父", "舅", "お義父さん"]],
      ["sister_in_law", ["義姉", "義妹"]], ["brother_in_law", ["義兄", "義弟"]], ["son_in_law", ["婿", "娘婿"]], ["daughter_in_law", ["息子の嫁"]],
      ["godparent", ["名付け親", "代父", "代母"]], ["godchild", ["代子"]],
      ["relative", ["親戚", "親族"]],
      ["friend", ["友達", "友だち", "友人", "親友"]], ["colleague", ["同僚"]],
      ["manager", ["上司", "部長", "課長", "社長"]], ["employee", ["部下"]],
      ["client", ["顧客", "お客さん", "取引先"]], ["neighbour", ["隣人", "お隣さん", "近所の人"]], ["doctor", ["主治医", "かかりつけ医"]],
    ],
  },
  zh: {
    owners: ["我的", "我们的", "我們的", "我", "我们", "我們", "咱", "咱们"],
    of: ["的"],
    others: ["他", "她", "你", "您", "他们", "她们", "他們", "她們"],
    entries: [
      ["mother", ["妈妈", "母亲", "媽媽", "母親", "老妈", "老媽"], ["妈", "媽"]],
      ["father", ["爸爸", "父亲", "父親", "老爸"], ["爸"]],
      ["parent", ["父母", "爸妈", "爸媽"]],
      ["son", ["儿子", "兒子"]], ["daughter", ["女儿", "女兒"]], ["child", ["孩子", "孩子们", "孩子們"]],
      ["sister", ["姐姐", "妹妹"], ["姐", "妹"]], ["brother", ["哥哥", "弟弟"], ["哥", "弟"]], ["sibling", ["兄弟姐妹"]],
      ["wife", ["妻子", "老婆", "爱人", "愛人"], ["太太"]], ["husband", ["丈夫", "老公"], ["先生"]], ["spouse", ["配偶"]],
      ["partner", ["男朋友", "女朋友", "对象", "對象", "未婚夫", "未婚妻", "伴侣", "伴侶"]],
      ["grandmother", ["奶奶", "外婆", "姥姥", "祖母"]], ["grandfather", ["爷爷", "爺爺", "外公", "姥爷", "姥爺", "祖父"]],
      ["grandparent", ["祖父母"]], ["grandson", ["孙子", "孫子", "外孙", "外孫"]], ["granddaughter", ["孙女", "孫女", "外孙女", "外孫女"]],
      ["aunt", ["阿姨", "姑姑", "姨妈", "姨媽", "舅妈", "舅媽", "婶婶", "嬸嬸"]], ["uncle", ["叔叔", "舅舅", "伯伯", "姑父", "姨父"]],
      ["niece", ["侄女", "外甥女"]], ["nephew", ["侄子", "外甥"]],
      ["cousin", ["表哥", "表姐", "表弟", "表妹", "堂哥", "堂姐", "堂弟", "堂妹"]],
      ["mother_in_law", ["岳母", "婆婆", "丈母娘"]], ["father_in_law", ["岳父", "公公", "老丈人"]],
      ["sister_in_law", ["嫂子", "弟媳", "小姑子", "大姑子", "小姨子", "大姨子"]], ["brother_in_law", ["姐夫", "妹夫", "小舅子", "大舅子", "小叔子", "大伯子"]],
      ["son_in_law", ["女婿"]], ["daughter_in_law", ["儿媳", "兒媳", "媳妇", "媳婦"]],
      ["godparent", ["干妈", "乾媽", "干爸", "乾爸", "教父", "教母"]], ["godchild", ["干儿子", "干女儿", "教子"]],
      ["relative", ["亲戚", "親戚"]],
      ["friend", ["朋友", "好朋友", "闺蜜", "閨蜜", "哥们", "哥們"]], ["colleague", ["同事"]],
      ["manager", ["老板", "老闆", "领导", "領導", "上司", "经理", "經理"]], ["employee", ["下属", "下屬", "助理", "员工", "員工"]],
      ["client", ["客户", "客戶"]], ["neighbour", ["邻居", "鄰居"]], ["doctor", ["医生", "醫生", "大夫"]],
    ],
  },
  ko: {
    owners: ["우리", "제", "내", "나의", "저의", "저희"],
    of: ["의"],
    others: ["그의", "그녀의", "너의", "당신의"],
    entries: [
      ["mother", ["엄마", "어머니", "어머님", "어무니"]], ["father", ["아빠", "아버지", "아버님"]],
      ["parent", ["부모님", "부모"]],
      ["son", ["아들"]], ["daughter", ["딸"]], ["child", ["아이들", "애들", "아이", "자녀"]],
      ["sister", ["언니", "누나", "여동생"]], ["brother", ["오빠", "형", "남동생"]], ["sibling", ["동생", "형제", "남매", "자매"]],
      ["wife", ["아내", "와이프", "집사람", "부인"]], ["husband", ["남편", "신랑"]], ["spouse", ["배우자"]],
      ["partner", ["남자친구", "여자친구", "남친", "여친", "애인", "약혼자"]],
      ["grandmother", ["할머니", "외할머니", "친할머니"]], ["grandfather", ["할아버지", "외할아버지", "친할아버지"]],
      ["grandparent", ["조부모님", "조부모"]], ["grandson", ["손자"]], ["granddaughter", ["손녀"]], ["grandchild", ["손주"]],
      ["aunt", ["이모", "고모", "숙모", "외숙모"]], ["uncle", ["삼촌", "외삼촌", "큰아버지", "작은아버지", "고모부", "이모부"]],
      ["niece", ["조카딸"]], [["nephew", "niece"], ["조카"]], ["cousin", ["사촌", "사촌동생", "사촌오빠", "사촌언니", "사촌형", "사촌누나"]],
      ["mother_in_law", ["시어머니", "장모님", "장모"]], ["father_in_law", ["시아버지", "장인어른", "장인"]],
      ["sister_in_law", ["시누이", "올케", "처제", "처형", "형수", "새언니"]], ["brother_in_law", ["매형", "매부", "처남", "형부", "시동생", "아주버님"]],
      ["son_in_law", ["사위"]], ["daughter_in_law", ["며느리"]],
      ["godparent", ["대부", "대모"]], ["godchild", ["대자", "대녀"]],
      ["relative", ["친척"]],
      ["friend", ["친구", "절친", "베프", "친구들"]], ["colleague", ["동료", "직장 동료"]],
      ["manager", ["상사", "팀장님", "부장님", "사장님", "팀장", "부장"]], ["employee", ["부하", "직원", "부하 직원"]],
      ["client", ["고객", "클라이언트"]], ["neighbour", ["이웃", "옆집"]], ["doctor", ["주치의", "의사 선생님"]],
    ],
  },
};

// ── Folding ──────────────────────────────────────────────────────────────

/// As entities.ts normaliseName: « Belle-Sœur » → « belle soeur ».
export function fold(text: string): string {
  return text
    .replace(/œ/g, "oe").replace(/Œ/g, "oe").replace(/æ/g, "ae").replace(/Æ/g, "ae").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .split(/[^\p{L}\p{N}+]+/u).filter(Boolean).join(" ");
}

const kindsOf = (kinds: RelationKind | RelationKind[]): RelationKind[] => (Array.isArray(kinds) ? kinds : [kinds]);

interface LatinIndex {
  /// folded word (one or more words) → kinds, and whether it says one's own alone.
  words: Map<string, { kinds: Set<RelationKind>; alone: boolean }>;
  owners: Set<string>;
  longest: number;
}

const LATIN_INDEX: LatinIndex = (() => {
  const words = new Map<string, { kinds: Set<RelationKind>; alone: boolean }>();
  const owners = new Set<string>();
  let longest = 1;
  for (const lexicon of Object.values(LATIN)) {
    for (const owner of lexicon.owners) owners.add(fold(owner));
    for (const [kinds, list, alone = []] of lexicon.entries) {
      const aloneSet = new Set(alone.map(fold));
      for (const word of [...list, ...alone]) {
        const key = fold(word);
        if (!key) continue;
        const known = words.get(key) ?? { kinds: new Set<RelationKind>(), alone: false };
        kindsOf(kinds).forEach((kind) => known.kinds.add(kind));
        if (aloneSet.has(key)) known.alone = true;
        words.set(key, known);
        longest = Math.max(longest, key.split(" ").length);
      }
    }
  }
  return { words, owners, longest };
})();

/// « de », « of », « von »…: before an owner, the relative is someone else's
/// (« la mère de mon ami »); after a word, so is it (« la mère de Paul »).
const OF = new Set(["de", "d", "du", "des", "of", "von", "vom", "der", "des", "di", "del", "della", "dello", "dei", "degli", "delle", "do", "da", "dos", "das", "van", "s"].map(fold));
/// Before a word alone (« maman »), what makes it someone else's (« sa
/// maman », « la maman de Paul »).
const NOT_OWN_BEFORE = new Set(["s", "sa", "son", "ses", "leur", "leurs", "ta", "ton", "tes", "votre", "vos", "la", "le", "les", "une", "un", "his", "her", "their", "your", "a", "the", "seine", "seiner", "seinem", "seinen", "sein", "ihre", "ihrer", "ihrem", "ihren", "ihr", "deine", "deiner", "deinem", "deinen", "dein", "eine", "einer", "die", "der", "dem", "su", "sus", "tu", "tus", "el", "una", "sua", "suo", "tua", "tuo", "il", "lo", "seu", "sua", "teu", "tua", "o", "um", "uma", "zijn", "haar", "hun", "je", "jouw", "een", "het"].map(fold));
/// Adjectives allowed between « ma » and the word (« ma petite sœur »).
const BETWEEN = new Set(["petit", "petite", "grand", "grande", "cher", "chere", "jeune", "vieux", "vieille", "little", "big", "older", "younger", "elder", "dear", "kleine", "kleiner", "kleinen", "grosse", "grosser", "grossen", "altere", "alterer", "jungere", "jungerer", "liebe", "lieber", "querida", "querido", "cara", "caro", "piccola", "piccolo", "querida", "lieve", "kleine", "jongere", "oudere"].map(fold));
/// Before a word (« grand-mère » said apart, « belle-mère », « arrière… »),
/// what makes it another relative.
const NOT_BEFORE = new Set(["grand", "grands", "arriere", "belle", "beau", "step", "great", "god", "half", "demi", "schwieger", "ur", "bis", "tatara"].map(fold));

const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/// Japanese: one character alone says a relative only before a particle
/// (« 母の », « 父は »), never inside another word (« 母校 », « 父兄 »).
const JA_AFTER = "のはがにもへをとやで、。！？!?,.)）」』 \n";
const KO_AFTER = "은는이가을를의도와과에께한랑하 ,.!?\n)";
/// Characters that make the word another relative when just before it.
const CJK_NOT_BEFORE: Record<"ja" | "zh" | "ko", string> = {
  ja: "祖義継後岳叔伯養乳保父曾丈工ご",
  zh: "祖继繼后後岳叔伯姑舅外养養乳干乾表堂曾大小老",
  ko: "시장새양의외친큰작사",
};

export interface KinshipMention {
  kinds: RelationKind[];
  /// The words said, as written.
  phrase: string;
  /// Where it is, in the folded text for Latin scripts, in the text itself
  /// for the others.
  start: number;
  end: number;
  /// The person's own (« ma mère », « 母 », « 우리 엄마 »).
  own: boolean;
  /// Said as someone else's owner: « de mon ami », « 友達の » (the relative is
  /// whom something belongs to). Its name just after it (« de mon ami Paul »)
  /// is still the person's friend.
  owner: boolean;
  script: "latin" | "cjk";
}

/// The relatives a text names in the app's ten languages, the person's own
/// or not (« la mère de Paul »: « mère », not own).
export function kinshipMentions(text: string): KinshipMention[] {
  return [...latinMentions(text), ...cjkMentions(text)];
}

function latinMentions(text: string): KinshipMention[] {
  const folded = fold(text);
  if (!folded) return [];
  const tokens = folded.split(" ");
  const offsets: number[] = [];
  let at = 0;
  for (const token of tokens) { offsets.push(at); at += token.length + 1; }
  const found: Array<{ first: number; word: number; last: number; kinds: RelationKind[]; own: boolean }> = [];
  for (let i = 0; i < tokens.length; i++) {
    let entry: { length: number; kinds: Set<RelationKind>; alone: boolean } | null = null;
    for (let n = Math.min(LATIN_INDEX.longest, tokens.length - i); n >= 1; n--) {
      const known = LATIN_INDEX.words.get(tokens.slice(i, i + n).join(" "));
      if (known) { entry = { length: n, ...known }; break; }
    }
    if (!entry) continue;
    const last = i + entry.length - 1;
    const before = tokens[i - 1];
    const beforeTwo = tokens[i - 2];
    // « grand-mère » folded is « grand mere »: « mere » there is no mother.
    if (before && NOT_BEFORE.has(before)) { i = last; continue; }
    let ownerAt = -1;
    if (before && LATIN_INDEX.owners.has(before)) ownerAt = i - 1;
    else if (before && BETWEEN.has(before) && beforeTwo && LATIN_INDEX.owners.has(beforeTwo)) ownerAt = i - 2;
    const after = tokens[last + 1];
    let own = ownerAt >= 0;
    // « maman », « Mama », « mamá »: one's own alone — not « sa maman »,
    // « la maman de Paul », « Paul's mom ».
    if (!own && entry.alone) own = !(before && (NOT_OWN_BEFORE.has(before) || before === "s")) && !(after && OF.has(after) && after !== "s");
    found.push({ first: ownerAt >= 0 ? ownerAt : i, word: i, last, kinds: [...entry.kinds], own });
    i = last;
  }
  return found.map((mention, index) => {
    // Someone else's relative's owner: « la mère de mon ami », « my mom's
    // friend » (the relative is whom another one belongs to).
    const previous = found[index - 1];
    const next = found[index + 1];
    const owner = mention.own && (
      (!!previous && previous.last === mention.first - 2 && OF.has(tokens[mention.first - 1]!)) ||
      (!!next && next.first === mention.last + 2 && tokens[mention.last + 1] === "s"));
    return {
      kinds: mention.kinds,
      phrase: tokens.slice(mention.first, mention.last + 1).join(" "),
      start: offsets[mention.first]!,
      end: offsets[mention.last]! + tokens[mention.last]!.length,
      own: mention.own,
      owner,
      script: "latin" as const,
    };
  });
}

const CJK_ENTRIES = (Object.entries(CJK) as Array<["ja" | "zh" | "ko", CjkLexicon]>).flatMap(([language, lexicon]) =>
  lexicon.entries.flatMap(([kinds, alone, owned = []]) => [
    ...alone.map((word) => ({ language, word, kinds: kindsOf(kinds), needsOwner: false })),
    ...owned.map((word) => ({ language, word, kinds: kindsOf(kinds), needsOwner: true })),
  ]),
).sort((a, b) => b.word.length - a.word.length);

function cjkMentions(raw: string): KinshipMention[] {
  const text = raw.normalize("NFC");
  if (!CJK_SCRIPT.test(text)) return [];
  const taken: boolean[] = new Array(text.length).fill(false);
  const out: Array<KinshipMention & { language: "ja" | "zh" | "ko" }> = [];
  // Japanese is written with kana, Chinese never: « 丈夫です » is « fine »,
  // « 我丈夫 » « my husband ».
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  for (const entry of CJK_ENTRIES) {
    if ((entry.language === "zh" && kana) || (entry.language === "ja" && !kana)) continue;
    const lexicon = CJK[entry.language];
    let from = 0;
    for (;;) {
      const at = text.indexOf(entry.word, from);
      if (at < 0) break;
      from = at + 1;
      const end = at + entry.word.length;
      if (taken.slice(at, end).some(Boolean)) continue;
      const prev = text[at - 1] ?? "";
      if (prev && CJK_NOT_BEFORE[entry.language].includes(prev)) continue;
      const next = text[end] ?? "";
      // One character (« 母 », « 딸 », « 형 »): only before a particle or the end.
      if (entry.word.length === 1 && entry.language !== "zh") {
        const allowed = entry.language === "ko" ? KO_AFTER : JA_AFTER;
        if (!(next === "" || allowed.includes(next))) continue;
      }
      const before = text.slice(Math.max(0, at - 6), at).replace(/\s+$/u, "");
      const ownerWord = lexicon.owners.find((owner) => before.endsWith(owner));
      // Korean: a word glued to the one before is part of it (« 시어머니 »),
      // unless that one is « 우리 » (« 우리엄마 »).
      if (entry.language === "ko" && prev && /\p{Script=Hangul}/u.test(prev) && !ownerWord) continue;
      if (entry.needsOwner && !ownerWord) continue;
      const otherWord = !ownerWord && lexicon.others.find((other) => before.endsWith(other));
      const ofWord = !ownerWord && lexicon.of.find((of) => before.endsWith(of));
      const own = ownerWord ? true : otherWord || ofWord ? false : true;
      const start = ownerWord ? Math.max(0, text.lastIndexOf(ownerWord, at - ownerWord.length)) : at;
      for (let k = at; k < end; k++) taken[k] = true;
      out.push({ kinds: entry.kinds, phrase: text.slice(start, end), start, end, own, owner: false, script: "cjk", language: entry.language });
    }
  }
  out.sort((a, b) => a.start - b.start);
  // « 友達の母 », « 我朋友的妈妈 », « 친구의 엄마 »: the first is the owner of
  // the second, not the relative named.
  return out.map((mention, index) => {
    const next = out[index + 1];
    const between = next ? text.slice(mention.end, next.start).trim() : "";
    const owner = mention.own && !!next && CJK[mention.language].of.includes(between);
    const { language: _language, ...rest } = mention;
    return { ...rest, owner };
  });
}

/// The kinds a word or a label says (« Mutter », « maman », « belle-sœur »,
/// « 엄마 », a kind's own name « mother_in_law »): what a relation labelled in
/// any language is.
export function kindsOfWord(word: string): RelationKind[] {
  const trimmed = word.trim();
  if (isRelationKind(trimmed)) return [trimmed];
  const folded = fold(trimmed);
  for (const kind of RELATION_KINDS) {
    if (Object.values(KIND_WORDS[kind]).some((label) => fold(label) === folded || label === trimmed)) return [kind];
  }
  const latin = LATIN_INDEX.words.get(folded)
    // « ma mère », « my mum »: the owner aside.
    ?? LATIN_INDEX.words.get(folded.split(" ").filter((token, i) => !(i === 0 && LATIN_INDEX.owners.has(token))).join(" "));
  if (latin) return [...latin.kinds];
  if (CJK_SCRIPT.test(trimmed)) {
    const nfc = trimmed.normalize("NFC");
    for (const lexicon of Object.values(CJK)) {
      const bare = lexicon.owners.reduce((text, owner) => (text.startsWith(owner) ? text.slice(owner.length).trim() : text), nfc);
      for (const [kinds, alone, owned = []] of lexicon.entries) if ([...alone, ...owned].includes(bare)) return kindsOf(kinds);
    }
  }
  return [];
}

/// Every word a kind is said with, folded (Latin) or as written (CJK): what
/// retrieval matches a relation of that kind on, whatever language its label.
/// A word that says several kinds (« copine », « Freund », « nipote ») is
/// left out: « mon ami » must not reach a partner through « copain ».
export function wordsOfKind(kind: RelationKind): string[] {
  const out = new Set<string>(Object.values(KIND_WORDS[kind]).map((label) => (CJK_SCRIPT.test(label) ? label : fold(label))));
  out.add(fold(kind));
  for (const [key, entry] of LATIN_INDEX.words) if (entry.kinds.size === 1 && entry.kinds.has(kind)) out.add(key);
  for (const lexicon of Object.values(CJK)) {
    for (const [kinds, alone, owned = []] of lexicon.entries) if (kindsOf(kinds).length === 1 && kindsOf(kinds)[0] === kind) [...alone, ...owned].forEach((word) => out.add(word));
  }
  return [...out];
}

// ── Hypotheses ───────────────────────────────────────────────────────────

/// A wish or a hypothesis in the ten languages: « si j'avais une sœur »,
/// « if I had », « wenn ich … hätte », « si tuviera », « se avessi », « se eu
/// tivesse », « als ik … had », « もし », « 如果 », « 만약 ».
const HYPOTHESIS = new RegExp([
  "\\bsi j'avais\\b", "\\bsi j'[ée]tais\\b", "\\bsi un jour\\b", "\\bsi (?:je|j'|on) (?:gagne|avai|devais)", "\\bj'aimerais\\b", "\\bje voudrais\\b", "\\bj'\\w+rais\\b", "\\bimaginons\\b", "\\bsupposons\\b", "\\bpeut-[êe]tre\\b",
  "\\bif i (?:had|were|ever|have)\\b", "\\bi wish\\b", "\\bi'd (?:like|love)\\b", "\\bi would\\b", "\\bimagine\\b", "\\bsuppose\\b", "\\bsomeday\\b", "\\bmaybe\\b",
  "\\bwenn ich\\b", "\\bfalls ich\\b", "\\bh[äa]tte\\b", "\\bw[äa]re\\b", "\\bw[üu]rde\\b", "\\bangenommen\\b", "\\bvielleicht\\b",
  "\\bsi (?:tuviera|tuviese|fuera|fuese|tengo)\\b", "\\bojal[áa]\\b", "\\bme gustar[íi]a\\b", "\\btendr[íi]a\\b", "\\bquiz[áa]s?\\b",
  "\\bse (?:avessi|fossi|avesse)\\b", "\\bvorrei\\b", "\\bavrei\\b", "\\bmagari\\b", "\\bforse\\b",
  "\\bse (?:eu )?(?:tivesse|fosse)\\b", "\\bgostaria\\b", "\\bteria\\b", "\\btalvez\\b",
  "\\bals ik\\b", "\\bzou\\b", "\\bstel (?:je voor|dat)\\b", "\\bmisschien\\b",
  "もし", "だったら", "なら", "欲しい", "如果", "假如", "要是", "希望", "也许", "만약", "만일", "있다면", "라면", "싶다",
].join("|"), "iu");

export function hypothetical(text: string): boolean {
  return HYPOTHESIS.test(text);
}
