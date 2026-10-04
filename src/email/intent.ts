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
  /(?<![\p{L}\p{N}])(?:r[ée]ponds|r[ée]pondre|r[ée]pondez|r[ée]ponde)\s+(?:à|a)\s+(?!(?:cette|ma|ta|la|une|ces|mes|tes|ses|sa|son|mon|ton|question|ceci|cela|[çc]a|tout|toutes|tous)\b)\p{L}/iu,
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
