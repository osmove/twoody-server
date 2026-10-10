// Whether a message plainly asks about the person's e-mails: then the server
// looks them up itself and gives them with the message (email/chat.ts
// emailsForMessage), as documents are read up front. Measured on Qwen3.5 9B
// (bench of 04/10/2026): left to the model, « Réponds à René que c'est
// d'accord pour jeudi » asked for the e-mail's id, « What did Claire ask me
// last month? » and « Est-ce que j'ai reçu une facture de Tessane ? » were
// answered « Voulez-vous que je cherche ? »; and a call required of it
// (`tool_choice: "required"`) is not enforced by llama.cpp. Pure, tested
// without a model (test/emailChat.test.ts).

import { fold } from "../intentText.js";

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

// The same questions in the other languages of the app (10/10/2026: « Hat
// Paul mir diese Woche geschrieben? », « ¿Paul me ha escrito? », « Paul这周
// 给我写信了吗？ » named no e-mail and were left to the model, which
// answered from nowhere). Matched on fold()ed text: no accents, lower case.
const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const FOLDED: RegExp[] = [
  // Someone wrote, sent, answered: « hat Paul mir geschrieben », « me ha
  // escrito », « mi ha scritto », « me escreveu », « heeft Paul me gemaild ».
  new RegExp(`${L}(?:hat|haben|hatte|hatten)${R}[^.?!]{0,60}?${L}(?:mir|uns)${R}[^.?!]{0,40}?${L}(?:geschrieben|gemailt|geschickt|gesendet|geantwortet|zuruckgeschrieben)${R}`, "u"),
  new RegExp(`${L}(?:hat|haben)\\s+[\\p{L}.'\\- ]{1,40}?\\s+(?:geantwortet|zuruckgeschrieben|zuruckgemailt)${R}`, "u"),
  new RegExp(`${L}me\\s+(?:(?:ha|han|habia|habian)\\s+)?(?:escrito|escribio|escribieron|enviado|envio|enviaron|mandado|mando|mandaron|contestado|contesto|contestaron|respondido|respondio|respondieron)${R}`, "u"),
  new RegExp(`${L}mi\\s+(?:(?:ha|hanno|aveva)\\s+)?(?:scritto|scrisse|mandato|inviato|risposto|rispose)${R}`, "u"),
  new RegExp(`${L}me\\s+(?:escreveu|escreveram|mandou|mandaram|enviou|enviaram|respondeu|responderam)${R}`, "u"),
  new RegExp(`${L}(?:heeft|hebben|had)${R}[^.?!]{0,60}?${L}(?:me|mij|ons)${R}[^.?!]{0,40}?${L}(?:geschreven|gemaild|gestuurd|geantwoord|teruggeschreven|gemaild)${R}`, "u"),
  new RegExp(`${L}(?:heeft|hebben)\\s+[\\p{L}.'\\- ]{1,40}?\\s+(?:geantwoord|gereageerd|teruggeschreven)${R}`, "u"),
  // Received: « habe ich … erhalten », « he recibido », « ho ricevuto »,
  // « recebi algum… », « heb ik … ontvangen ».
  new RegExp(`${L}(?:habe|hab|haben)\\s+(?:ich|wir)${R}[^.?!]{0,40}?(?:${L}erhalten${R}|${L}vo[nm]${R}[^.?!]{0,30}?${L}bekommen${R})`, "u"),
  new RegExp(`${L}(?:(?:he|hemos|has)\\s+recibido|recibi)${R}`, "u"),
  new RegExp(`${L}(?:ho|abbiamo|hai)\\s+ricevut[oaie]${R}`, "u"),
  new RegExp(`${L}(?:eu\\s+)?(?:recebi|recebemos)\\s+(?:algum|alguma|algo|nada|um|uma|o|a|os|as|e-?mails?|mensage(?:m|ns)|respostas?)${R}`, "u"),
  new RegExp(`${L}(?:heb|hebben)\\s+(?:ik|wij|we)${R}[^.?!]{0,40}?${L}(?:ontvangen|binnengekregen)${R}`, "u"),
  // A draft named, the last exchange with someone: « Mach einen Entwurf für
  // Claire », « el último intercambio con Claire », « laatste berichten van Paul ».
  new RegExp(`${L}(?:entwurf|borrador|bozza|rascunho)${R}`, "u"),
  new RegExp(`${L}(?:(?:letzte[nrs]?|jungste[nrs]?) (?:austausch|nachrichten?|korrespondenz) (?:mit|von)|(?:el )?ultimos? (?:intercambio|mensajes?|correos?) (?:con|de)|(?:l')?ultim[oi] (?:scambio|messaggi?) (?:con|di|da)|(?:a )?ultimas? (?:troca|mensage(?:m|ns)|conversa) (?:com|de|do|da)|laatste (?:berichten?|uitwisseling|correspondentie) (?:met|van))${R}`, "u"),
  /とのやり(?:取|と)り|和.{1,8}的(?:最后|最近)(?:一次)?(?:沟通|往来|邮件|联系)|와의\s?(?:마지막\s?)?(?:대화|연락|메일)/u,
  // Awaiting the person's answer.
  new RegExp(`${L}(?:unbeantwortet|noch nicht beantwortet|(?:warten|wartet) auf (?:eine |meine )?antwort|sin (?:responder|contestar|respuesta)|(?:esperan|espera) (?:una |mi )?respuesta|senza risposta|in attesa di (?:una |mia )?risposta|aspettano (?:una )?risposta|sem resposta|(?:aguardando|esperando) (?:uma |a |minha )?resposta|onbeantwoord|nog niet beantwoord|wachten op (?:een |mijn )?antwoord)${R}`, "u"),
  // Japanese, Chinese, Korean: « Paulさんから連絡あった？ », « 书いてきた »,
  // « 给我写信了吗 », « 收到…回复 », « 나한테 연락했어? », « 답장 왔어? ».
  /から[^。？?！!]{0,15}(?:連絡|返信|返事|メッセージ|便り|何か(?:届|来)|届いた|届きました)|(?:書いて|送って)(?:きた|くれた|きました|くれました)|返信(?:して|を書いて|しといて|待ち)|未返信|返事して(?:い)?ない|受信|受け取(?:った|りました)/u,
  /给我(?:写|寫|发|發|回)(?:了|过|過)|给我(?:写|寫)信|给我回(?:信|复|覆)|回复(?:了)?我|收到(?:了|过)?[^。？?！!]{0,12}(?:信|回复|回覆|消息|邮件)|未回复|没(?:有)?回复|待回复|帮我回复|回复一下/u,
  /(?:나한테|저한테|나에게|저에게)\s?[^.?!]{0,20}?(?:썼|보냈|답장|연락)|답장(?:했|이\s?왔|왔|을\s?보냈|\s?(?:안|못)\s?한|하지\s?않은|\s?대기)|(?:메일|답장|연락|편지)(?:을|를|이)?\s?받았|(?:에게|한테)\s?답장(?:해|을\s?써)/u,
];

