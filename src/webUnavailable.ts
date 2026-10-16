// « Recherche Internet » on for a message, and no web this time (Jimmy,
// 16/10/2026): no connection, a search engine that does not answer or
// turns the search away, the Desktop's search out of reach. The message was
// refused until then (« La recherche sur le web n'a pas marché : … », nothing
// sent); it is answered without the web now, and says so:
//
//   - the model is told on the last message — never in the system prompt,
//     which stays the same for the runtime's cache — that no web results
//     could be had and why, to answer from what it knows, and never to say
//     it searched nor to give a web source (webUnavailableNote);
//   - the answer starts with a line the server writes in the person's
//     language, « Pas de connexion à Internet : réponse sans recherche sur le
//     web. » (webUnavailableNotice), kept with the answer: the Mac, the
//     iPhone and the encrypted history show it alike, as the other sentences
//     the server writes into an answer (home/notDone.ts, email/chat.ts);
//   - what the model writes is read sentence by sentence before it goes out
//     (createWebClaimGuard): a claim to have searched the web (« D'après mes
//     recherches sur le web, », « I searched online », « 検索結果によると »,
//     ten languages), a citation [n] of no source of this turn, a list of
//     web « Sources » are taken out; what was taken out stays in the local
//     trace (`web.removed`).
//
// The search itself runs in Twoody Desktop's main process: in its window for
// this computer's app (twoody-desktop renderer/Chat.tsx sends `web_failed`
// with the message), through its door for the person's iPhone
// (webResearch.ts researchOnComputer).

/// Why there were no web results: no connection (« offline »), the search
/// engine that did not answer or refused (« engine »), anything else
/// (« failed »: the Desktop's search out of reach, busy, misconfigured).
export type WebFailure = "offline" | "engine" | "failed";
export const WEB_FAILURES: readonly WebFailure[] = ["offline", "engine", "failed"];

export function readWebFailure(value: unknown): WebFailure | null {
  return typeof value === "string" && (WEB_FAILURES as readonly string[]).includes(value) ? (value as WebFailure) : null;
}

/// A failure told by its words only (a Desktop that gives no reason): a
/// name that cannot be looked up or no route out is no connection; a search
/// engine that refused, timed out or closed the connection is the engine's.
const OFFLINE_WORDS = /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EADDRNOTAVAIL|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED)\b|no internet|offline/i;
const ENGINE_WORDS = /duckduckgo|brave|searxng|search engine|took too long|timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|answered \d{3}|turned the search away/i;

export function webFailureOf(message: string): WebFailure {
  if (OFFLINE_WORDS.test(message)) return "offline";
  if (ENGINE_WORDS.test(message)) return "engine";
  return "failed";
}

type Language = "fr" | "en" | "de" | "es" | "it" | "pt" | "nl" | "ja" | "zh" | "ko";

/// The line the answer starts with, in the app's ten languages. None of
/// them reads as a claim to the guard below, nor to the benches.
const NOTICE: Record<Language, Record<WebFailure, string>> = {
  fr: {
    offline: "Pas de connexion à Internet : réponse sans recherche sur le web.",
    engine: "Le moteur de recherche n'a pas répondu : réponse sans recherche sur le web.",
    failed: "La recherche n'a pas pu se faire : réponse sans recherche sur le web.",
  },
  en: {
    offline: "No Internet connection: answer without a web search.",
    engine: "The search engine did not answer: answer without a web search.",
    failed: "The search could not be done: answer without a web search.",
  },
  de: {
    offline: "Keine Internetverbindung: Antwort ohne Websuche.",
    engine: "Die Suchmaschine hat nicht geantwortet: Antwort ohne Websuche.",
    failed: "Die Suche war nicht möglich: Antwort ohne Websuche.",
  },
  es: {
    offline: "Sin conexión a Internet: respuesta sin búsqueda en la web.",
    engine: "El buscador no ha respondido: respuesta sin búsqueda en la web.",
    failed: "No se ha podido hacer la búsqueda: respuesta sin búsqueda en la web.",
  },
  it: {
    offline: "Nessuna connessione a Internet: risposta senza ricerca sul web.",
    engine: "Il motore di ricerca non ha risposto: risposta senza ricerca sul web.",
    failed: "Non è stato possibile fare la ricerca: risposta senza ricerca sul web.",
  },
  pt: {
    offline: "Sem conexão com a Internet: resposta sem pesquisa na web.",
    engine: "O mecanismo de busca não respondeu: resposta sem pesquisa na web.",
    failed: "Não foi possível fazer a pesquisa: resposta sem pesquisa na web.",
  },
  nl: {
    offline: "Geen internetverbinding: antwoord zonder te zoeken op het web.",
    engine: "De zoekmachine heeft niet geantwoord: antwoord zonder te zoeken op het web.",
    failed: "Het zoeken is niet gelukt: antwoord zonder te zoeken op het web.",
  },
  ja: {
    offline: "インターネットに接続されていません。ウェブ検索なしで回答します。",
    engine: "検索エンジンが応答しませんでした。ウェブ検索なしで回答します。",
    failed: "検索できませんでした。ウェブ検索なしで回答します。",
  },
  zh: {
    offline: "没有互联网连接：以下回答未经网络搜索。",
    engine: "搜索引擎没有响应：以下回答未经网络搜索。",
    failed: "无法进行搜索：以下回答未经网络搜索。",
  },
  ko: {
    offline: "인터넷에 연결되어 있지 않습니다. 웹 검색 없이 답변합니다.",
    engine: "검색 엔진이 응답하지 않았습니다. 웹 검색 없이 답변합니다.",
    failed: "검색을 할 수 없었습니다. 웹 검색 없이 답변합니다.",
  },
};

