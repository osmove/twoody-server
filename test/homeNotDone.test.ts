import assert from "node:assert/strict";
import test from "node:test";

// No answer may tell the person a device of their home was switched when
// nothing was (11/10/2026): « Allume la lumière de la cuisine », Home
// Assistant refusing the token, answered « La lumière de la cuisine
// s'allume. » by Qwen3.6 35B-A3B (non-regression bench). What reads as a
// claim, in the ten languages of the app, and what does not.

const { claimsHomeDone, answerWithoutHomeClaim, homeNotDoneSentence, homeNotDoneResult } = await import("../src/home/notDone.js");

const LANGUAGES = ["fr", "en", "de", "es", "it", "pt", "nl", "ja", "zh", "ko"] as const;
const REASONS = ["not_called", "left_out", "off", "not_configured", "unauthorized", "unreachable", "unknown_entity", "unavailable", "unsupported", "failed"] as const;

test("an answer that says it is done, switched or switching, in the ten languages, is a claim", () => {
  const claims: Record<string, string[]> = {
    fr: ["La lumière de la cuisine s'allume.", "C'est fait, la lumière du salon est allumée.", "J'ai allumé la lumière de la cuisine.", "C'est fait !", "La lumière de la cuisine est maintenant allumée.", "Je viens d'éteindre le salon.", "La lumière va s'allumer.", "La lumière du salon est à 30 %.", "Les volets se ferment.", "La lumière du salon s'éteint."],
    en: ["Done! The kitchen light is now on.", "I've turned on the kitchen light.", "Turning on the kitchen light.", "The kitchen light is on.", "I switched it off.", "All done.", "The living room light turns on."],
    de: ["Das Licht in der Küche ist jetzt eingeschaltet.", "Erledigt.", "Ich habe das Licht im Wohnzimmer ausgeschaltet.", "Das Licht ist jetzt an.", "Das Licht geht an.", "Das Wohnzimmerlicht ist auf 30 % gedimmt."],
    es: ["Listo, he encendido la luz de la cocina.", "La luz de la cocina está encendida.", "Encendí la luz.", "La luz se enciende.", "Ya está.", "He apagado la luz del salón."],
    it: ["Fatto! Ho acceso la luce della cucina.", "La luce della cucina è accesa.", "La luce si accende.", "Ho spento la luce del soggiorno.", "La luce è spenta."],
    pt: ["Pronto, liguei a luz da cozinha.", "A luz da cozinha está ligada.", "Acendi a luz.", "Desliguei a luz da sala.", "A luz está desligada."],
    nl: ["Ik heb het licht in de keuken aangezet.", "Het licht staat nu aan.", "Klaar.", "Het licht is uitgeschakeld.", "Het licht gaat aan."],
    ja: ["キッチンの照明をつけました。", "リビングの電気を消しました。", "照明が点きました。", "点灯しました。", "照明はついています。"],
    zh: ["已为您打开厨房的灯。", "厨房的灯打开了。", "灯亮了。", "好了，已经关掉了。", "客厅的灯已关闭。"],
    ko: ["주방 조명을 켰습니다.", "거실 불을 껐어요.", "조명이 켜졌습니다.", "완료했습니다.", "조명이 켜져 있습니다."],
  };
  for (const [lang, said] of Object.entries(claims)) for (const answer of said) assert.ok(claimsHomeDone(answer), `${lang}: ${answer}`);
});

test("a question, a denial, an explanation, a condition or a purpose is no claim", () => {
  for (const answer of [
    "Je n'ai pas pu allumer la lumière de la cuisine : Home Assistant a refusé le jeton d'accès. Donnez-en un nouveau dans Capacités → Maison.",
    "Voulez-vous que j'allume la lumière de la cuisine ?",
    "La lumière de la cuisine est-elle allumée ?",
    "Quelle lumière voulez-vous allumer : celle du salon ou celle du bureau ?",
    "Pour que la lumière s'allume, donnez un nouveau jeton dans Capacités → Maison.",
    "Une fois Maison activée, la lumière s'allumera.",
    "Si vous activez Maison, je pourrai allumer la lumière.",
    "La lumière ne s'allume pas : Home Assistant ne répond pas.",
    "Maison est désactivée pour ce message dans Outils, sous le champ de saisie.",
    "La lumière de la cuisine n'est pas allumée.",
    "I couldn't turn on the kitchen light: Home Assistant refused the token.",
    "Should I turn on the kitchen light?",
    "If you enable Home, I can turn it on.",
    "The light was not turned on.",
    "Home Assistant is off the network.",
    "Ich konnte das Licht nicht einschalten: Home Assistant hat den Token abgelehnt.",
    "Soll ich das Licht einschalten?",
    "Das Licht wurde nicht eingeschaltet.",
    "Wenn Sie Zuhause aktivieren, geht das Licht an.",
    "No he podido encender la luz: Home Assistant rechazó el token de acceso.",
    "¿Quieres que encienda la luz?",
    "La luz no está encendida.",
    "Non sono riuscito ad accendere la luce.",
    "La luce non è accesa.",
    "Il token di accesso è stato rifiutato.",
    "Não consegui ligar a luz.",
    "A luz não está ligada.",
    "Het licht is niet aangezet.",
    "Zal ik het licht aanzetten?",
    "キッチンの照明をつけられませんでした。Home Assistant がトークンを受け付けませんでした。",
    "照明をつけましょうか？",
    "厨房的灯没有打开。",
    "无法打开厨房的灯。",
    "要我打开厨房的灯吗？",
    "주방 조명을 켜지 못했습니다.",
    "조명을 켤까요?",
  ]) assert.ok(!claimsHomeDone(answer), answer);
});