/// « Antworte Paul… », « Responde a Paul… », « Rispondi a Paul… », « Schreib
/// Paul, dass… »: to someone named (a capital), as WRITE_TO.
const ANSWER_TO_NAMED = new RegExp([
  String.raw`(?<![\p{L}\p{N}])(?:[Aa]ntworte(?:n Sie)?|[Rr]esponde|[Cc]ontesta|[Rr]esp[oó]ndele|[Cc]ont[eé]stale|[Rr]ispondi|[Rr]isponda|[Rr]espond[ae]|[Aa]ntwoord)\s+(?:(?:a|ao|à|al|alla|allo|aan)\s+)?(?!(?:Ja|Nee|Nein|Deutsch|Englisch|Kurz|Bitte|Ok|Sí|Si|Sim|No)(?![\p{L}]))\p{Lu}`,
  String.raw`(?<![\p{L}\p{N}])(?:[Ss]chreib(?:e|en Sie)?|[Ee]scr[ií]bele|[Ee]scribe|[Ss]crivi|[Ee]screv[ae]|[Ss]chrijf)\s+(?:(?:an|a|ad|para|pro|pra|ao|à|aan)\s+)?(?:(?:o|a)\s+)?\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?\s*,?\s+(?:dass|ob|que|che|dat|of|wegen|sobre|su|sobre|over)(?![\p{L}])`,
].join("|"), "u");