const languageOf = (language: string | null | undefined): Language => {
  const code = (language ?? "fr").split(/[-_]/)[0]!.toLowerCase();
  return (code in NOTICE ? code : "en") as Language;
};

/// The line the answer starts with: in `language` (the message's, else the
/// app's; French when none is told, as the chat's other sentences).
export function webUnavailableNotice(reason: WebFailure, language: string | null | undefined): string {
  return NOTICE[languageOf(language)][reason];
}

/// Every notice, for those who must tell an answer's notice from the model's
/// words (the benches, a client).
export function webUnavailableNotices(): string[] {
  return Object.values(NOTICE).flatMap((words) => Object.values(words));
}

const WHY: Record<WebFailure, string> = {
  offline: "this computer has no Internet connection",
  engine: "the search engine did not answer",
  failed: "the search could not be done",
};

/// What the model is told, on the last message only.
export function webUnavailableNote(reason: WebFailure): string {
  return `[No web search for this message: the user turned « Recherche Internet » on, but ${WHY[reason]}, so there are no web results. ` +
    "Answer from the conversation and what you already know: give what you know, even if it may be dated, rather than nothing. Only when the question is about something that changes (news, prices, schedules, weather, scores), add in a few words that your knowledge may be out of date: it stops at your training, not at today's date. " +
    "Never say or suggest that you searched the web, looked anything up online or read web pages, and give no web source or link as found now: there is none. " +
    "The app already tells the user that the search could not be done.]";
}

// ─── What reads as « I searched the web » ───────────────────────────────────

/// Lower case, Latin letters without their accents, one character for one
/// (the matches are cut out of the original text at the same places); kana
/// keep their marks (« ブ » is no « フ »).
function foldKeep(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
    const bare = /\p{Script=Latin}/u.test(ch) ? lower.normalize("NFD").replace(/\p{M}+/gu, "") : lower;
    out += bare.length === ch.length ? bare : lower;
  }
  return out.replace(/[’‘ʼ]/g, "'");
}

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;

/// Words that only say where what follows comes from — « d'après mes
/// recherches sur le web », « according to my search », « laut meiner
/// Recherche », « 検索結果によると », « 검색 결과에 따르면 »: put in place of
/// them, the same words from what the model knows (« D'après mes
/// connaissances, Canberra… », « Meines Wissens ist Canberra… »: the order of
/// the sentence holds in every language). « The search results show that… »
/// becomes « I know that… ». On folded text. What could be about a study or
/// the person's documents (« selon une recherche de l'Inserm », « 文書を検索
/// した結果 ») needs the web named, or « mes ». Japanese and Chinese clauses
/// end where the sentence was cut at « 、 » and « ， ».
interface Phrase { re: RegExp; language: Language; that?: true }

const KNOWN: Record<Language, { according: string; that: string }> = {
  fr: { according: "d'après mes connaissances", that: "je sais" },
  en: { according: "as far as I know", that: "I know" },
  de: { according: "meines Wissens", that: "ich weiß" },
  es: { according: "según lo que sé", that: "sé" },
  it: { according: "per quanto ne so", that: "so" },
  pt: { according: "pelo que sei", that: "sei" },
  nl: { according: "voor zover ik weet", that: "ik weet" },
  ja: { according: "私の知る限り", that: "私の知る限り" },
  zh: { according: "据我所知", that: "据我所知" },
  ko: { according: "제가 알기로는", that: "제가 알기로는" },
};

const phrase = (language: Language, source: string, that?: true): Phrase => ({ re: new RegExp(source, "gu"), language, ...(that ? { that } : {}) });

