import { languageName } from "../chatContext.js";
import { fold } from "../intentText.js";
import { capabilityPlace, UI_LABELS, uiLabels, type UiLabels, type UiLanguage } from "../uiLabels.js";
import type { HomeUnused } from "./homeAssistant.js";

// An answer can never tell the person a device of their home was switched
// when nothing was (11/10/2026). « Allume la lumière de la cuisine », Home
// Assistant refusing Twoody's token: Qwen3.6 35B-A3B answered « La lumière
// de la cuisine s'allume. » though nothing had been sent (non-regression
// bench); Qwen3.5 9B may say « C'est fait » without calling control_home
// (AGENTS.md §8). As for a refused draft (email/chat.ts NOT_SAVED): the
// tool result says « NOT DONE » with the sentence to say in the person's
// language, and when no command for the home succeeded in the turn, an
// answer that still says it is done or happening is held and replaced by
// that sentence (routes/queries.ts).

/// Why nothing was switched: Maison not used (HomeUnused, which holds
/// Home Assistant's own errors), or the model not calling control_home.
export type HomeNotDoneReason = HomeUnused | "not_called";

type Why = (labels: UiLabels, place: string, detail: string) => string;
interface NotDoneWords { lead: string; why: Record<HomeNotDoneReason, Why> }

