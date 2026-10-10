// Whether a message plainly asks about the person's e-mails: then the server
// looks them up itself and gives them with the message (email/chat.ts
// emailsForMessage), as documents are read up front. Measured on Qwen3.5 9B
// (bench of 04/10/2026): left to the model, « Réponds à René que c'est
// d'accord pour jeudi » asked for the e-mail's id, « What did Claire ask me
// last month? » and « Est-ce que j'ai reçu une facture de Tessane ? » were
// answered « Voulez-vous que je cherche ? »; and a call required of it
// (`tool_choice: "required"`) is not enforced by llama.cpp. Pure, tested
// without a model (test/emailChat.test.ts).

const PATTERNS: RegExp[] = [
  // The mail itself: « mes e-mails », « un courriel », « ma boîte mail », « inbox ».
  /(?<![\p{L}\p{N}])(?:e-?mails?|courriels?|mails?|inbox|bo[iî]te (?:mail|aux lettres|de r[ée]ception)|messagerie)(?![\p{L}\p{N}])/iu,
  // …and in the other languages of the app (10/10/2026): « meine E-Mails »,
  // « mis correos », « la mia posta », « 我的邮件 », « 받은 편지함 ».
  /(?<![\p{L}\p{N}])(?:e-?mail-?(?:postfach|adresse)?|posteingang|correos?(?: electr[óo]nicos?)?|bandeja de entrada|(?:la mia|nella mia|nella) posta|posta in arrivo|caixa de entrada|postvak(?: in)?|inbox)(?![\p{L}\p{N}])|メール|受信トレイ|邮件|郵件|收件箱|이메일|메일|받은\s?편지함/iu,
  // Someone wrote, sent, asked, answered: « René m'a écrit », « ce que Claire m'a demandé ».
  /(?<![\p{L}\p{N}])m['’]\s?(?:a|ont|avait|avaient|aurait)\s+(?:bien\s+)?(?:[ée]crit|envoy[ée]|r[ée]pondu|demand[ée]|transmis|relanc[ée]|propos[ée]|r[ée]clam[ée])/iu,
  /(?<![\p{L}\p{N}])(?:did|has|have)\s+(?!you\b|i\b)[\p{L}\p{N}'’.\- ]{1,40}?\s+(?:written|wrote|write|sent|send|asked|ask|emailed|e-mailed|mailed)\s+(?:me|us|to me|to us|back|anything|something)\b/iu,
  /(?<![\p{L}\p{N}])(?:did|has|have)\s+(?!you\b|i\b)[\p{L}\p{N}'’.\- ]{1,40}?\s+(?:replied|reply|answered|responded)\b/iu,
  /(?<![\p{L}\p{N}])(?:sent|wrote|asked|emailed|e-mailed|mailed|messaged)\s+(?:me|us)\b/iu,
  // Received: « ai-je reçu », « est-ce que j'ai reçu », « have I received ».
  /(?<![\p{L}\p{N}])(?:ai-je|avons-nous|aurais-je|ai-je bien)\s+(?:bien\s+)?re[çc]u/iu,
  /(?<![\p{L}\p{N}])(?:est-ce que|est ce que|si|savoir si)\s+(?:j['’]ai|nous avons|on a)\s+(?:bien\s+)?re[çc]u/iu,
  /(?<![\p{L}\p{N}])(?:have|did)\s+(?:i|we)\s+(?:ever\s+)?(?:received|receive)\b/iu,
  /(?<![\p{L}\p{N}])(?:did|have)\s+(?:i|we)\s+(?:got|get|gotten)\s+(?:an?\s+|any\s+|the\s+)?(?:e-?mails?|mails?|messages?|invoices?|bills?|repl(?:y|ies)|answers?|letters?|confirmations?|receipts?)\b/iu,
  // Answer someone, write to someone: « Réponds à René… », « Reply to Claire ».
  // A word's end is not \b: « Maître » is not « ma » (bench of 05/10/2026).
  /(?<![\p{L}\p{N}])(?:r[ée]ponds|r[ée]pondre|r[ée]pondez|r[ée]ponde)\s+(?:à|a)\s+(?!(?:cette|ma|ta|la|une|ces|mes|tes|ses|sa|son|mon|ton|question|ceci|cela|[çc]a|tout|toutes|tous)(?![\p{L}\p{N}]))\p{L}/iu,
  /(?<![\p{L}\p{N}])(?:reply|respond|answer|write back)\s+to\s+(?!(?:this|that|my|the|a|an|these|those|it)\b)\p{L}/iu,
  /(?<![\p{L}\p{N}])(?:draft|write|send)\s+(?:an?\s+)?(?:e-?mail|email|reply|response|message|note)\s+(?:back\s+)?to\b/iu,
  /(?<![\p{L}\p{N}])brouillon(?![\p{L}\p{N}])/iu,
  // An exchange with someone: « le dernier échange avec Claire ».
  /(?<![\p{L}\p{N}])(?:[ée]changes?|correspondance)\s+(?:avec|de)\s+\p{L}/iu,
  /(?<![\p{L}\p{N}])derni(?:er|ers|ère|ères)\s+messages?\s+(?:de|d['’])\s*\p{L}/iu,
  /(?<![\p{L}\p{N}])(?:last|latest|recent)\s+(?:exchange|conversation|thread|messages?)\s+(?:with|from)\b/iu,
  // Awaiting a reply.
  /(?<![\p{L}\p{N}])(?:attend(?:ent)?\s+(?:une\s+|ma\s+)?r[ée]ponse|sans r[ée]ponse|non r[ée]pondus?|[àa] r[ée]pondre)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:awaiting|waiting for|need(?:s|ing)?)\s+(?:a\s+|an\s+|my\s+)?(?:reply|response|answer)\b/iu,
  /(?<![\p{L}\p{N}])unanswered\b/iu,
];

/// Writing in general, not to someone: « comment écrire un e-mail de
/// motivation ? », « how to write an email to a landlord ».
const GENERAL = /(?<![\p{L}\p{N}])(?:comment (?:[ée]crire|r[ée]diger|formuler|bien [ée]crire)|how (?:do i |to |should i )?(?:write|draft|word|phrase)|mod[eè]le d['’]e-?mail|template)(?![\p{L}\p{N}])/iu;

/// « Écris à Léa que… », « Envoie un mot à Marc »: to someone named (a
/// capital), whatever the verb's own case — tried on the message with its
/// first letter in lower case.
const WRITE_TO = /(?<![\p{L}\p{N}])(?:[ée]cris|[ée]crire|[ée]crivez|envoie|envoyer|envoyez|r[ée]dige|r[ée]diger|r[ée]digez|pr[ée]pare|pr[ée]parer)\s+(?:(?:un|une)\s+)?(?:(?:mot|brouillon|r[ée]ponse|message)\s+)?(?:à|a|pour)\s+(?!(?:Moi|Toi|Nous|Vous)\b)\p{Lu}/u;

export function aboutEmails(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 600 || GENERAL.test(text)) return false;
  return PATTERNS.some((pattern) => pattern.test(text)) || WRITE_TO.test(text.replace(/^\p{Lu}/u, (letter) => letter.toLowerCase()));
}

// ─── « Dis à maman que… »: passing something on, without saying how ──────
//
// Jimmy (05/10/2026): « Dis à maman que je viens dimanche » may be an
// e-mail, a text, a call — Twoody asks « Voulez-vous que je rédige un e-mail
// à maman… ? » rather than guessing (a draft) or refusing (« je ne peux pas
// envoyer de messages », Qwen3.5 9B, 2 times in 3, bench of 05/10/2026).
// Said with the mail (« écris un mail à maman », « réponds à son mail »),
// it is no question: aboutEmails, a draft at once.

/// Someone the person cannot mean: an assistant, themselves, Twoody.
const NOT_SOMEONE = /^(?:moi|toi|nous|vous|lui-m[êe]me|toi-m[êe]me|moi-m[êe]me|me|us|you|yourself|myself|it|this|that|everyone|siri|alexa|google|cortana|chatgpt|chat gpt|gemini|claude|copilot|twoody|l['’]assistant|the assistant|ton cerveau|tout le monde)$/iu;

/// Another way than the mail, named: a text, a call, a messaging app.
const OTHER_CHANNEL = /(?<![\p{L}\p{N}])(?:sms|textos?|whatsapp|signal|telegram|imessage|messenger|t[ée]l[ée]phone|appel(?:le|les|lez|er)?|coup de fil|vocal|de vive voix|en personne|text(?:s|ing)?|call|phone)(?![\p{L}\p{N}])/iu;

/// Where an order to Twoody starts: the message's start, or after « stp, »,
/// « et », « Twoody, »… — not « Comment dire à mon patron… », a question.
const LEAD = String.raw`(?:^|[,.;:!?]\s*|(?<![\p{L}\p{N}])(?:et|puis|alors|aussi|stp|svp|s['’]il te pla[iî]t|s['’]il vous pla[iî]t|please|and|also)\s+)`;
/// …or an infinitive asked for: « Tu peux dire à Léa… », « Merci de prévenir Marc… ».
const ASKED = String.raw`(?:(?:est-ce que )?tu peux|peux-tu|tu pourrais|pourrais-tu|vous pouvez|pouvez-vous|pourriez-vous|tu veux bien|veux-tu|voulez-vous bien|merci de|j['’]aimerais que tu|je voudrais que tu|can you|could you|would you|will you)\s+(?:bien\s+|juste\s+|vite\s+)?`;
/// Whom: « maman », « ma sœur Julie », « Maître Dupont », « le plombier »
/// — as few words as come before what to say (no capitals told apart: the
/// patterns ignore case).
const WHOM = String.raw`((?:(?:ma|mon|mes|notre|nos|ta|ton|tes|la|le|les|l['’]|my|our)\s*)?(?!(?:quel|quelle|quels|quelles|quoi|combien|comment|qui|quand|partir|propos|peu|nouveau|chaque|tout|toute|tous|toutes|ce|cet|cette|ces|un|une|des|moi|toi|nous|vous|me|us|you|yourself|myself|it|this|that|a|an|the)(?![\p{L}]))\p{L}[\p{L}\-'’.]*(?:\s+\p{L}[\p{L}\-'’.]*){0,3}?)`;
/// What follows whom: what to say.
const SAYING = String.raw`(?=\s*(?:(?:que|de|du|des|si|quand|pour)(?![\p{L}])|qu['’]|d['’]|s['’]ils?(?![\p{L}])|:|,|$))`;
const SAYING_EN = String.raw`(?=\s*(?:that|know|to|if|whether|when|i|i['’]m|i['’]ll|i['’]ve|we|we['’]re|we['’]ll|:|,|$)(?![\p{L}]))`;

const TELL: RegExp[] = [
  // « Dis à maman que… », « Fais savoir à Paul… », « Demande au plombier s'il… ».
  new RegExp(`${LEAD}(?:dis|dites|redis|fais savoir|faites savoir|annonce|annoncez|rappelle|rappelez|transmets|transmettez|demande|demandez)\\s+(?:à|a|au|aux)\\s+${WHOM}${SAYING}`, "iu"),
  new RegExp(`${LEAD}${ASKED}(?:dire|redire|faire savoir|annoncer|rappeler|transmettre|demander)\\s+(?:à|a|au|aux)\\s+${WHOM}${SAYING}`, "iu"),
  // « Préviens Paul que… », « Avertis le syndic… ».
  new RegExp(`${LEAD}(?:pr[ée]viens|pr[ée]venez|avertis|avertissez|informe|informez)\\s+${WHOM}${SAYING}`, "iu"),
  new RegExp(`${LEAD}${ASKED}(?:pr[ée]venir|avertir|informer)\\s+${WHOM}${SAYING}`, "iu"),
  // « Dis-lui que… », « Préviens-la… »: whom, from the conversation.
  new RegExp(`${LEAD}(?:${ASKED})?(?:dis|dites|demande|demandez|transmets|transmettez|annonce|annoncez|rappelle|rappelez|fais|faites)-(lui|leur)(?![\\p{L}])`, "iu"),
  new RegExp(`${LEAD}(?:${ASKED})?(?:pr[ée]viens|pr[ée]venez|avertis|avertissez|informe|informez)-(le|la|les)(?![\\p{L}])`, "iu"),
  // « Tell Mum that… », « Let Paul know… », « Ask Marc whether… ».
  new RegExp(`${LEAD}(?:${ASKED})?(?:tell|ask|remind|let|inform|warn)\\s+${WHOM}${SAYING_EN}`, "iu"),
];

export interface TellRequest {
  /// Whom, as the person said it (« maman », « Maître Dupont », « lui »).
  recipient: string;
}

/// « Dis à maman que je viens dimanche »: something to pass on to someone,
/// how not said — null when it is not, when the mail is named (then it is
/// aboutEmails) or another way is (« par SMS »).
export function passOnWithoutHow(message: string): TellRequest | null {
  const text = message.trim().replace(/[’‘ʼ]/g, "'");
  if (!text || text.length > 600 || GENERAL.test(text) || OTHER_CHANNEL.test(text) || aboutEmails(text)) return null;
  for (const pattern of TELL) {
    const found = pattern.exec(text);
    const recipient = found?.[1]?.trim().replace(/[.,;:]+$/, "");
    if (!recipient || NOT_SOMEONE.test(recipient)) continue;
    return { recipient };
  }
  return null;
}

/// Twoody's question before (« Voulez-vous que je rédige un e-mail à
/// maman… ? ») and the person's yes (« oui », « vas-y, de ma boîte perso »):
/// the e-mail asked for, to be written now. A 9B model, told « oui », said
/// « Je vais rédiger le brouillon… » and asked for her address, or « je ne
/// peux pas l'envoyer » (bench of 05/10/2026).
const OFFERED = /(?:voulez-vous|souhaitez-vous|veux-tu|tu veux|vous voulez|dois-je|puis-je|je peux|faut-il|shall i|should i|do you want me to|would you like me to|want me to)[^?]{0,120}?(?:r[ée]dig|[ée]cri|pr[ée]par|envoi|envoy|draft|write|prepare|send)[^?]{0,120}?(?:e-?mails?|mails?|courriels?|brouillon|draft)[^?]{0,200}\?/iu;
const YES = /^\s*(?:oui|ouais|ouep|yes|yep|yeah|ok|okay|d['’]accord|dac|vas-y|allez-y|go|volontiers|parfait|bien s[uû]r|carr[ée]ment|absolument|exactement|avec plaisir|je veux bien|bonne id[ée]e|s['’]il te pla[iî]t|s['’]il vous pla[iî]t|stp|svp|please|sure|of course|do it|fais-le|faites-le|c['’]est parti)(?![\p{L}])/iu;

export function agreedToDraft(previousAnswer: string | null | undefined, message: string): boolean {
  const text = message.trim();
  // « Oui, mais plutôt par SMS »: another way.
  if (!previousAnswer || !text || text.length > 200 || !YES.test(text) || OTHER_CHANNEL.test(text)) return false;
  return OFFERED.test(previousAnswer.slice(-600));
}

/// A message about e-mails that asks for one to be written or answered
/// (« Réponds à Maître Dupont que… », « Écris un mail à Paul… »): a draft
/// announced and not made (« Je rédige un brouillon… ») is asked again.
const WRITING = /(?<![\p{L}\p{N}])(?:r[ée]ponds|r[ée]pondez|r[ée]pondre|[ée]cris|[ée]crivez|[ée]crire|r[ée]dige|r[ée]digez|r[ée]diger|envoie|envoyez|envoyer|pr[ée]pare|pr[ée]parez|pr[ée]parer|fais|faites|reply|respond|answer|write|draft|send)(?![\p{L}\p{N}])|brouillon/iu;

export function asksForADraft(message: string): boolean {
  return aboutEmails(message) && WRITING.test(message);
}