const PHRASES: Phrase[] = [
  phrase("fr", String.raw`${B}(?:d'apres|selon|apres) (?:mes|ma|nos|notre) (?:\S+ )?recherches?(?: (?:rapides?|effectuees?|faites|recentes))?(?: (?:sur|dans) (?:le web|internet|google|la toile|le net)| en ligne)?${E}`),
  phrase("fr", String.raw`${B}(?:d'apres|selon|apres) (?:une|la|cette|des|les|quelques) (?:\S+ )?recherches? (?:rapides? )?(?:sur (?:le web|internet|google|la toile|le net)|en ligne|web|google)${E}`),
  phrase("fr", String.raw`${B}(?:d'apres|selon) (?:les|mes|ces|des) (?:resultats|informations|sources|pages|sites|donnees) (?:de (?:la |ma |mes |cette )?recherches?|du web|web|d'internet|en ligne|trouvee?s(?: en ligne| sur (?:le web|internet))?|consultee?s|que j'ai (?:trouvee?s|consultee?s|lue?s))${E}`),
  phrase("fr", String.raw`${B}(?:d'apres|selon) (?:le web|internet|google|la toile)${E}`),
  phrase("fr", String.raw`${B}en (?:cherchant|recherchant|consultant|fouillant)(?: rapidement)? (?:sur |dans )?(?:le web|internet|google|la toile|en ligne)${E}`),
  phrase("fr", String.raw`${B}(?:une|ma|la) (?:\S+ )?recherche (?:rapide )?(?:sur (?:le web|internet|google)|en ligne|google) (?:montre|indique|revele|donne|confirme|suggere)${E}(?<conj> que| qu')?`, true),
  phrase("fr", String.raw`${B}(?:les|mes) resultats (?:de (?:la |ma )?recherche|web|en ligne)(?: \S+){0,2}? (?:montrent|indiquent|disent|donnent|revelent|confirment)${E}(?<conj> que| qu')?`, true),
  phrase("fr", String.raw`${B}j'ai (?:\S+ ){0,2}?(?:cherche|recherche|fait une recherche|effectue une recherche|regarde|verifie|consulte)(?: \S+){0,3}? (?:sur (?:le web|internet|google|la toile|le net)|en ligne)(?: \S+){0,2}? et (?:j'ai )?(?:trouve|vu|appris|constate|lu)${E}(?<conj> que| qu')`, true),
  phrase("en", String.raw`${B}(?:according to|based on|from|after|going by|per) (?:my|our) (?:\S+ )?(?:search(?:es)?|research|searching|look-?up)(?: (?:online|on the (?:web|internet)|of the (?:web|internet)))?${E}`),
  phrase("en", String.raw`${B}(?:according to|based on|from|going by|per) (?:the|these|those|some|a few|my) (?:\S+ )?(?:search results|web results|online (?:sources|results|information)|web (?:sources|pages)|(?:sources|pages|results|articles) (?:i|we) (?:found|read|checked|consulted|looked at))${E}`),
  phrase("en", String.raw`${B}(?:according to|per) (?:the )?(?:web|internet|google)${E}`),
  phrase("en", String.raw`${B}after (?:a (?:\S+ )?)?(?:search(?:ing)?|looking (?:it |this |that )?up)(?: \S+){0,2}? (?:online|on the (?:web|internet)|the (?:web|internet))${E}`),
  phrase("en", String.raw`${B}(?:a|my) (?:\S+ )?(?:web|online|internet|google) search (?:shows|showed|reveals|revealed|indicates|indicated|suggests|suggested|confirms|confirmed|says)${E}(?<conj> that)?`, true),
  phrase("en", String.raw`${B}(?:the )?(?:search|web|online) results (?:show|showed|indicate|indicated|suggest|suggested|say|said|confirm|confirmed)${E}(?<conj> that)?`, true),
  phrase("en", String.raw`${B}i (?:\S+ )?(?:searched|looked(?: it| this| that)? up|googled|checked|did a (?:\S+ )?search)(?: \S+){0,4}? (?:online|on the (?:web|internet)|the (?:web|internet)|on google) and (?:i )?(?:found|saw|learned|see|read)(?: out)?${E}(?<conj> that)`, true),
  phrase("de", String.raw`${B}(?:laut|nach|gema(?:ss|ß)|zufolge) (?:meiner|meinen|unserer) (?:\S+ )?(?:recherchen?|suche|internetrecherche|websuche|online-?recherche|suchergebnissen?)(?: (?:im (?:internet|web|netz)|online))?${E}`),
  phrase("de", String.raw`${B}(?:laut|nach|gema(?:ss|ß)) (?:den|der|einer|einigen) (?:\S+ )?(?:suchergebnissen|internetrecherche|websuche|online-?quellen|webseiten|quellen im (?:internet|netz|web)|(?:recherche|suche) (?:im (?:internet|web|netz)|online))${E}`),
  phrase("de", String.raw`${B}(?:meine (?:recherche|suche|internetrecherche)|die (?:suchergebnisse|internetrecherche|websuche)) (?:hat ergeben|ergab|ergibt|zeigt|zeigte|zeigen|besagen)${E}(?<conj>,? dass)?`, true),
  phrase("es", String.raw`${B}(?:segun|de acuerdo con|conforme a|basandome en|tras|despues de) (?:mi|mis) (?:\S+ )?(?:busquedas?|investigacion(?:es)?|consultas?)(?: (?:en|por) (?:internet|la web|google|la red)| en linea)?${E}`),
  phrase("es", String.raw`${B}(?:segun|de acuerdo con|conforme a|basandome en) (?:los|las|unos|unas) (?:\S+ )?(?:resultados de (?:la |mi )?busqueda|resultados (?:web|en linea|de internet)|fuentes (?:en linea|web|de internet|consultadas)|paginas (?:web|consultadas)|informaciones? (?:en linea|de internet|encontradas?))${E}`),
  phrase("es", String.raw`${B}(?:segun|de acuerdo con) (?:internet|la web|google)${E}`),
  phrase("es", String.raw`${B}(?:tras|despues de) (?:una|unas) (?:\S+ )?busquedas? (?:\S+ )?(?:en|por) (?:internet|la web|google)${E}`),
  phrase("es", String.raw`${B}(?:los )?resultados de (?:la |mi )?busqueda (?:muestran|indican|dicen|sugieren|confirman)${E}(?<conj> que)?`, true),
  phrase("es", String.raw`${B}(?:una|mi) (?:\S+ )?busqueda (?:en|por) (?:internet|la web|google) (?:muestra|indica|revela|confirma)${E}(?<conj> que)?`, true),
  phrase("it", String.raw`${B}(?:secondo|in base a(?:lla|lle|i|gli|l)?|stando a(?:lla|lle|i|gli|l)?|dalla|dalle|dopo) (?:la |le )?(?:mia|mie|nostra) (?:\S+ )?(?:ricerca|ricerche)(?: (?:su internet|sul web|in rete|online|su google))?${E}`),
  phrase("it", String.raw`${B}(?:secondo|in base a(?:lla|lle|i|gli|l)?|stando a(?:lla|lle|i|gli|l)?) (?:i |le |gli )?(?:\S+ )?(?:risultati (?:della (?:mia )?ricerca|del web|online)|fonti (?:online|web|consultate)|pagine (?:web|consultate)|informazioni (?:online|trovate|sul web))${E}`),
  phrase("it", String.raw`${B}(?:secondo|stando a) (?:internet|il web|google)${E}`),
  phrase("it", String.raw`${B}(?:dopo|da) una (?:\S+ )?ricerca (?:su internet|sul web|in rete|online|su google)${E}`),
  phrase("it", String.raw`${B}(?:i )?risultati della ricerca (?:mostrano|indicano|dicono|suggeriscono|confermano)${E}(?<conj> che)?`, true),
  phrase("pt", String.raw`${B}(?:segundo|de acordo com|com base n(?:a|as|o|os)|conforme|apos|depois d(?:a|e)) (?:a |as )?(?:minha|minhas|nossa) (?:\S+ )?(?:pesquisas?|buscas?)(?: (?:na internet|na web|no google|online))?${E}`),
  phrase("pt", String.raw`${B}(?:segundo|de acordo com|com base n(?:a|as|o|os)|conforme) (?:os |as )?(?:\S+ )?(?:resultados da (?:minha )?(?:pesquisa|busca)|resultados (?:da web|online|da internet)|fontes (?:online|da web|da internet|consultadas)|paginas (?:da web|consultadas)|informacoes (?:online|da internet|encontradas))${E}`),
  phrase("pt", String.raw`${B}(?:segundo|de acordo com) (?:a internet|a web|o google)${E}`),
  phrase("pt", String.raw`${B}(?:apos|depois de) uma (?:\S+ )?(?:pesquisa|busca) (?:na internet|na web|no google|online)${E}`),
  phrase("pt", String.raw`${B}(?:os )?resultados da (?:pesquisa|busca) (?:mostram|indicam|dizem|sugerem|confirmam)${E}(?<conj> que)?`, true),
  phrase("nl", String.raw`${B}(?:volgens|op basis van|na|uit) (?:mijn|onze) (?:\S+ )?(?:zoekresultaten|zoekopdracht|zoektocht|zoekactie|onderzoek|opzoekwerk)(?: (?:op|via) (?:internet|het web|google)| online)?${E}`),
  phrase("nl", String.raw`${B}(?:volgens|op basis van) (?:de|deze) (?:\S+ )?(?:zoekresultaten|online bronnen|webbronnen|webpagina's|bronnen (?:op internet|online))${E}`),
  phrase("nl", String.raw`${B}(?:volgens|op basis van) (?:internet|het web|google)${E}`),
  phrase("nl", String.raw`${B}(?:de )?zoekresultaten (?:laten zien|tonen|geven aan|wijzen uit|bevestigen)${E}(?<conj> dat)?`, true),
  phrase("ja", "(?<!(?:文書|ドキュメント|ファイル|資料|メール)を)(?:(?:ウェブ|web|ネット|インターネット|オンライン|グーグル|google)(?:で|を|上で)?)?(?:検索|調べ)(?:し)?(?:た|てみた)(?:結果|ところ)(?:によると|によれば|では)?$"),
  phrase("ja", "(?<!(?:文書|ドキュメント|ファイル|資料|メール)の)検索結果(?:によると|によれば|では|を見ると|から(?:は)?)"),
  phrase("ja", "(?:ウェブ|web|ネット|インターネット)上の(?:情報|記事)(?:によると|によれば|では)"),
  phrase("zh", "(?:根据|据|按照|依据|从)(?:我的)?(?:网络|网上|在线|互联网|网页)?(?:搜索|检索|查询)(?:到的)?(?:结果|资料|信息)(?:来看|显示|表明)?"),
  phrase("zh", "(?:根据|据|按照|依据)(?:网络|网上|在线|互联网|网页)(?:上的)?(?:信息|资料|结果|消息|报道)"),
  phrase("zh", "(?:经过|通过)(?:网络|网上|在线|互联网)?(?:搜索|查询|检索)$"),
  phrase("zh", "搜索结果(?:显示|表明)"),
  phrase("zh", "(?:我)?(?:在网上|在网络上|在互联网上|上网)(?:搜索|查询|查|搜|找)(?:了|过|到)(?:一下)?$"),
  phrase("ko", "(?:(?:웹|인터넷|온라인|구글)\\s?)?검색\\s?결과(?:에\\s?따르면|를\\s?보면|에\\s?의하면|로\\s?보면)"),
  phrase("ko", "(?:웹|인터넷|온라인|구글)에서\\s(?:찾아본|검색한|확인한|조회한)\\s(?:결과|바로는|내용에\\s?따르면)"),
  phrase("ko", "(?<!(?:문서|파일|자료|메일)(?:를|을|에서)\\s?)(?:찾아|검색해)\\s?(?:본\\s?결과(?:에\\s?따르면)?|보니|봤더니)"),
  phrase("ko", "(?:웹|인터넷|온라인)(?:상의|에\\s?있는)\\s?(?:정보|자료)에\\s?(?:따르면|의하면)"),
];

