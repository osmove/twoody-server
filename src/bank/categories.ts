// « Banque » (Jimmy, 04/10/2026: « import de relevés pour la banque »): the
// categories of a transaction, found on this computer by keyword rules, at
// import — no model is asked. The person corrects one (or every one of the
// same counterparty, which becomes a rule of theirs, bank_category_rules);
// their choice always wins over these rules.

export const BANK_CATEGORIES = [
  "income",
  "groceries",
  "restaurants",
  "fuel",
  "transport",
  "rent",
  "loans",
  "utilities",
  "subscriptions",
  "insurance",
  "health",
  "taxes",
  "shopping",
  "leisure",
  "cash",
  "bank_fees",
  "savings",
  "transfers",
  "other",
] as const;
export type BankCategory = (typeof BANK_CATEGORIES)[number];

export function isBankCategory(value: unknown): value is BankCategory {
  return typeof value === "string" && (BANK_CATEGORIES as readonly string[]).includes(value);
}

/// What a model or a person may call a category (« courses », « loyer »,
/// « groceries »): its id. Null when it names none.
const CATEGORY_WORDS: Array<[BankCategory, RegExp]> = [
  ["income", /^(?:income|revenus?|salaires?|paies?|salary|salaries|wages?|pay)$/],
  ["groceries", /^(?:groceries|grocery|courses|alimentation|supermarches?|supermarkets?|food)$/],
  ["restaurants", /^(?:restaurants?|restos?|restauration|eating out|dining)$/],
  ["fuel", /^(?:fuel|carburants?|essence|gas|petrol|gazole|diesel)$/],
  ["transport", /^(?:transports?|transportation|trains?|taxis?|peages?|tolls?|parking|travel)$/],
  ["rent", /^(?:rent|loyers?|logement|housing)$/],
  ["loans", /^(?:loans?|credits?|prets?|emprunts?|mortgage)$/],
  ["utilities", /^(?:utilities|energie|energy|electricite|electricity|gaz|eau|water)$/],
  ["subscriptions", /^(?:subscriptions?|abonnements?|telecoms?|streaming|internet|mobile|phone)$/],
  ["insurance", /^(?:insurance|assurances?|mutuelles?)$/],
  ["health", /^(?:health|sante|medical|pharmacie|pharmacy|medecin|doctor)$/],
  ["taxes", /^(?:taxes?|impots?|tax)$/],
  ["shopping", /^(?:shopping|achats?|purchases?|vetements|clothes)$/],
  ["leisure", /^(?:leisure|loisirs?|vacances|holidays?|voyages?|culture|sport|sports|jeux|games)$/],
  ["cash", /^(?:cash|especes|retraits?|withdrawals?|atm)$/],
  ["bank_fees", /^(?:bank[_ ]fees|frais(?: bancaires)?|fees|commissions?|agios)$/],
  ["savings", /^(?:savings|epargne|livrets?)$/],
  ["transfers", /^(?:transfers?|virements?)$/],
  ["other", /^(?:other|autres?|divers|non classe)$/],
];