/// The sentence, in the ten languages of the app, the screens named as the
/// person's app names them (`locale`): « I couldn't do that » and why,
/// with what to do. None of them reads as a claim (claimsHomeDone), nor as
/// one to the bench (twoody-bench/regress/run.mts CLAIMS_DONE: no « done »,
/// « hecho », « erledigt », « しました »).
const NOT_DONE: Record<UiLanguage, NotDoneWords> = {
  fr: {
    lead: "Je n'ai pas pu le faire : ",
    why: {
      not_called: () => "la commande n'a pas été envoyée à Home Assistant. Redemandez-le en nommant l'appareil.",
      left_out: (l) => `l'outil ${l.home} n'est pas utilisé pour ce message. Activez ${l.home} dans ${l.tools}, sous le champ de saisie, puis redemandez.`,
      off: (l, place) => `la capacité ${l.home} est désactivée dans Twoody. Activez-la dans ${place}.`,
      not_configured: (_l, place) => `Home Assistant n'est pas encore configuré dans Twoody. Indiquez son adresse et un jeton dans ${place}.`,
      unauthorized: (_l, place) => `Home Assistant a refusé le jeton d'accès de Twoody. Donnez-en un nouveau dans ${place}.`,
      unreachable: (_l, place) => `Home Assistant ne répond pas sur le réseau. Vérifiez qu'il fonctionne, et son adresse dans ${place}.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant ne connaît pas cet appareil${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `« ${detail} »` : "l'appareil"} ne répond pas à Home Assistant : il est peut-être débranché ou hors du réseau.`,
      unsupported: (_l, _p, detail) => `cet appareil ne peut pas faire cela${detail ? ` (${detail})` : ""}.`,
      failed: () => "Home Assistant n'a pas pu le faire.",
    },
  },
  en: {
    lead: "I couldn't do that: ",
    why: {
      not_called: () => "the command was not sent to Home Assistant. Ask again, naming the device.",
      left_out: (l) => `${l.home} is not used for this message. Enable ${l.home} in ${l.tools}, under the message field, then ask again.`,
      off: (l, place) => `${l.home} is disabled in Twoody. Enable it in ${place}.`,
      not_configured: (_l, place) => `Home Assistant is not set up in Twoody yet. Give its address and a token in ${place}.`,
      unauthorized: (_l, place) => `Home Assistant refused Twoody's access token. Give a new token in ${place}.`,
      unreachable: (_l, place) => `Home Assistant does not answer on the network. Check that it is running, and its address in ${place}.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant does not know this device${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `“${detail}”` : "the device"} does not answer Home Assistant: it may be unplugged or not on the network.`,
      unsupported: (_l, _p, detail) => `this device cannot do that${detail ? ` (${detail})` : ""}.`,
      failed: () => "Home Assistant could not do it.",
    },
  },
  de: {
    lead: "Das konnte ich nicht ausführen: ",
    why: {
      not_called: () => "Der Befehl wurde nicht an Home Assistant gesendet. Bitte fragen Sie noch einmal und nennen Sie das Gerät.",
      left_out: (l) => `${l.home} ist für diese Nachricht nicht aktiv. Aktivieren Sie ${l.home} unter ${l.tools} unter dem Eingabefeld und fragen Sie dann erneut.`,
      off: (l, place) => `${l.home} ist in Twoody deaktiviert. Aktivieren Sie es unter ${place}.`,
      not_configured: (_l, place) => `Home Assistant ist in Twoody noch nicht eingerichtet. Geben Sie unter ${place} seine Adresse und einen Token ein.`,
      unauthorized: (_l, place) => `Home Assistant hat den Zugriffstoken von Twoody abgelehnt. Geben Sie unter ${place} einen neuen Token ein.`,
      unreachable: (_l, place) => `Home Assistant antwortet nicht im Netzwerk. Prüfen Sie, ob es läuft, und seine Adresse unter ${place}.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant kennt dieses Gerät nicht${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `„${detail}“` : "Das Gerät"} antwortet Home Assistant nicht: Es ist vielleicht ausgesteckt oder nicht im Netzwerk.`,
      unsupported: (_l, _p, detail) => `Dieses Gerät kann das nicht${detail ? ` (${detail})` : ""}.`,
      failed: () => "Home Assistant konnte es nicht ausführen.",
    },
  },
  es: {
    lead: "No he podido hacerlo: ",
    why: {
      not_called: () => "la orden no se ha enviado a Home Assistant. Vuelve a pedirlo indicando el dispositivo.",
      left_out: (l) => `${l.home} no está activado para este mensaje. Actívalo en ${l.tools}, debajo del campo de texto, y vuelve a pedirlo.`,
      off: (l, place) => `${l.home} está desactivado en Twoody. Actívalo en ${place}.`,
      not_configured: (_l, place) => `Home Assistant aún no está configurado en Twoody. Indica su dirección y un token en ${place}.`,
      unauthorized: (_l, place) => `Home Assistant ha rechazado el token de acceso de Twoody. Introduce uno nuevo en ${place}.`,
      unreachable: (_l, place) => `Home Assistant no responde en la red. Comprueba que esté funcionando y su dirección en ${place}.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant no conoce este dispositivo${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `«${detail}»` : "el dispositivo"} no responde a Home Assistant: puede que esté desenchufado o fuera de la red.`,
      unsupported: (_l, _p, detail) => `este dispositivo no puede hacer eso${detail ? ` (${detail})` : ""}.`,
      failed: () => "Home Assistant no ha podido hacerlo.",
    },
  },
  it: {
    lead: "Non sono riuscito a farlo: ",
    why: {
      not_called: () => "il comando non è stato inviato a Home Assistant. Chiedilo di nuovo indicando il dispositivo.",
      left_out: (l) => `${l.home} non è attivo per questo messaggio. Attiva ${l.home} in ${l.tools}, sotto il campo di testo, e poi chiedi di nuovo.`,
      off: (l, place) => `${l.home} è disattivato in Twoody. Attivalo in ${place}.`,
      not_configured: (_l, place) => `Home Assistant non è ancora configurato in Twoody. Inserisci il suo indirizzo e un token in ${place}.`,
      unauthorized: (_l, place) => `Home Assistant ha rifiutato il token di accesso di Twoody. Inseriscine uno nuovo in ${place}.`,
      unreachable: (_l, place) => `Home Assistant non risponde sulla rete. Controlla che sia in funzione e il suo indirizzo in ${place}.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant non conosce questo dispositivo${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `«${detail}»` : "il dispositivo"} non risponde a Home Assistant: forse è scollegato o fuori rete.`,
      unsupported: (_l, _p, detail) => `questo dispositivo non può farlo${detail ? ` (${detail})` : ""}.`,
      failed: () => "Home Assistant non è riuscito a farlo.",
    },
  },
  pt: {
    lead: "Não consegui fazer isso: ",
    why: {
      not_called: () => "o comando não foi enviado ao Home Assistant. Peça de novo indicando o dispositivo.",
      left_out: (l) => `${l.home} não está ativado para esta mensagem. Ative ${l.home} em ${l.tools}, abaixo do campo de texto, e peça de novo.`,
      off: (l, place) => `${l.home} está desativado no Twoody. Ative em ${place}.`,
      not_configured: (_l, place) => `o Home Assistant ainda não está configurado no Twoody. Informe o endereço e um token em ${place}.`,
      unauthorized: (_l, place) => `o Home Assistant recusou o token de acesso do Twoody. Informe um novo em ${place}.`,
      unreachable: (_l, place) => `o Home Assistant não responde na rede. Verifique se ele está funcionando e o endereço em ${place}.`,
      unknown_entity: (_l, _p, detail) => `o Home Assistant não conhece este dispositivo${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `“${detail}”` : "o dispositivo"} não responde ao Home Assistant: talvez esteja fora da tomada ou fora da rede.`,
      unsupported: (_l, _p, detail) => `este dispositivo não pode fazer isso${detail ? ` (${detail})` : ""}.`,
      failed: () => "o Home Assistant não conseguiu fazer isso.",
    },
  },
  nl: {
    lead: "Dat is me niet gelukt: ",
    why: {
      not_called: () => "het commando is niet naar Home Assistant gestuurd. Vraag het opnieuw en noem het apparaat.",
      left_out: (l) => `${l.home} is voor dit bericht niet actief. Activeer ${l.home} in ${l.tools}, onder het invoerveld, en vraag het opnieuw.`,
      off: (l, place) => `${l.home} is niet actief in Twoody. Activeer het in ${place}.`,
      not_configured: (_l, place) => `Home Assistant is nog niet ingesteld in Twoody. Geef het adres en een token op in ${place}.`,
      unauthorized: (_l, place) => `Home Assistant heeft het toegangstoken van Twoody geweigerd. Geef een nieuw token op in ${place}.`,
      unreachable: (_l, place) => `Home Assistant antwoordt niet op het netwerk. Controleer of het draait, en het adres in ${place}.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant kent dit apparaat niet${detail ? ` (${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `„${detail}”` : "Het apparaat"} antwoordt Home Assistant niet: misschien zit de stekker er niet in of is het niet met het netwerk verbonden.`,
      unsupported: (_l, _p, detail) => `dit apparaat kan dat niet${detail ? ` (${detail})` : ""}.`,
      failed: () => "Home Assistant kon het niet uitvoeren.",
    },
  },
  ja: {
    lead: "実行できませんでした。",
    why: {
      not_called: () => "Home Assistant にコマンドを送っていません。機器の名前を添えて、もう一度お願いします。",
      left_out: (l) => `このメッセージでは${l.home}が使われていません。入力欄の下の${l.tools}で${l.home}をオンにしてから、もう一度お願いします。`,
      off: (l, place) => `Twoody で${l.home}が無効になっています。${place}で有効にしてください。`,
      not_configured: (_l, place) => `Twoody に Home Assistant がまだ設定されていません。${place}でアドレスとトークンを入力してください。`,
      unauthorized: (_l, place) => `Home Assistant が Twoody のアクセストークンを受け付けませんでした。${place}で新しいトークンを入力してください。`,
      unreachable: (_l, place) => `Home Assistant がネットワーク上で応答しません。動作しているか、${place}のアドレスを確認してください。`,
      unknown_entity: (_l, _p, detail) => `Home Assistant はこの機器を認識していません${detail ? `（${detail}）` : ""}。`,
      unavailable: (_l, _p, detail) => `${detail ? `「${detail}」` : "機器"}が Home Assistant に応答しません。電源が抜けているか、ネットワークにつながっていない可能性があります。`,
      unsupported: (_l, _p, detail) => `この機器ではそれはできません${detail ? `（${detail}）` : ""}。`,
      failed: () => "Home Assistant で実行できませんでした。",
    },
  },
  zh: {
    lead: "没能完成：",
    why: {
      not_called: () => "命令没有发送给 Home Assistant。请再说一次，并说出设备名称。",
      left_out: (l) => `这条消息没有使用${l.home}。请在输入框下方的${l.tools}中启用${l.home}，然后再说一次。`,
      off: (l, place) => `Twoody 中的${l.home}已停用。请在${place}中启用。`,
      not_configured: (_l, place) => `Twoody 中还没有设置 Home Assistant。请在${place}中填写它的地址和令牌。`,
      unauthorized: (_l, place) => `Home Assistant 拒绝了 Twoody 的访问令牌。请在${place}中提供新的令牌。`,
      unreachable: (_l, place) => `Home Assistant 在网络上没有响应。请检查它是否在运行，以及${place}中的地址。`,
      unknown_entity: (_l, _p, detail) => `Home Assistant 不认识这个设备${detail ? `（${detail}）` : ""}。`,
      unavailable: (_l, _p, detail) => `${detail ? `“${detail}”` : "设备"}没有响应 Home Assistant：可能没有插电或不在网络上。`,
      unsupported: (_l, _p, detail) => `这个设备不能这样做${detail ? `（${detail}）` : ""}。`,
      failed: () => "Home Assistant 没能执行。",
    },
  },
  ko: {
    lead: "실행하지 못했습니다. ",
    why: {
      not_called: () => "Home Assistant에 명령을 보내지 않았습니다. 기기 이름을 말씀하시고 다시 요청해 주세요.",
      left_out: (l) => `이 메시지에서는 ${l.home} 기능이 사용되지 않았습니다. 입력란 아래의 ${l.tools}에서 ${l.home} 기능을 사용하도록 설정한 뒤 다시 요청해 주세요.`,
      off: (l, place) => `Twoody에서 ${l.home} 기능이 비활성화되어 있습니다. ${place}에서 활성화해 주세요.`,
      not_configured: (_l, place) => `Twoody에 Home Assistant가 아직 설정되지 않았습니다. ${place}에서 주소와 토큰을 입력해 주세요.`,
      unauthorized: (_l, place) => `Home Assistant가 Twoody의 액세스 토큰을 거부했습니다. ${place}에서 새 토큰을 입력해 주세요.`,
      unreachable: (_l, place) => `Home Assistant가 네트워크에서 응답하지 않습니다. 실행 중인지, 그리고 ${place}의 주소를 확인해 주세요.`,
      unknown_entity: (_l, _p, detail) => `Home Assistant가 이 기기를 알지 못합니다${detail ? `(${detail})` : ""}.`,
      unavailable: (_l, _p, detail) => `${detail ? `'${detail}'` : "기기"}이(가) Home Assistant에 응답하지 않습니다. 전원이 빠졌거나 네트워크에 연결되지 않았을 수 있습니다.`,
      unsupported: (_l, _p, detail) => `이 기기는 그 작업을 할 수 없습니다${detail ? `(${detail})` : ""}.`,
      failed: () => "Home Assistant가 실행하지 못했습니다.",
    },
  },
};

const codeOf = (language: string | null | undefined): UiLanguage => {
  const code = (language ?? "fr").split(/[-_]/)[0]!.toLowerCase();
  return (code in NOT_DONE ? code : "en") as UiLanguage;
};

/// What the person is told when nothing was switched: in `language` (the
/// language of their message; French when none is told, as the other
/// sentences of the chat), the screens as their app (`locale`) names them.
export function homeNotDoneSentence(reason: HomeNotDoneReason, language: string | null | undefined, locale: string | null = null, detail = ""): string {
  const words = NOT_DONE[codeOf(language)];
  const why = (words.why[reason] ?? words.why.failed)(uiLabels(locale), capabilityPlace(locale, "home"), detail);
  return `${words.lead}${why}`;
}

/// The tool result when no device was switched: « NOT DONE », the reason,
/// and the sentence to say in the person's language.
export function homeNotDoneResult(lines: string[], sentence: string, language: string | null | undefined): string {
  const name = languageName(codeOf(language));
  return `NOT DONE. Nothing was switched in the user's home:\n${lines.join("\n")}\n` +
    `Answer in one short sentence in ${name} that it was not done and why, such as « ${sentence} ». ` +
    "Never say or suggest that a device is on, off, open, closed, set, switching, done or about to be: nothing was done. Do not call control_home again in this answer.";
}

// ─── What reads as « it is done » ──────────────────────────────────────────

/// A device said switched or switching — or « done » — in the app's ten
/// languages, on fold()ed text (no accents, lower case, ' for ’). Matched
/// clause by clause; a clause that denies it (DENIED) does not count.
const ACTION = new RegExp([
  // A whole clause: « C'est fait. », « Done! », « Listo. », « Fatto. ».
  String.raw`^(?:c'est fait|fait|voila|(?:all )?done|it'?s done|erledigt|listo|hecho|ya esta|fatto|ecco fatto|feito|pronto|gedaan|klaar)$`,
  // French: « c'est fait », « s'allume », « j'ai éteint », « va s'allumer ».
  // « s'allumera » (once Maison is on) and « pour qu'elle s'allume » are no
  // claims.
  String.raw`c'est fait|(?<!qu'(?:il|elle)s? )(?<!\bne )s'(?:allumen?t?|eteint|eteignent|ouvren?t?)(?![a-z])|(?<!\bne )se fermen?t?(?![a-z])|(?:va|vont) (?:s'allumer|s'eteindre|s'ouvrir|se fermer)`,
  String.raw`(?:j'ai|je l'ai|je les ai|twoody a|nous avons)(?: \S+){0,2}? (?:allume|eteint|ouvert|ferme|regle|baisse|monte|tamise|mis|lance|active|coupe|rallume)e?s?(?![a-z])|je viens d(?:'|e )(?:l'|les |la |le )?(?:allumer|eteindre|ouvrir|fermer|regler|baisser|mettre|lancer)`,
  // English: « turned on », « I've switched », « turning on the… ».
  String.raw`(?<!(?:is|are|was|were|be|been) (?:already |now |still )?)(?<![a-z])(?:turned|switched|powered|flipped) (?:\S+ ){0,4}?(?:on|off)(?![a-z])|(?<![a-z])(?:turning|switching) (?:\S+ ){0,4}?(?:on|off)(?![a-z])|(?<![a-z])(?:turns|switches) (?:\S+ ){0,2}?(?:on|off)(?![a-z])|(?<![a-z])(?:i'?ve|i have|i) (?:just |now )?(?:turned|switched|set|dimmed|opened|closed|started)(?![a-z])|(?:comes|came|goes|went) (?:on|off)(?![a-z])|(?:dimmed|brightened) to \d`,
  // German: « erledigt », « ich habe … eingeschaltet », « geht an ».
  String.raw`erledigt|(?:habe|hab|haben|wurde|wurden|wird|werden)(?: \S+){0,6}? (?:(?:ein|an|aus|ab)geschaltet|(?:an|aus)gemacht|geoffnet|geschlossen|gedimmt)|(?:geht|gehen|schaltet sich|schalten sich) (?:jetzt |nun |gleich )?(?:an|aus|ein)(?![a-z])|(?:gedimmt|eingestellt|gestellt|gesetzt) auf \d|auf \d{1,3} ?% (?:gedimmt|eingestellt|gestellt|gesetzt)`,
  // Spanish: « he apagado », « encendí », « se enciende ».
  String.raw`he (?:\S+ )?(?:encendido|apagado|prendido|abierto|cerrado|ajustado|puesto|bajado|subido)|(?<![a-z])(?:encendi|apague|prendi)(?![a-z])|(?<!\bno )se (?:encienden?|apagan?|prenden?|abren?|cierran?)(?![a-z])`,
  // Italian: « ho spento », « si accende ».
  String.raw`ho (?:\S+ )?(?:acceso|spento|aperto|chiuso|regolato|abbassato|alzato|impostato|messo)|(?<!\bnon )si (?:accendono|accende|spegne|spengono|apre|aprono|chiude|chiudono)(?![a-z])`,
  // Portuguese: « liguei », « acendi », « apaguei ».
  String.raw`(?<![a-z])(?:des)?liguei(?![a-z])|(?<![a-z])(?:acendi|apaguei|abri|fechei|ajustei)(?![a-z])`,
  // Dutch: « aangezet », « ingeschakeld », « gaat aan ».
  String.raw`(?:aan|uit)gezet|(?:in|uit)geschakeld|(?:aan|uit)gedaan|(?:gaat|gaan) (?:nu |weer )?(?:aan|uit)(?![a-z])|(?:gedimd|ingesteld|gezet) op \d|(?:heb|hebben|is|zijn|werd|wordt) (?:\S+ ){0,4}?(?:geopend|gesloten)(?![a-z])`,
  // Japanese: « つけました », « 消しました », « 点灯しました », « つきました ».
  "(?:つけ|点け|付け|消し|開け|閉め)(?:ました|ておきました|てあります|た(?:よ|$))|(?:点灯|消灯|調光|設定|調整|変更|実行)(?:しました|済み)|(?:つき|点き|消え|開き|閉まり)ました|(?:オン|オフ)に(?:しました|なりました)",
  // Chinese: « 打开了 », « 已开启 », « 关掉了 », « 灯亮了 ».
  "(?:已经?|已为您|为您)(?:打开|开启|关闭|关掉|关上|调到|调至|调为|设置|设为|打開|開啟|關閉|關掉)|(?:打开|开启|关闭|关掉|关上|打開|開啟|關閉|關掉|开)了|调(?:到|至|为)了|亮了|灭了|^好了|完成了|已完成|已执行|正在(?:打开|开启|关闭|关掉)",
  // Korean: « 켰습니다 », « 켜졌어요 », « 껐습니다 », « 완료 ».
  "켰|켜졌|켜\\s?두었|켜\\s?드렸|껐|꺼졌|꺼\\s?드렸|열었|닫았|열렸|닫혔|조정했|설정했|맞췄|완료",
].join("|"), "u");

/// A device said in the state asked: « est allumée », « is now on »,
/// « ist an », « está encendida ». Read as a claim unless the states were
/// read from Home Assistant and it says « already » (ALREADY).
const STATE = new RegExp([
  String.raw`(?:est|sont|a ete|ont ete|reste|restent)(?: \S+){0,2}? (?:allumee?s?|eteinte?s?|ouverte?s?|fermee?s?|reglee?s?|baissee?s?|tamisee?s?|mise?s? a \d|a \d{1,3} ?%)(?![a-z])`,
  String.raw`(?<![a-z])(?:is|are|was|were) (?:now |back |already |still )?(?:(?:turned |switched )?(?:on|off)|open|closed|dimmed|set to)(?![a-z])(?! (?:the|a|an|your|my|this|that|for|in|at|of)\b)`,
  String.raw`(?:ein|an|aus|ab)geschaltet|(?:an|aus)gemacht|(?:ist|sind|bleibt) (?:jetzt |nun |wieder |bereits |schon )?(?:an|aus|offen|zu|geoffnet|geschlossen|gedimmt)(?![a-z])`,
  String.raw`(?<![a-z])(?:encendid|apagad|prendid)[oa]s?(?![a-z])|(?:ajustad|puest|bajad|subid)[oa]s? al? \d`,
  // « acceso » alone is Spanish for « access »: Italian with its verb only.
  String.raw`(?<![a-z])(?:accesa|accese|accesi|spent[oaie])(?![a-z])|(?<![a-z])(?:e|sono|resta|rimane|stato|gia|ora|adesso) (?:\S+ )?acceso(?![a-z])|(?:regolat|impostat|abbassat)[oaie] al? \d`,
  String.raw`(?<![a-z])(?:des)?ligad[oa]s?(?![a-z])|(?<![a-z])aces[oa]s?(?![a-z])|(?:ajustad|colocad|definid)[oa]s? (?:em|para|a) \d`,
  String.raw`(?:staat|staan|is|zijn) (?:nu |weer |al )?(?:aan|uit|open|dicht)(?![a-z])`,
  "(?:つい|点い|消え|開い|閉まっ)ています|(?:オン|オフ)になっています|点灯中",
  "开着|亮着|关着|灭着|已经是开|已经是关",
  "켜져\\s?있|꺼져\\s?있|열려\\s?있|닫혀\\s?있",
].join("|"), "u");

/// A clause that says it was not done (« n'est pas allumée », « nicht
/// eingeschaltet », « つけられませんでした », « 没有打开 », « 켜지 못했 »).
const DENIED = /(?<![\p{L}])(?:not|nothing|no|never|neither|nor|unable|cannot|failed|nicht|nichts|kein\p{L}*|weder|noch|pas|rien|aucun\p{L}*|ni|jamais|impossible|nada|ningun\p{L}*|nunca|non|nulla|nessun\p{L}*|mai|nao|nenhum\p{L}*|nem|niet|niets|geen|nooit|mislukt)(?![\p{L}])|n't(?![\p{L}])|ませ|ない|なかった|せず|できず|没|未|不|无法|無法|않|안\s|못|없/iu;

/// Words that make a sentence a condition, a purpose or a possibility, not a
/// report: « si vous activez Maison, la lumière s'allume », « pour qu'elle
/// s'allume », « once it is on », « wenn … », « もし…たら », « 如果 », « 만약 ».
const HYPOTHETICAL = /(?:^|\s)(?:if|when|once|wenn|falls|sobald|cuando|quando|als|zodra|wanneer|des que|une fois que|lorsque|quand|pour que|afin que|so that|in order to|damit|para que|perche|affinche|zodat|assim que|appena|una vez que)\s|^si\s|もし|たら|れば|ように|如果|一旦|只要|要是|为了|만약|(?:하|되|으|이)면\s|도록/u;
/// « Déjà allumée », « already on », « 이미 켜져 있습니다 »: the state as Home
/// Assistant gave it, true when it was read (stateKnown).
const ALREADY = /(?:^|\s)(?:deja|already|still|toujours|bereits|schon|ya|todavia|gia|ja|ainda|al (?:aan|uit|open|dicht))(?:\s|$)|すでに|既に|もう|已经是|本来|还是|이미|벌써/u;

/// The answer says a device of the home was switched, is switching, is in
/// the state asked, or that it is done — in the app's ten languages. A
/// question (« Voulez-vous que je l'allume ? »), a clause that denies it, a
/// condition or a purpose (« pour qu'elle s'allume, … »), and — when the
/// states were read from Home Assistant (`stateKnown`) — « already on » are
/// no claims.
export function claimsHomeDone(answer: string, options: { stateKnown?: boolean } = {}): boolean {
  const text = answer.normalize("NFC").replace(/[«»"“”„*]/g, " ");
  // Sentences with what ends them: a question is no claim.
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*/gu) ?? [];
  return sentences.some((sentence) => {
    if (/[?？]\s*$/u.test(sentence)) return false;
    const plain = sentence.replace(/[.!?。！？]+\s*$/u, "").trim();
    if (!plain || HYPOTHETICAL.test(fold(plain))) return false;
    const clauses = plain.split(/[,;:，；：、]+|\s(?:mais|but|aber|pero|ma|mas|maar)\s|但是|但|하지만|けど|が、/u);
    return clauses.some((clause) => {
      const said = fold(clause).trim().replace(/\s+/g, " ");
      if (!said || DENIED.test(said)) return false;
      if (ACTION.test(said)) return true;
      // « Zuhause ist für diese Nachricht ausgeschaltet », « Maison est
      // éteinte dans Outils »: the capability, not a device (Qwen3.5 9B,
      // bench of 12/10/2026).
      if (CAPABILITY.test(clause)) return false;
      return STATE.test(said) && !(options.stateKnown && ALREADY.test(said));
    });
  });
}

/// The app's own names for Maison, « Outils » and « Capacités » in the ten
/// languages, as written (capitalised: « la lumière de la maison » is a
/// house), and Home Assistant: a clause about them is about the capability.
const CAPABILITY = new RegExp(`(?<![\\p{L}])(?:Home Assistant|${[...new Set(Object.values(UI_LABELS).flatMap((labels) => [labels.home, labels.tools, labels.capabilities]))].map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`, "u");

/// What the person sees when no command for the home succeeded in the turn:
/// the model's answer, or — when it says it is done, or says nothing — the
/// plain sentence in their language, with the reason.
export function answerWithoutHomeClaim(answer: string, sentence: string, options: { stateKnown?: boolean } = {}): { text: string; corrected: boolean } {
  if (answer.trim() && !claimsHomeDone(answer, options)) return { text: answer, corrected: false };
  return { text: sentence, corrected: true };
}