/// Clauses that say the web was searched, browsed or read: taken out with
/// the « and » that joins them to the rest (« He buscado en internet y la
/// capital es Canberra » → « La capital es Canberra »), the whole clause
/// otherwise — unless they deny it (« je n'ai pas pu chercher sur le web »).
/// On folded text; the web named, so that a search of the person's
/// documents (« j'ai cherché dans vos documents ») is no claim.
const CLAIM = new RegExp([
  // French.
  String.raw`${B}(?:j'ai|je l'ai|je les ai|nous avons|twoody a) (?:\S+ ){0,2}?(?:cherche|recherche|fouille|consulte|parcouru|verifie|regarde|trouve|lu|vu|navigue)e?s?(?: \S+){0,5}? (?:sur (?:le web|internet|google|la toile|le net|des sites|les sites|plusieurs sites)|en ligne)${E}`,
  String.raw`${B}(?:j'ai|nous avons) (?:\S+ )?(?:fait|effectue|lance|mene|realise) (?:une|des|quelques|plusieurs|ma) (?:\S+ )?recherches?(?: \S+){0,3}? (?:sur (?:le web|internet|google|la toile)|en ligne)${E}`,
  String.raw`${B}je viens de (?:chercher|rechercher|verifier|consulter|regarder|trouver)(?: \S+){0,4}? (?:sur (?:le web|internet|google)|en ligne)${E}`,
  String.raw`${B}j'ai (?:\S+ )?google${E}`,
  // English.
  String.raw`${B}(?:i|we)(?:'ve| have)? (?:\S+ ){0,2}?(?:searched|googled|browsed|looked(?: it| this| that)? up|checked|found|read|consulted|scanned)(?: \S+){0,5}? (?:online|on (?:the )?(?:web|internet|google)|the (?:web|internet)|(?:several |some |a few )?websites)${E}`,
  String.raw`${B}(?:i|we)(?:'ve| have)? (?:just )?googled${E}`,
  String.raw`${B}(?:i|we)(?:'ve| have)? (?:\S+ )?(?:did|ran|performed|made|conducted|done|run) (?:a|an|some|my) (?:\S+ )?(?:web|online|internet|google) search(?:es)?${E}`,
  // German.
  String.raw`${B}(?:ich|wir) (?:habe|hab|haben) (?:\S+ ){0,4}?(?:im (?:internet|web|netz)|online|bei google|auf (?:webseiten|websites)) (?:\S+ ){0,2}?(?:gesucht|recherchiert|nachgesehen|nachgeschaut|nachgeschlagen|gefunden|gelesen|gegoogelt)${E}`,
  String.raw`${B}(?:ich|wir) (?:habe|hab|haben) (?:\S+ ){0,3}?(?:gegoogelt|gegooglet)${E}`,
  String.raw`${B}(?:habe|hab) ich (?:\S+ ){0,3}?(?:im (?:internet|web|netz)|online) (?:\S+ ){0,2}?(?:gesucht|recherchiert|nachgesehen|gefunden|gelesen)${E}`,
  String.raw`${B}(?:ich|wir) (?:habe|hab|haben) (?:\S+ ){0,3}?(?:internetrecherche|websuche|online-?recherche|google-?suche) (?:durchgefuhrt|gemacht|angestellt)${E}`,
  // Spanish.
  String.raw`${B}(?:he|hemos) (?:\S+ )?(?:buscado|consultado|revisado|encontrado|leido|investigado|googleado|navegado)(?: \S+){0,4}? (?:(?:en|por) (?:internet|la web|google|la red|varios sitios|sitios web)|en linea)${E}`,
  String.raw`${B}(?:busque|consulte|revise|encontre|lei|investigue|googlee)(?: \S+){0,4}? (?:(?:en|por) (?:internet|la web|google|la red)|en linea)${E}`,
  String.raw`${B}(?:he |hemos )?(?:hecho|realizado|hice|realice|efectue|efectuado) (?:una|unas|varias) (?:\S+ )?busquedas?(?: \S+){0,2}? (?:(?:en|por) (?:internet|la web|google|la red)|en linea)${E}`,
  // Italian.
  String.raw`${B}(?:ho|abbiamo) (?:\S+ ){0,2}?(?:cercato|consultato|controllato|trovato|letto|verificato|googlato|navigato)(?: \S+){0,4}? (?:su internet|sul web|in rete|online|su google|nel web|su (?:vari|alcuni|diversi) siti)${E}`,
  String.raw`${B}(?:ho|abbiamo) (?:\S+ )?(?:fatto|effettuato|condotto) (?:una|delle|alcune) (?:\S+ )?ricerche?(?: \S+){0,2}? (?:su internet|sul web|in rete|online|su google)${E}`,
  // Portuguese.
  String.raw`${B}(?:pesquisei|busquei|procurei|consultei|verifiquei|encontrei|li|vi|chequei|googlei)(?: \S+){0,4}? (?:na internet|na web|no google|na rede|online|em (?:alguns|varios) sites)${E}`,
  String.raw`${B}(?:fiz|realizei|efetuei) (?:uma|umas|algumas) (?:\S+ )?(?:pesquisas?|buscas?)(?: \S+){0,2}? (?:na internet|na web|no google|online)${E}`,
  // Dutch.
  String.raw`${B}(?:ik|we|wij) (?:heb|hebben) (?:\S+ ){0,4}?(?:op (?:internet|het web)|online|via google|op google) (?:\S+ ){0,2}?(?:gezocht|opgezocht|gevonden|gelezen|nagekeken|bekeken|gegoogeld|gegoogled)${E}`,
  String.raw`${B}(?:ik|we|wij) (?:heb|hebben) (?:\S+ ){0,3}?(?:gegoogeld|gegoogled)${E}`,
  String.raw`${B}(?:heb|hebben) (?:ik|we|wij) (?:\S+ ){0,3}?(?:op (?:internet|het web)|online) (?:\S+ ){0,2}?(?:gezocht|opgezocht|gevonden|gelezen)${E}`,
  // Japanese.
  "(?:ウェブ|web|ネット|インターネット|オンライン|グーグル|google)(?:で|を|上で)[^。、]{0,8}?(?:検索|調べ|確認|探し)(?:しました|ました|てみました)",
  "(?<!(?:文書|ドキュメント|ファイル|資料|メール)を)検索(?:しました|してみました)",
  "ググりました|ググった",
  // Chinese.
  "(?:我|我们)(?:已经|刚刚|刚)?(?:在网上|在网络上|在互联网上|上网|通过网络|通过互联网)(?:搜索|查询|查|搜|找|查找|检索)(?:了|过|到)",
  "(?:我|我们)(?:已经|刚刚|刚)?(?:搜索|检索|查询)了(?:一下)?(?:网络|网上|互联网|谷歌|百度)",
  "(?:我|我们)(?:已经|刚刚|刚)?(?:用|通过)(?:谷歌|百度|搜索引擎)(?:搜索|查)",
  // Korean.
  "(?:웹|인터넷|온라인|구글)에서\\s?(?:[^\\s.。]{1,6}\\s?){0,2}?(?:검색|찾아|확인|조회)(?:했|해\\s?봤|해\\s?보았|하였)",
  "(?<!(?:문서|파일|자료|메일)(?:를|을|에서)\\s?)검색(?:했습니다|해\\s?봤습니다|해\\s?보았습니다|하였습니다|했어요|해봤어요)",
  "(?:웹|인터넷|온라인|구글)\\s?검색(?:을)?\\s?(?:했|해\\s?봤|해\\s?보았|하였)",
].join("|"), "u");