export function categoryFrom(value: unknown): BankCategory | null {
  if (typeof value !== "string") return null;
  const word = plainLower(value).replace(/[^a-z_ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!word) return null;
  if (isBankCategory(word)) return word;
  return CATEGORY_WORDS.find(([, pattern]) => pattern.test(word))?.[0] ?? null;
}

function plainLower(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/// A label as the rules and the fingerprints read it: capitals, no accents,
/// letters and digits only (« CB Carrefour Market 12/09 » → « CB CARREFOUR
/// MARKET 12 09 »).
export function plainLabel(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

// ── Who the money went to or came from ────────────────────────────────────

/// What French banks write before the counterparty: the kind of operation.
const LEADING = [
  /^(?:PAIEMENT|PAIEMT|ACHAT|FACTURE|FACT|PAYMENT|PURCHASE)(?: (?:PAR|PSC|SANS CONTACT|EN))*(?: (?:CARTE|CB|CARD))?(?: (?:BANCAIRE|SANS CONTACT|DEBIT DIFFERE))?\b/,
  /^(?:CARTE|CB|CARD|CBANCAIRE)(?: (?:BANCAIRE|DEBIT|SANS CONTACT))?\b/,
  /^(?:PRLV|PRELEVEMENT|PRELEVMT|PRELEV|PRLVT|DIRECT DEBIT|ECHEANCE|ECH)(?: (?:SEPA|EUROPEEN|EUROPEENNE|SDD))*\b/,
  /^(?:VIREMENT|VIRT|VIR|VRT|TRANSFER)(?: (?:SEPA|INST|INSTANTANE|EUROPEEN|PERMANENT|RECU|EMIS|ENVOYE|EN VOTRE FAVEUR|DE|DU|A|VERS|POUR|FROM|TO|RE|EM|INTERNE|WEB|SALAIRE))*\b/,
  /^(?:RETRAIT|RET|WITHDRAWAL)(?: (?:DAB|GAB|ESPECES|CARTE|CB|ATM))*\b/,
  /^(?:REMISE|REM)(?: (?:CHEQUES?|CHQ))?\b/,
  /^(?:CHEQUE|CHQ|CHECK)\b/,
  /^(?:AVOIR|REMBOURSEMENT|REMB|REFUND)(?: (?:CARTE|CB))?\b/,
  /^(?:DU|LE|DE|DES|X|N)\b/,
  /^\d+\b/,
];

const MARKER = "DE|FROM|FRM|BEN|BENEF|BENEFICIAIRE|EMETTEUR|ORDONNATEUR|VERS|POUR|TO";

/// « LOYER OCTOBRE », « SALAIRE SEPTEMBRE »: the month is no part of who it is.
const MONTHS = /\b(?:JANVIER|FEVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOUT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DECEMBRE|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/g;

/// What comes after the counterparty: a reference, a mandate, a card.
const TRAILING = / (?:ID|REF|REFERENCE|MANDAT|MDT|ECH|ECHEANCE|MOTIF|LIB|NOTPROVIDED|CARTE|CARD|CB|NUM|NO|FACTURE|DATE|BIC|IBAN|ICS|RUM)\b.*$/;

/// « VIR SEPA RECU /DE CLAIRE MARTIN /MOTIF LOYER » → « CLAIRE MARTIN »;
/// « PRLV SEPA FREE MOBILE ECH/151026 ID EMETTEUR/FR12ZZZ » → « FREE
/// MOBILE »; « CB CARREFOUR MARKET 12/09 » → « CARREFOUR MARKET ». Null
/// when nothing is left that names someone.
export function counterpartyOf(label: string): string | null {
  // A cash withdrawal has a place, not a counterparty.
  if (WITHDRAWAL.test(plainLabel(label))) return null;
  const raw = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ");
  // Named after a marker: « /DE CLAIRE MARTIN /MOTIF… », « DE: FREE MOBILE ID: … ».
  const marked = new RegExp(`(?:\\/\\s*(?:${MARKER})\\b\\s*:?|\\b(?:${MARKER})\\s*:)\\s*([A-Z0-9][A-Z0-9 .&'-]{1,60}?)(?=\\s*(?:\\/|\\b(?:ID|REF|MOTIF|MANDAT|ECH|NOTPROVIDED|LIB)\\b|$))`).exec(raw);
  let text = (marked?.[1] ?? raw)
    // Cards (X1234, 4974XXXXXXXX1234), dates (12/09, 12.09.26), times: before
    // a « / » cuts the rest.
    .replace(/\b\d{4,6}X{2,}\d{2,4}\b|\bX{2,}\d{2,4}\b|\bX\d{3,4}\b/g, " ")
    .replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}H\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\/.*$/, " ")
    .replace(/[^A-Z0-9&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    for (const pattern of LEADING) text = text.replace(pattern, "").trim();
    if (text === before) break;
  }
  text = text.replace(TRAILING, "").replace(/\b\d{5,}\b.*$/, "").replace(MONTHS, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(" ").filter(Boolean).slice(0, 4);
  const name = words.join(" ").replace(/^[&' ]+|[&' ]+$/g, "");
  return name.length >= 2 && /[A-Z]{2}/.test(name) ? name.slice(0, 40) : null;
}

/// How a counterparty is compared (a person's rule, « opérations
/// semblables »): its letters and digits.
export function counterpartyKey(name: string | null | undefined): string | null {
  const key = plainLabel(name ?? "");
  return key.length >= 2 ? key : null;
}

// ── The rules ─────────────────────────────────────────────────────────────

type Direction = "in" | "out";
interface Rule { category: BankCategory; pattern: RegExp; only?: Direction }

const words = (list: string) => new RegExp(`\\b(?:${list})\\b`);

/// A transfer, by what the bank writes first.
const TRANSFER = /^(?:VIR|VIREMENT|VIRT|VRT|TRANSFER)\b|\bVIREMENT\b/;
const WITHDRAWAL = /^(?:RETRAIT|RET DAB|RET GAB|WITHDRAWAL)\b|\b(?:RETRAIT DAB|RETRAIT GAB|RETRAIT ESPECES|ATM WITHDRAWAL|CASH WITHDRAWAL)\b/;

// Checked in order: the first that matches wins. Names of shops and services
// French statements carry; words of everyday speech and first names are
// left out (« Paul », « But », « Action » would catch the wrong lines).
const RULES: Rule[] = [
  { category: "bank_fees", pattern: words("FRAIS|COMMISSIONS?|AGIOS|INTERETS DEBITEURS|INT DEBITEURS|COTIS(?:ATION)? (?:CARTE|CB|VISA|MASTERCARD|PACK\\w*|FORMULE|OFFRE|COMPTE|ESPRIT LIBRE|EUROCOMPTE)|TENUE DE COMPTE|OFFRE GROUPEE|OVERDRAFT FEE|MONTHLY FEE") },
  { category: "taxes", pattern: words("DGFIP|IMPOTS?|IMPOTS GOUV|TRESOR PUBLIC|FINANCES PUBLIQUES|TAXE FONCIERE|TAXE D HABITATION|TAXE HABITATION|URSSAF|AMENDES?|ANTAI|PRELEVEMENT A LA SOURCE") },
  { category: "income", only: "in", pattern: words("SALAIRES?|PAIE|PAYE|REMUNERATION|PAYROLL|SALARY|WAGES|PENSION|RETRAITE|CARSAT|AGIRC|ARRCO|CAF|ALLOCATIONS?|FRANCE TRAVAIL|POLE EMPLOI|INDEMNITES?|PRIME D ACTIVITE|PRIME EXCEPTIONNELLE|PRIME DE (?:NOEL|PARTAGE|FIN D ANNEE)|HONORAIRES") },
  { category: "savings", pattern: words("LIVRET A|LIVRET|LDDS|LDD|LEP|PEL|CEL|EPARGNE|ASSURANCE VIE|PEA") },
  { category: "loans", pattern: words("ECHEANCE PRET|ECH PRET|ECHEANCE CREDIT|REMBOURSEMENT PRET|REMB PRET|PRET IMMO\\w*|CREDIT IMMO\\w*|PRET PERSO\\w*|COFIDIS|CETELEM|SOFINCO|FRANFINANCE|ONEY|FLOA|YOUNITED|FINANCO|CA CONSUMER FINANCE") },
  { category: "rent", pattern: words("LOYERS?|BAILLEUR|QUITTANCE|FONCIA|NEXITY|CITYA|SERGIC|ORALIA|IMMO DE FRANCE|OPAC|HLM|PARIS HABITAT|ICF HABITAT|VILOGIA") },
];

const MERCHANT_RULES: Rule[] = [
  { category: "utilities", pattern: words("EDF|ENGIE|GDF|GRDF|ENEDIS|TOTALENERGIES (?:ELEC\\w*|GAZ|CLIENTS|POWER)|TOTAL ENERGIES (?:ELEC\\w*|GAZ|CLIENTS)|TOTAL DIRECT ENERGIE|DIRECT ENERGIE|EKWATEUR|ENERCOOP|MINT ENERGIE|ILEK|OHM ENERGIE|VATTENFALL|PLANETE OUI|VEOLIA|SUEZ|SAUR|EAU DE PARIS|LYONNAISE DES EAUX") },
  { category: "fuel", pattern: words("TOTAL ?ENERGIES?|TOTAL ACCESS|STATION TOTAL|ESSO|SHELL|BP|AVIA|AGIP|DYNEFF|CARBURANTS?|ESSENCE|GAZOLE|GASOIL|STATION SERVICE|STATION (?:U|LECLERC|INTERMARCHE|CARREFOUR|AUCHAN|CASINO)|(?:LECLERC|INTERMARCHE|CARREFOUR|AUCHAN|SUPER U|HYPER U|CASINO) (?:STATION|CARBURANTS?|DRIVE CARBURANT)") },
  { category: "restaurants", pattern: words("RESTAURANTS?|RESTO|BRASSERIE|BISTRO|BISTROT|CAFE|CAFETERIA|PIZZA|PIZZERIA|SUSHI|SUSHIS|KEBAB|BURGER|MCDONALD S?|MC DONALD S?|MCDO|BURGER KING|KFC|SUBWAY|STARBUCKS|COLUMBUS|BRIOCHE DOREE|DELIVEROO|UBER EATS|UBEREATS|JUST EAT|JUSTEAT|FRICHTI|TRAITEUR|CREPERIE|BOUILLON|FIVE GUYS|O TACOS|DOMINO S?|DOMINOS|PIZZA HUT|EXKI|PRET A MANGER|LA CROISSANTERIE") },
  { category: "groceries", pattern: words("CARREFOUR|CRF|LECLERC|E LECLERC|AUCHAN|INTERMARCHE|ITM|MONOPRIX|MONOP|FRANPRIX|CASINO SUPERMAR\\w*|GEANT CASINO|CASINO SHOP|PETIT CASINO|LIDL|ALDI|SUPER U|HYPER U|MAGASINS? U|U EXPRESS|SYSTEME U|CORA|PICARD|NATURALIA|BIOCOOP|LA VIE CLAIRE|GRAND FRAIS|NETTO|LEADER PRICE|SPAR|G20|PROXI|COCCINELLE|VIVAL|SHOPI|SUPERMARCHE|HYPERMARCHE|EPICERIE|PRIMEUR|BOULANGERIE|BOUCHERIE|FROMAGERIE|POISSONNERIE|BIO C BON|THIRIET") },
  { category: "subscriptions", pattern: words("NETFLIX|SPOTIFY|DEEZER|DISNEY PLUS|DISNEYPLUS|CANAL PLUS|CANALSAT|CANAL|AMAZON PRIME|PRIME VIDEO|APPLE COM BILL|APPLE COM|ITUNES|ICLOUD|GOOGLE STORAGE|GOOGLE ONE|GOOGLE PLAY|YOUTUBE PREMIUM|FREE MOBILE|FREE TELECOM|FREEBOX|FREE SAS|ORANGE|SOSH|SFR|RED BY SFR|BOUYGUES TELECOM|BOUYGUES TEL|B YOU|BANDYOU|NRJ MOBILE|LA POSTE MOBILE|PRIXTEL|CORIOLIS|SYMA|LEBARA|LYCAMOBILE|ADOBE|MICROSOFT|OFFICE 365|DROPBOX|OPENAI|CHATGPT|NOTION|LINKEDIN|MOLOTOV|PARAMOUNT|AUDIBLE|BASIC FIT|BASICFIT|FITNESS PARK|KEEP COOL|NEONESS|ORANGE BLEUE|DAZN|BEIN|RMC SPORT|MEDIAPART|ABONNEMENT|ABONNEMENTS") },
  { category: "insurance", pattern: words("ASSURANCES?|ASSU|MAIF|MACIF|MAAF|MATMUT|GMF|AXA|ALLIANZ|GENERALI|GROUPAMA|MMA|AVIVA|ABEILLE|SWISSLIFE|SWISS LIFE|DIRECT ASSURANCE|AMV|LEOCARE|LUKO|LEMONADE|MUTUELLE|HARMONIE MUTUELLE|MGEN|MALAKOFF|HUMANIS|AG2R|PREDICA|PACIFICA|CARDIF|SURAVENIR|HISCOX|ACHEEL") },
  { category: "health", pattern: words("PHARMACIE|PHARMA|PHIE|MEDECIN|DOCTEUR|DOCTOLIB|DENTISTE|DENTAIRE|ORTHODONT\\w*|OPTICIEN|OPTIQUE|KRYS|AFFLELOU|LABORATOIRE|LABO|BIOLOGIE|HOPITAL|CLINIQUE|KINE|KINESITHERAPEUTE|OSTEO\\w*|CPAM|AMELI|ASSURANCE MALADIE|RADIOLOGIE|CENTRE MEDICAL") },
  { category: "transport", pattern: words("SNCF|OUIGO|TGV|RATP|NAVIGO|TRANSILIEN|UBER|BOLT|HEETCH|G7|TAXI|TAXIS|BLABLACAR|FLIXBUS|PEAGES?|AUTOROUTES?|SANEF|APRR|VINCI AUTOROUTES|ASF|COFIROUTE|ESCOTA|PARKING|INDIGO|ONEPARK|ZENPARK|EFFIA|SAEMES|AIR FRANCE|EASYJET|RYANAIR|TRANSAVIA|VUELING|LIME|DOTT|VELIB|KEOLIS|TRANSDEV|IDF MOBILITES|ILE DE FRANCE MOBILITES|TRAINLINE") },
  { category: "leisure", pattern: words("CINEMA|UGC|PATHE|GAUMONT|MK2|CGR|KINEPOLIS|THEATRE|CONCERTS?|TICKETMASTER|FNAC SPECTACLES|SEETICKETS|DIGITICK|BILLETREDUC|MUSEE|MUSEUM|PARC ASTERIX|DISNEYLAND|FUTUROSCOPE|STEAM|STEAMGAMES|PLAYSTATION|PSN|NINTENDO|XBOX|EPIC GAMES|LIBRAIRIE|HOTEL|HOTELS|AIRBNB|BOOKING COM|BOOKING|EXPEDIA|ABRITEL|CAMPING|CLUB MED|CENTER PARCS|FDJ|PMU|BETCLIC|WINAMAX|UNIBET|CASINO BARRIERE|PARTOUCHE|BOWLING|PISCINE|PATINOIRE|REMONTEES MECANIQUES") },
  { category: "shopping", pattern: words("AMAZON|AMZN|AMAZON MKTP|FNAC|DARTY|BOULANGER|IKEA|LEROY MERLIN|CASTORAMA|BRICORAMA|BRICO DEPOT|MR BRICOLAGE|WELDOM|DECATHLON|INTERSPORT|GO SPORT|ZARA|H M|UNIQLO|KIABI|PRIMARK|CELIO|BERSHKA|SEPHORA|NOCIBE|MARIONNAUD|YVES ROCHER|CDISCOUNT|ALIEXPRESS|SHEIN|TEMU|ETSY|EBAY|VINTED|LA REDOUTE|ZALANDO|ASOS|APPLE STORE|GIFI|LA FOIR FOUILLE|HEMA|MAISONS DU MONDE|CONFORAMA|ALINEA|CULTURA|NATURE ET DECOUVERTES|GALERIES LAFAYETTE|PRINTEMPS|BHV|KING JOUET|JOUE CLUB|PICWICTOYS") },
];

export interface CategoryRule { key: string; category: BankCategory }

/// The category of a transaction: the person's rules first (their
/// counterparty), then cash, fees, taxes, income, savings, loans and rent,
/// then — unless it is a transfer between people — the shops and services.
export function categorize(input: { label: string; details?: string | null; counterparty?: string | null; amountCents: number; code?: string | null }, personRules: CategoryRule[] = []): BankCategory {
  const key = counterpartyKey(input.counterparty ?? counterpartyOf(input.label));
  const text = plainLabel(`${input.label} ${input.details ?? ""} ${input.counterparty ?? ""}`);
  if (key) {
    const own = personRules.find((rule) => rule.key === key);
    if (own) return own.category;
  }
  for (const rule of personRules) {
    if (rule.key.length >= 4 && ` ${text} `.includes(` ${rule.key} `)) return rule.category;
  }
  const direction: Direction = input.amountCents < 0 ? "out" : "in";
  const code = (input.code ?? "").toUpperCase();
  if (WITHDRAWAL.test(text) || code === "ATM") return "cash";
  if (code === "FEE" || code === "SRVCHG") return "bank_fees";
  for (const rule of RULES) {
    if ((!rule.only || rule.only === direction) && rule.pattern.test(text)) return rule.category;
  }
  // A transfer is a transfer, unless it comes from or goes to a service
  // (« VIR SEPA RECU /DE CPAM PARIS » is a health refund): its counterparty
  // alone is read, not the reason written with it.
  if (TRANSFER.test(text) || code === "XFER") {
    const who = plainLabel(input.counterparty ?? counterpartyOf(input.label) ?? "");
    const service = who ? MERCHANT_RULES.find((rule) => (!rule.only || rule.only === direction) && rule.pattern.test(who)) : undefined;
    return service?.category ?? "transfers";
  }
  for (const rule of MERCHANT_RULES) {
    if ((!rule.only || rule.only === direction) && rule.pattern.test(text)) return rule.category;
  }
  if (code === "DIRECTDEP" && direction === "in") return "income";
  return "other";
}