test("« already on » is the state Home Assistant gave when it was read, a claim when it was not; « I already turned it on » always is", () => {
  assert.equal(claimsHomeDone("La lumière du salon est déjà allumée.", { stateKnown: true }), false);
  assert.equal(claimsHomeDone("La lumière du salon est déjà allumée."), true, "nothing read: no way to know");
  assert.equal(claimsHomeDone("The living room light is already on.", { stateKnown: true }), false);
  assert.equal(claimsHomeDone("Das Licht ist bereits an.", { stateKnown: true }), false);
  assert.equal(claimsHomeDone("거실 조명은 이미 켜져 있습니다.", { stateKnown: true }), false);
  assert.equal(claimsHomeDone("Ya la encendí.", { stateKnown: true }), true);
  assert.equal(claimsHomeDone("J'ai déjà allumé la lumière.", { stateKnown: true }), true);
});

test("the sentence said instead: in the person's language, with the reason and the app's own screens, never a claim itself", () => {
  for (const lang of LANGUAGES) {
    for (const reason of REASONS) {
      const said = homeNotDoneSentence(reason, lang, `${lang}-XX`, reason === "unavailable" ? "Lumière cuisine" : reason === "unknown_entity" ? "light.cuisine" : "");
      assert.ok(said.length > 10, `${lang} ${reason}`);
      assert.ok(!claimsHomeDone(said), `${lang} ${reason}: ${said}`);
      assert.ok(!claimsHomeDone(said, { stateKnown: true }), `${lang} ${reason}`);
    }
  }
  assert.equal(homeNotDoneSentence("unauthorized", "fr", "fr-FR"), "Je n'ai pas pu le faire : Home Assistant a refusé le jeton d'accès de Twoody. Donnez-en un nouveau dans Capacités → Maison.");
  assert.match(homeNotDoneSentence("unauthorized", "de", "de-DE"), /^Das konnte ich nicht ausführen: Home Assistant hat den Zugriffstoken von Twoody abgelehnt\. .*Fähigkeiten → Zuhause/);
  assert.match(homeNotDoneSentence("unreachable", "es", "es-ES"), /^No he podido hacerlo: Home Assistant no responde en la red\..*Capacidades → Casa/);
  assert.match(homeNotDoneSentence("left_out", "ja", "ja-JP"), /^実行できませんでした。.*ツール/);
  assert.match(homeNotDoneSentence("unavailable", "en", "en-US", "Kitchen light"), /“Kitchen light” does not answer Home Assistant/);
  assert.match(homeNotDoneSentence("off", "zh", "zh-CN"), /能力 → 家居/);
  assert.match(homeNotDoneSentence("not_called", "ko", "ko-KR"), /^실행하지 못했습니다\. Home Assistant에 명령을 보내지 않았습니다/);
  // A message in Spanish from a French app: the sentence in Spanish, the
  // screens as the app shows them.
  assert.match(homeNotDoneSentence("off", "es", "fr-FR"), /^No he podido hacerlo: .*Capacités → Maison/);
  // French when the language is not told; English for one the app has not.
  assert.match(homeNotDoneSentence("failed", null), /^Je n'ai pas pu le faire/);
  assert.match(homeNotDoneSentence("failed", "sv"), /^I couldn't do that/);
});

test("the answer is kept unless it claims, or says nothing; the tool result says « NOT DONE »", () => {
  const sentence = homeNotDoneSentence("unauthorized", "fr", "fr-FR");
  assert.deepEqual(answerWithoutHomeClaim("La lumière de la cuisine s'allume.", sentence), { text: sentence, corrected: true });
  assert.deepEqual(answerWithoutHomeClaim("", sentence), { text: sentence, corrected: true });
  assert.deepEqual(answerWithoutHomeClaim("Home Assistant a refusé le jeton : rien n'a été allumé.", sentence), { text: "Home Assistant a refusé le jeton : rien n'a été allumé.", corrected: false });
  const result = homeNotDoneResult(["NOT DONE for light.cuisine: Home Assistant refused Twoody's access token."], sentence, "fr");
  assert.match(result, /^NOT DONE\. Nothing was switched in the user's home:\nNOT DONE for light\.cuisine/);
  assert.match(result, /in one short sentence in French that it was not done and why, such as « Je n'ai pas pu le faire : Home Assistant a refusé/);
  assert.match(result, /Never say or suggest that a device is on, off/);
  assert.match(homeNotDoneResult([], homeNotDoneSentence("failed", "ja"), "ja-JP"), /in Japanese/);
});