/// « and », « et », « und », « y »… joining a claim to the rest of its clause.
const JOINED_AFTER = /^[^\S\n]*(?:,[^\S\n]*)?(?:and|et|und|y|e|en|so|alors|also|entonces|quindi|entao|dus)[^\S\n]+/u;
const JOINED_BEFORE = /[^\S\n]+(?:and|et|und|y|e|en)[^\S\n]*$/u;
/// What follows « and » still has the claim's subject: « I searched online
/// and found no results » is one claim, dropped whole.
const SAME_SUBJECT = /^(?:found|find|saw|see|got|discovered|learned|read|could|j'ai|trouve|vu|lu|appris|constate|gefunden|gesehen|gelesen|habe|encontre|encontrado|vi|lei|trovato|visto|letto|encontrei|gevonden|gezien|gelezen)(?![\p{L}])/u;
/// « But », « mais »… left at the start of a sentence whose first clause went.
const LEADING_BUT = /^(?:but|mais|aber|pero|ma|mas|maar|and|et|und|y|e|en)[^\S\n]+/iu;

/// A clause that says it was not done or could not be (« je n'ai pas pu
/// chercher sur le web », « I couldn't search online », « 検索できませんでした »).
const DENIED = /(?<![\p{L}])(?:not|no|never|cannot|unable|without|nicht|nichts|kein\p{L}*|ohne|pas|aucun\p{L}*|jamais|impossible|sans|nunca|ningun\p{L}*|sin|non|mai|nessun\p{L}*|senza|nao|nenhum\p{L}*|sem|niet|geen|nooit|zonder)(?![\p{L}])|n't(?![\p{L}])|ませ|ない|なかった|できず|せず|没|未|不能|不了|无法|無法|못|않|없|안\s?(?:했|해)/u;

/// The removed parts of an answer, for the local trace.
export interface WebClaimRemoval {
  kind: "claim" | "citation" | "sources";
  text: string;
}

/// One clause: the words that say where it comes from in their place, a
/// claim taken out — null when nothing of the clause is left.
function clauseWithoutClaim(clause: string, removed: WebClaimRemoval[]): string | null {
  let text = clause;
  let folded = foldKeep(clause);
  const replace = (index: number, length: number, by: string) => {
    text = `${text.slice(0, index)}${by}${text.slice(index + length)}`;
    folded = `${folded.slice(0, index)}${foldKeep(by)}${folded.slice(index + length)}`;
  };
  for (const { re, language, that } of PHRASES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(folded))) {
      const by = that ? `${KNOWN[language].that}${text.slice(match.index + match[0].length - (match.groups?.conj?.length ?? 0), match.index + match[0].length)}` : KNOWN[language].according;
      removed.push({ kind: "claim", text: text.slice(match.index, match.index + match[0].length).trim() });
      replace(match.index, match[0].length, by);
      re.lastIndex = match.index + by.length;
    }
  }
  // Denied around the claim itself (« I haven't searched online », « ich
  // habe nicht im Internet gesucht »), not anywhere in the clause: « I
  // searched online and found no results » still says it searched.
  const claim = CLAIM.exec(folded);
  if (claim && !DENIED.test(folded.slice(Math.max(0, claim.index - 12), claim.index + claim[0].length))) {
    removed.push({ kind: "claim", text: text.slice(claim.index, claim.index + claim[0].length).trim() });
    const before = text.slice(0, claim.index);
    const after = text.slice(claim.index + claim[0].length);
    const joinedAfter = JOINED_AFTER.exec(foldKeep(after));
    if (!before.trim() && joinedAfter && !SAME_SUBJECT.test(foldKeep(after.slice(joinedAfter[0].length)))) text = after.slice(joinedAfter[0].length);
    else if (!after.replace(/[\s.!?。！？]+/gu, "") && JOINED_BEFORE.test(foldKeep(before))) text = before.replace(JOINED_BEFORE, "");
    else return null;
  }
  if (text === clause) return clause;
  // What is left, without the spaces and brackets the claim stood between.
  const tidy = text
    .replace(/\(\s*\)|（\s*）/gu, "")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/^[^\S\n]+|[^\S\n]+$/gu, "")
    .replace(/[^\S\n]+([,.;:!?])/g, "$1");
  return /[\p{L}\p{N}]/u.test(tidy) ? tidy : null;
}