/// Writing in general, not to someone: « comment écrire un e-mail de
/// motivation ? », « how to write an email to a landlord », « wie schreibe
/// ich… », « 怎么写… ».
const GENERAL = /(?<![\p{L}\p{N}])(?:comment (?:[ée]crire|r[ée]diger|formuler|bien [ée]crire)|how (?:do i |to |should i )?(?:write|draft|word|phrase)|mod[eè]le d['’]e-?mail|template|wie (?:schreibe ich|schreibt man|formuliere ich|formuliert man)|vorlage|c[oó]mo (?:escribir|escribo|redactar|redacto)|plantilla|come (?:scrivere|si scrive|scrivo)|modello di|como (?:escrever|escrevo|redigir)|modelo de|hoe (?:schrijf ik|schrijf je|schrijft men)|sjabloon)(?![\p{L}\p{N}])|書き方|怎么写|怎麼寫|如何写|如何寫|어떻게\s?(?:써|쓰)/iu;

/// « Écris à Léa que… », « Envoie un mot à Marc »: to someone named (a
/// capital), whatever the verb's own case — tried on the message with its
/// first letter in lower case.
const WRITE_TO = /(?<![\p{L}\p{N}])(?:[ée]cris|[ée]crire|[ée]crivez|envoie|envoyer|envoyez|r[ée]dige|r[ée]diger|r[ée]digez|pr[ée]pare|pr[ée]parer)\s+(?:(?:un|une)\s+)?(?:(?:mot|brouillon|r[ée]ponse|message)\s+)?(?:à|a|pour)\s+(?!(?:Moi|Toi|Nous|Vous)\b)\p{Lu}/u;

export function aboutEmails(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 600 || GENERAL.test(text)) return false;
  if (PATTERNS.some((pattern) => pattern.test(text)) || WRITE_TO.test(text.replace(/^\p{Lu}/u, (letter) => letter.toLowerCase()))) return true;
  const folded = fold(text);
  return FOLDED.some((pattern) => pattern.test(folded)) || ANSWER_TO_NAMED.test(text);
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
const NOT_SOMEONE = /^(?:moi|toi|nous|vous|lui-m[êe]me|toi-m[êe]me|moi-m[êe]me|me|us|you|yourself|myself|it|this|that|everyone|siri|alexa|google|cortana|chatgpt|chat gpt|gemini|claude|copilot|twoody|l['’]assistant|the assistant|ton cerveau|tout le monde|mir|mich|uns|dir|euch|allen|m[ií]|nos|te|ti|todos|noi|voi|tutti|mim|n[óo]s|voc[êe]|mij|ons|jou|u|iedereen|私|僕|俺|わたし|あなた|自分|みんな|我|你|您|自己|大家|나|저|내|제|너|모두)$/iu;

/// Another way than the mail, named: a text, a call, a messaging app.
const OTHER_CHANNEL = /(?<![\p{L}\p{N}])(?:sms|textos?|whatsapp|signal|telegram|imessage|messenger|t[ée]l[ée]phone|appel(?:le|les|lez|er)?|coup de fil|vocal|de vive voix|en personne|text(?:s|ing)?|call|phone|anruf(?:en)?|ruf|telefon(?:isch)?|pers[öo]nlich|llam(?:a|ar|ada|ale)|tel[ée]fono|en persona|chiam(?:a|are|ata)|telefonata|di persona|ligu?e|ligar|liga[çc][ãa]o|telefonema|pessoalmente|bel|bellen|opbellen|telefoon|appje|persoonlijk)(?![\p{L}\p{N}])|電話|ライン|(?<![A-Za-z])LINE(?=で|に|へ|の|を)|直接|打电话|电话|電話|微信|短信|当面|전화|문자|카톡|카카오톡|직접/iu;

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

// The same request in the other languages of the app (10/10/2026: « Sag
// Mama, dass ich später komme », « Dile a mamá que llegaré tarde », « ママに
// 遅れるって伝えて », « 告诉妈妈我会晚点到 » were left to Qwen3.5 9B, which said
// it could not send messages). Whom is group 1.
const LEAD_ANY = String.raw`(?:^|[,.;:!?¡¿]\s*|(?<![\p{L}\p{N}])(?:und|bitte|dann|y|por favor|luego|e|per favore|poi|e|por favor|depois|en|alsjeblieft|alstublieft|dan|ook)\s+)`;
const NAME_WORDS = String.raw`\p{L}[\p{L}\-'’.]*(?:\s+\p{L}[\p{L}\-'’.]*){0,2}?`;
const whom = (articles: string, notWords: string) => String.raw`((?:(?:${articles})\s+)?(?!(?:${notWords})(?![\p{L}]))${NAME_WORDS})`;
const WHOM_DE = whom("meiner|meinem|meinen|meine|mein|der|dem|den|die|unserer|unserem|unseren|unsere", "mir|uns|dir|euch|ihnen|ihm|ihr|was|wie|wer|wann|warum|es|das|mal|doch|bitte|jemandem|bescheid");
const WHOM_ES = whom("mi|mis|tu|tus|el|la|los|las|nuestro|nuestra|nuestros|nuestras", "qu[eé]|c[oó]mo|qui[eé]n|cu[aá]ndo|todos|todo|nadie|alguien|m[ií]|ti|s[ií]|esta|este|eso");
const WHOM_IT = whom("mia|mio|mie|miei|la|il|lo|nostra|nostro", "me|te|noi|voi|che|cosa|come|chi|quando|tutti|questo|questa");
const WHOM_PT = whom("minha|meu|minhas|meus|o|a|os|as|nossa|nosso", "mim|me|n[oó]s|voc[eê]|que|como|quem|quando|todos|todo|isso|isto");
const WHOM_NL = whom("mijn|de|het|onze|ons", "me|mij|ons|je|jou|u|wat|hoe|wie|wanneer|het|dat|even|maar|iets");
const SAYING_DE = String.raw`(?=\s*,?\s*(?:dass|ob|wann|wo|:|$)(?![\p{L}]))`;
const SAYING_ES = String.raw`(?=\s*,?\s*(?:que|si|cuando|de que|:|$)(?![\p{L}]))`;
const SAYING_IT = String.raw`(?=\s*,?\s*(?:che|se|quando|di|:|$)(?![\p{L}]))`;
const SAYING_PT = String.raw`(?=\s*,?\s*(?:que|se|quando|:|$)(?![\p{L}]))`;
const SAYING_NL = String.raw`(?=\s*,?\s*(?:dat|of|wanneer|:|$)(?![\p{L}]))`;
const ES_TO = String.raw`\s+a\s+`;
const IT_TO = String.raw`\s*(?:a|al|alla|allo|ai|agli|alle|ad)\s+`;
const PT_TO = String.raw`\s+(?:à|a|ao|aos|às|pra|pro|pras|pros|para(?:\s+(?:o|a|os|as))?)\s+`;
const TELL_OTHER: RegExp[] = [
  // German: « Sag Mama, dass… », « Frag Paul, ob… », « Richte Paul aus, dass… »,
  // « Gib Paul Bescheid… », « Kannst du Mama sagen, dass… ».
  new RegExp(`${LEAD_ANY}(?:sag|sage|sagen sie|frag|frage|fragen sie|informiere|informieren sie|benachrichtige)\\s+${WHOM_DE}${SAYING_DE}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:richte|richten sie|teile|teilen sie)\\s+${WHOM_DE}\\s+(?:aus|mit)${SAYING_DE}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:gib|geben sie)\\s+${WHOM_DE}\\s+bescheid${SAYING_DE}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:kannst du|k[öo]nntest du|w[üu]rdest du|k[öo]nnen sie|k[öo]nnten sie)\\s+(?:bitte\\s+)?${WHOM_DE}\\s+(?:sagen|ausrichten|bescheid geben|fragen|mitteilen)${SAYING_DE}`, "iu"),
  // Spanish: « Dile a mamá que… », « Avisa a Paul de que… », « ¿Puedes decirle a mamá que…? ».
  new RegExp(`${LEAD_ANY}(?:di|dile|d[ií]gale|d[ií]selo|avisa|av[ií]sale|avise|pregunta|preg[úu]ntale|recu[ée]rdale|cu[ée]ntale|comun[ií]cale)${ES_TO}${WHOM_ES}${SAYING_ES}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:puedes|podr[ií]as|puede|podr[ií]a)\\s+(?:decirle|decir|avisarle|avisar|preguntarle|preguntar|recordarle|contarle|comunicarle)${ES_TO}${WHOM_ES}${SAYING_ES}`, "iu"),
  // Italian: « Di' alla mamma che… », « Avvisa Paul che… », « Puoi dire a mamma che… ».
  new RegExp(`${LEAD_ANY}(?:di'|dì|di|dica|dille|digli|chiedi|domanda|ricorda|riferisci)${IT_TO}${WHOM_IT}${SAYING_IT}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:avvisa|avverti|informa)\\s+${WHOM_IT}${SAYING_IT}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:puoi|potresti|pu[òo]|potrebbe)\\s+(?:dire|avvisare|chiedere|ricordare|riferire)${IT_TO}${WHOM_IT}${SAYING_IT}`, "iu"),
  // Portuguese: « Diga à mamãe que… », « Fala pro Paul que… », « Avisa o Paul que… ».
  new RegExp(`${LEAD_ANY}(?:diga|diz|fala|fale|conta|conte|pergunta|pergunte|lembra|lembre)${PT_TO}${WHOM_PT}${SAYING_PT}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:avisa|avise|informa|informe)\\s+(?:o\\s+|a\\s+)?${WHOM_PT}${SAYING_PT}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:(?:voc[êe]\\s+)?(?:pode|poderia|consegue))\\s+(?:dizer|falar|avisar|perguntar|contar|lembrar)${PT_TO}${WHOM_PT}${SAYING_PT}`, "iu"),
  // Dutch: « Zeg tegen mama dat… », « Laat Paul weten dat… », « Vraag Paul of… ».
  new RegExp(`${LEAD_ANY}(?:zeg|vertel|vraag|meld)\\s+(?:(?:het|even|maar)\\s+)?(?:(?:tegen|aan)\\s+)?${WHOM_NL}${SAYING_NL}`, "iu"),
  new RegExp(`${LEAD_ANY}laat\\s+${WHOM_NL}\\s+weten${SAYING_NL}`, "iu"),
  // Whom from the conversation: « Sag ihm, dass… », « Dile que… », « Digli che… ».
  new RegExp(`${LEAD_ANY}(?:sag|sage|frag|frage|richte)\\s+(ihm|ihr|ihnen)(?:\\s+aus)?${SAYING_DE}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:di|d[ií]ga|av[ií]sa|preg[úu]nta|recu[ée]rda|cu[ée]nta)(les?)${SAYING_ES}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:di|chiedi|ricorda|riferisci)l?(gli|le)${SAYING_IT}`, "iu"),
  new RegExp(`${LEAD_ANY}(?:kun je|kan je|kunt u|wil je|zou je)\\s+(?:(?:even|aan|tegen)\\s+)?${WHOM_NL}\\s+(?:zeggen|vertellen|laten weten|vragen)${SAYING_NL}`, "iu"),
];
/// Japanese, Chinese, Korean: whom is what comes before « に », after « 告诉 »,
/// before « 한테 » — the first place that names someone.
const TELL_CJK: RegExp[] = [
  /([^\s、。,，？?！!「」]{1,12}?)(?:に|へ)[^。？?！!]{0,60}?(?:伝えて|言っておいて|言っといて|言ってください|言って(?:おいて|くれる|もらえる)|知らせて|連絡して|聞いて(?:みて|おいて))/gu,
  /(?:告诉|告訴|转告|轉告|通知)([^\s，,。？?！!：:]{1,8}?)(?=我|他|她|你|我们|說|说|，|,|：|:|一声|一聲|明天|今天|今晚|晚上|下午|上午|要|会|會|不|已经|已經)/gu,
  /(?:跟|和|给|對|对)([^\s，,。？?！!：:]{1,8}?)(?:说|說|讲|講)(?:一下|一声|一聲)?/gu,
  /([^\s,.?!]{1,12}?)(?:한테|에게|께)\s?[^.?!]{0,60}?(?:전해\s?(?:줘|주세요|줄래|줄\s?수)|말해\s?(?:줘|주세요|줄래)|알려\s?(?:줘|주세요|줄래)|얘기해\s?(?:줘|주세요)|물어봐\s?(?:줘|주세요))/gu,
];
/// Not someone: a time, a day, a number (« 9時に彼に連絡して »: « 彼 »).
const CJK_NOT_WHOM = /\d|時|日|曜|頃|ごろ|まで|点|号|시|분|날|일$/u;

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
  for (const pattern of [...TELL, ...TELL_OTHER]) {
    const found = pattern.exec(text);
    const recipient = found?.[1]?.trim().replace(/[.,;:]+$/, "");
    if (!recipient || NOT_SOMEONE.test(recipient)) continue;
    return { recipient };
  }
  for (const pattern of TELL_CJK) {
    for (const found of text.matchAll(pattern)) {
      const recipient = found[1]?.trim();
      if (!recipient || NOT_SOMEONE.test(recipient) || CJK_NOT_WHOM.test(recipient)) continue;
      return { recipient };
    }
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

// The same yes and the same offer in the other languages of the app
// (10/10/2026): « Ja, bitte » to « Soll ich eine E-Mail an Mama entwerfen…? »,
// « はい » to « …メールを下書きしましょうか？ ». Matched on fold()ed text.
const YES_OTHER = new RegExp([
  String.raw`^\s*(?:ja|jawohl|gerne?|klar|naturlich|sicher|mach (?:das|es|nur)|bitte|si|claro|vale|dale|por favor|hazlo|adelante|de acuerdo|perfecto|certo|va bene|volentieri|fallo|procedi|perfetto|sim|pode|com certeza|faz|faca|beleza|isso|graag|ja graag|prima|doe maar|ga je gang|goed|prima|zeker)(?![\p{L}])`,
  String.raw`^\s*(?:はい|ええ|うん|お願い|おねがい|そうして|ぜひ|よろしく|頼む|たのむ|是的|好的|好啊|好吧|好呀|好(?=[，,。.!！\s]|$)|可以|行啊|行(?=[，,。.!！\s]|$)|对|對|嗯|麻烦|麻煩|请写|請寫|写吧|寫吧|네|예|응|좋아|그래|부탁|써\s?줘|해\s?줘)`,
].join("|"), "u");
/// Twoody's question in the other languages: an offer, a verb of writing
/// and the mail in one question.
const OFFER_WORDS = new RegExp(String.raw`(?<![\p{L}])(?:soll ich|sollen wir|mochten sie|mochtest du|willst du|darf ich|quieres que|quiere que|desea que|deseas que|te gustaria que|le gustaria que|vuoi che|desideri che|vuole che|preferisci che|posso|quer que|deseja que|gostaria que|wil je dat|wilt u dat|zal ik|mag ik)(?![\p{L}])|ましょうか|ますか|いたしましょうか|要我|需要我|要不要|我可以|我来|할까요|드릴까요|드릴\s?까요|할까|원하시`, "u");
const WRITE_WORDS = /schreib|entwerf|entwurf|verfass|aufsetz|redact|redacte|escrib|prepar|envi|scriv|redig|bozza|escrev|rascunho|opstel|schrijv|schrijf|concept|作成|書き|書い|下書き|起草|写|寫|草拟|草擬|拟|작성|써|쓰|초안/u;
const MAIL_WORDS = /e-?mails?|mails?|correos?|borrador|posta|bozza|rascunho|bericht|concept|メール|下書き|邮件|郵件|电邮|電郵|이메일|메일|초안/u;

function offeredDraft(answer: string): boolean {
  const end = answer.slice(-600);
  if (OFFERED.test(end)) return true;
  // Its questions, each on its own: « …? » or « …？ ».
  for (const question of fold(end).match(/[^.!?。！？\n]*[?？]/gu) ?? []) {
    if (OFFER_WORDS.test(question) && WRITE_WORDS.test(question) && MAIL_WORDS.test(question)) return true;
  }
  return false;
}

/// `askedFirst`: the request before was something to pass on, how not said
/// (passOnWithoutHow), which the server told the model to answer with that
/// very question: a yes to its question is a yes to the e-mail even when
/// the question forgot to name it (« 엄마에게 "늦는다고" 전해 드릴까요? »,
/// bench of 10/10/2026).
export function agreedToDraft(previousAnswer: string | null | undefined, message: string, askedFirst = false): boolean {
  const text = message.trim();
  // « Oui, mais plutôt par SMS »: another way.
  if (!previousAnswer || !text || text.length > 200 || !(YES.test(text) || YES_OTHER.test(fold(text))) || OTHER_CHANNEL.test(text)) return false;
  return offeredDraft(previousAnswer) || (askedFirst && /[?？]\s*$/u.test(previousAnswer.trim()) && !OTHER_CHANNEL.test(previousAnswer.slice(-300)));
}

/// A message about e-mails that asks for one to be written or answered
/// (« Réponds à Maître Dupont que… », « Écris un mail à Paul… »): a draft
/// announced and not made (« Je rédige un brouillon… ») is asked again.
const WRITING = /(?<![\p{L}\p{N}])(?:r[ée]ponds|r[ée]pondez|r[ée]pondre|[ée]cris|[ée]crivez|[ée]crire|r[ée]dige|r[ée]digez|r[ée]diger|envoie|envoyez|envoyer|pr[ée]pare|pr[ée]parez|pr[ée]parer|fais|faites|reply|respond|answer|write|draft|send|antworte|antworten|schreib|schreibe|schreiben|entwirf|entwerfen|schick|schicke|responde|contesta|resp[oó]ndele|cont[eé]stale|escribe|escr[ií]bele|redacta|env[ií]a|manda|rispondi|scrivi|prepara|invia|manda|responda|escreva|escreve|envie|antwoord|schrijf|stuur|beantwoord)(?![\p{L}\p{N}])|brouillon|entwurf|borrador|bozza|rascunho|concept|返信|書いて|下書き|作成して|送って|回复|回覆|写|寫|起草|답장|작성|써\s?줘|보내\s?줘|초안/iu;

export function asksForADraft(message: string): boolean {
  return aboutEmails(message) && WRITING.test(message);
}