/// A sentence (or a part of a line), with what it ends with: claims taken
/// out clause by clause, the first letter kept upper case.
function sentenceWithoutClaims(sentence: string, removed: WebClaimRemoval[]): string {
  const lead = /^\s*/u.exec(sentence)![0];
  const rest = sentence.slice(lead.length);
  const tail = /[\s.!?。！？…」』）)"”’*_]*$/u.exec(rest)![0];
  const body = rest.slice(0, rest.length - tail.length);
  if (!body.trim()) return sentence;
  const parts = body.split(/(,\s+|;\s+|:\s+|\s[-–—]\s|，|；|：|、)/u);
  const kept: string[] = [];
  let changed = false;
  let firstChanged = false;
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index]!;
    const cleaned = clauseWithoutClaim(clause, removed);
    if (cleaned !== clause) {
      changed = true;
      if (!kept.length) firstChanged = true;
    }
    if (cleaned === null) continue;
    kept.push(kept.length ? `${parts[index - 1] ?? " "}${cleaned}` : firstChanged ? cleaned.replace(LEADING_BUT, "") : cleaned);
  }
  if (!changed) return sentence;
  if (!kept.length) return tail.includes("\n") ? tail.slice(tail.indexOf("\n")) : "";
  let out = kept.join("");
  // « selon mes recherches, la capitale… » → « La capitale… », when the
  // sentence started with a capital.
  if (firstChanged && /^\P{L}*\p{Lu}/u.test(body)) out = out.replace(/^(\P{L}*)(\p{Ll})/u, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`);
  return `${lead}${out}${tail}`;
}

/// A citation [n] of no source of this turn, a numbered link to a page, a
/// footnote: there are no web results to cite. Inline code (`list[1]`) is
/// left alone.
function withoutCitations(text: string, sources: number, removed: WebClaimRemoval[]): string {
  const cut = (whole: string) => {
    removed.push({ kind: "citation", text: whole.trim() });
    return "";
  };
  return text.split(/(`[^`\n]*`)/u).map((part, index) => index % 2 ? part : part
    .replace(/[^\S\n]*\[(\d{1,3})\]\((?:https?:\/\/|www\.)[^)\s]*\)/gu, cut)
    .replace(/[^\S\n]*(?:【\d{1,3}(?:†[^】]*)?】|\[\^\d{1,3}\])/gu, cut)
    .replace(/[^\S\n]*\[(\d{1,3})\](?!\()/gu, (whole, n: string) => (Number(n) >= 1 && Number(n) <= sources ? whole : cut(whole))),
  ).join("");
}

/// « Sources : », « **References** », « Quellen », « 出典 », « 출처 » alone on
/// their line.
const SOURCES_HEADER = /^\s*(?:#{1,6}\s*)?[*_]{0,3}\s*(?:sources?|references?|quellen(?:angaben)?|fuentes|referencias|fonti|riferimenti|fontes|bronnen|referenties|出典|参考(?:文献|資料|情報|资料|来源|链接)?|情報源|来源|資料來源|출처|참고\s?(?:자료|문헌)?)\s*[*_]{0,3}\s*[:：]?\s*[*_]{0,3}\s*$/iu;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/u;
const LINK = /https?:\/\/|www\.[\p{L}\p{N}-]+\./u;
/// A line that starts with a citation's number: « [3] Le Monde – https://… ».
const REFERENCE = /^\s*(?:(?:[-*•]|\d{1,3}[.)])\s+)?(?:\[(\d{1,3})\]|【\d{1,3}[^】]*】|\[\^\d{1,3}\]:?)/u;

export interface WebClaimGuard {
  /// The model's next words: what may go out now (a sentence is judged once
  /// it is whole, a line once it is whole when its start asks for it).
  push(text: string): string;
  /// The end of the answer: the rest, judged.
  flush(): string;
  /// What was taken out so far.
  readonly removed: WebClaimRemoval[];
}

/// Where the first sentence or line of `text` ends (after its newline, or
/// after its end mark), or -1 while it may go on. « 1. » at the start of a
/// list item and « 2.5 » end nothing.
function pieceEnd(text: string, atLineStart: boolean): number {
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\n") return index + 1;
    if (char === "。" || char === "！" || char === "？") {
      let end = index + 1;
      while (end < text.length && /[」』）)"”’]/u.test(text[end]!)) end++;
      return end;
    }
    if (char === "." || char === "!" || char === "?") {
      const next = text[index + 1];
      if (next === undefined) return -1;
      if (next !== " " && next !== "\t") continue;
      if (atLineStart && /^\s*(?:\d{1,3}|[a-z])$/iu.test(text.slice(0, index))) continue;
      return index + 1;
    }
  }
  return -1;
}

/// The model's answer in a turn where the web brought nothing, read before
/// it goes out: claims to have searched, citations of no source of this
/// turn (`sources()`: how many the turn has, the person's documents), and a
/// block of « Sources » that lists web pages are taken out. Code between
/// ``` passes untouched.
export function createWebClaimGuard(options: { sources?: () => number } = {}): WebClaimGuard {
  const sources = options.sources ?? (() => 0);
  const removed: WebClaimRemoval[] = [];
  let pending = "";
  let lineStart = true;
  let fence = false;
  /// A « Sources » header (and the blank lines after it), until the next
  /// line says whether it lists web pages.
  let held: string[] = [];
  let sourcesBlock = false;
  /// Something of this line went out; something of it was taken out before
  /// anything did (the space that followed it goes too).
  let lineShown = false;
  let lineCut = false;

  const judgeText = (text: string) => sentenceWithoutClaims(withoutCitations(text, sources(), removed), removed);
  const release = () => {
    const out = held.join("");
    held = [];
    return out;
  };
  /// A web source's line, in a block of sources: an item of a list, a link,
  /// a citation's number — with the person's documents among the sources,
  /// only one that names a page or a number beyond them.
  const sourceLine = (line: string) => {
    const reference = REFERENCE.exec(line);
    if (reference && !(reference[1] && Number(reference[1]) <= sources())) return true;
    if (LINK.test(line)) return true;
    return sources() === 0 && LIST_ITEM.test(line);
  };
  /// A whole line, at the start of a line: fences, headers, sources.
  const judgeLine = (line: string): string => {
    const plain = line.replace(/\r?\n$/u, "");
    if (/^\s*(?:```|~~~)/u.test(plain)) {
      fence = !fence;
      return `${release()}${line}`;
    }
    if (fence) return line;
    if (!plain.trim()) {
      if (held.length || sourcesBlock) {
        held.push(line);
        return "";
      }
      return line;
    }
    if (SOURCES_HEADER.test(plain)) {
      held.push(line);
      return "";
    }
    const reference = REFERENCE.exec(plain);
    const listsWeb = reference && !(reference[1] && Number(reference[1]) <= sources());
    if (listsWeb || ((held.length || sourcesBlock) && sourceLine(plain))) {
      for (const one of held) if (one.trim()) removed.push({ kind: "sources", text: one.trim() });
      held = [];
      removed.push({ kind: "sources", text: plain.trim() });
      sourcesBlock = true;
      return "";
    }
    sourcesBlock = false;
    return `${release()}${judgeText(line)}`;
  };
  /// Whether the line that starts `text` must be judged whole: a fence, a
  /// header, a citation's number or a link at its start, or any line of a
  /// block of sources. Undecided (null) while too little of it came.
  const wholeLine = (text: string): boolean | null => {
    if (fence || held.length || sourcesBlock) return true;
    const newline = text.indexOf("\n");
    const start = (newline >= 0 ? text.slice(0, newline) : text).trimStart();
    if (newline < 0 && start.length < 16) return null;
    if (/^(?:```|~~~)/u.test(start) || REFERENCE.test(start) || /^(?:(?:[-*•]|\d{1,3}[.)])\s+)?(?:<?https?:\/\/|\[[^\]]*\]\(https?:\/\/)/u.test(start)) return true;
    return /^(?:#{1,6}\s*)?[*_]{0,3}\s*(?:sources?|references?|quellen|fuentes|referencias|fonti|riferimenti|fontes|bronnen|referenties|出典|参考|情報源|来源|資料來源|출처|참고)/iu.test(start);
  };

  /// What a piece of the line becomes: nothing left of the start of a line
  /// takes the space after it along (« Ik heb op internet gezocht. Canberra… »
  /// → « Canberra… »).
  const shown = (piece: string, judged: string): string => {
    let out = judged;
    if (!lineShown && lineCut) out = out.replace(/^[^\S\n]+/u, "");
    if (out.replace(/\n/g, "")) lineShown = true;
    else if (piece.trim()) lineCut = true;
    if (piece.endsWith("\n")) {
      lineShown = false;
      lineCut = false;
    }
    return out;
  };

  const drain = (final: boolean): string => {
    let out = "";
    while (pending) {
      if (lineStart) {
        const whole = wholeLine(pending);
        if (whole === null && !final) break;
        if (whole) {
          const newline = pending.indexOf("\n");
          if (newline < 0 && !final) break;
          const line = newline < 0 ? pending : pending.slice(0, newline + 1);
          pending = pending.slice(line.length);
          out += shown(line, judgeLine(line));
          lineStart = line.endsWith("\n");
          continue;
        }
      }
      let end = pieceEnd(pending, lineStart);
      if (end < 0) {
        if (!final) break;
        end = pending.length;
      }
      const piece = pending.slice(0, end);
      pending = pending.slice(end);
      out += fence ? piece : shown(piece, judgeText(piece));
      lineStart = piece.endsWith("\n");
    }
    return out;
  };

  return {
    push(text: string) {
      pending += text;
      return drain(false);
    },
    flush() {
      const out = drain(true);
      // A header with nothing after it, blank lines at the end: dropped.
      for (const one of held) if (one.trim()) removed.push({ kind: "sources", text: one.trim() });
      held = [];
      return out;
    },
    removed,
  };
}

/// What the guard takes out of a whole answer (the benches, the tests).
export function webClaimsIn(answer: string, sources = 0): WebClaimRemoval[] {
  const guard = createWebClaimGuard({ sources: () => sources });
  guard.push(answer);
  guard.flush();
  return guard.removed;
}

/// The answer says the web was searched, or gives a web source as found.
export function claimsWebSearch(answer: string, sources = 0): boolean {
  return webClaimsIn(answer, sources).length > 0;
}
