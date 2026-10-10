import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The days a message names, its e-mails' periods, « tell Mum that… » and the
// « yes » after it, and the model's « I'll look it up » — in the ten
// languages of the app (10/10/2026: French and English only, so « Was habe
// ich am Freitag? » got no agenda, « Hat Paul mir diese Woche geschrieben? »
// no e-mails, and « Sag Mama, dass ich später komme » was left to a model
// that said it could not send messages). What each must catch, and what it
// must leave alone.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-multilingual-agenda-"));

const { dateWindow, matchContacts, personalContextBlock } = await import("../src/personalContext.js");
const { periodIn, periodSpanIn, messageWords, passOnFirst } = await import("../src/email/chat.js");
const { aboutEmails, passOnWithoutHow, agreedToDraft, asksForADraft } = await import("../src/email/intent.js");
const { looksLikeAnnouncement, onlyNarration, draftAnnounced, writtenOut } = await import("../src/routes/queries.js");
const { buildChatMessages } = await import("../src/chatContext.js");
const { promptExamples } = await import("../src/promptExamples.js");

// Tuesday 29 September 2026, 10:00 in Paris.
const NOW = new Date("2026-09-29T08:00:00Z");
const PARIS = "Europe/Paris";
/// The first and last day of the window, as YYYY-MM-DD in Paris.
const days = (message: string): string | null => {
  const window = dateWindow(message, NOW, PARIS);
  if (!window) return null;
  const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: PARIS }).format(new Date(ms));
  const first = day(window.from);
  const last = day(window.to - 1);
  return first === last ? first : `${first}…${last}`;
};

test("« what do I have on Friday? » and the other named days, in every language", () => {
  const friday = "2026-10-02";
  for (const message of [
    "Was habe ich am Freitag?", "¿Qué tengo el viernes?", "Cosa ho venerdì?", "O que eu tenho na sexta?", "O que tenho na sexta-feira?",
    "Wat heb ik vrijdag?", "金曜日の予定は？", "我周五有什么安排？", "星期五有什么事？", "금요일에 일정 있어?", "Qu'est-ce que j'ai vendredi ?", "What do I have on Friday?",
  ]) assert.equal(days(message), friday, message);
  const tomorrow = "2026-09-30";
  for (const message of ["Was steht morgen an?", "¿Qué tengo mañana?", "Cosa ho domani?", "O que tenho amanhã?", "Wat heb ik morgen?", "明日の予定は？", "明天有什么安排？", "내일 일정 알려줘"]) {
    assert.equal(days(message), tomorrow, message);
  }
  const today = "2026-09-29";
  for (const message of ["Was habe ich heute?", "¿Qué tengo hoy?", "Cosa ho oggi?", "O que tenho hoje?", "Wat heb ik vandaag?", "今日の予定は？", "今天有什么安排？", "오늘 일정은?",
    // « this morning » is not « tomorrow »: « esta mañana », « heute Morgen », « vanmorgen ».
    "¿Qué tuve esta mañana?", "Was war heute Morgen?", "Wat had ik vanmorgen?"]) assert.equal(days(message), today, message);
  for (const message of ["Was war gestern?", "¿Qué pasó ayer?", "ieri", "ontem", "gisteren", "昨日", "昨天", "어제"]) assert.equal(days(message), "2026-09-28", message);
  for (const message of ["übermorgen", "pasado mañana", "dopodomani", "depois de amanhã", "overmorgen", "明後日", "后天", "모레"]) assert.equal(days(message), "2026-10-01", message);
  for (const message of ["vorgestern", "anteayer", "l'altro ieri", "anteontem", "eergisteren", "一昨日", "前天", "그저께"]) assert.equal(days(message), "2026-09-27", message);
});

test("weeks, weekends, months, the next and the last weekday, in every language", () => {
  for (const message of ["diese Woche", "esta semana", "questa settimana", "deze week", "今週", "这周", "本周", "이번 주"]) assert.equal(days(message), "2026-09-28…2026-10-04", message);
  for (const message of ["nächste Woche", "la semana que viene", "la próxima semana", "la prossima settimana", "semana que vem", "volgende week", "来週", "下周", "다음 주"]) {
    assert.equal(days(message), "2026-10-05…2026-10-11", message);
  }
  for (const message of ["letzte Woche", "la semana pasada", "la settimana scorsa", "semana passada", "vorige week", "先週", "上周", "지난주"]) assert.equal(days(message), "2026-09-21…2026-09-27", message);
  for (const message of ["dieses Wochenende", "este fin de semana", "questo fine settimana", "este fim de semana", "dit weekend", "今週末", "周末", "주말"]) assert.equal(days(message), "2026-10-03…2026-10-04", message);
  for (const message of ["nächsten Monat", "el mes que viene", "il mese prossimo", "o mês que vem", "volgende maand", "来月", "下个月", "다음 달"]) assert.equal(days(message), "2026-10-01…2026-10-31", message);
  for (const message of ["letzten Monat", "el mes pasado", "il mese scorso", "o mês passado", "vorige maand", "先月", "上个月", "지난달", "le mois dernier"]) assert.equal(days(message), "2026-08-01…2026-08-31", message);
  for (const message of ["diesen Monat", "este mes", "questo mese", "deze maand", "今月", "这个月", "이번 달"]) assert.equal(days(message), "2026-09-29…2026-09-30", message);
  // The weekday of the week named with it: next week's, last week's.
  for (const message of ["Freitag nächste Woche", "el viernes de la semana que viene", "来週の金曜日", "下周五", "다음 주 금요일", "vendredi de la semaine prochaine"]) assert.equal(days(message), "2026-10-09", message);
  for (const message of ["letzten Freitag", "el viernes pasado", "venerdì scorso", "sexta passada", "vorige vrijdag", "先週の金曜日", "上周五", "지난 금요일", "vendredi dernier"]) {
    assert.equal(days(message), "2026-09-25", message);
  }
  // « Dienstag » on a Tuesday is today; « nächsten Dienstag », next week's.
  assert.equal(days("Dienstag"), "2026-09-29");
  assert.equal(days("nächsten Dienstag"), "2026-10-06");
  assert.equal(days("martedì prossimo"), "2026-10-06");
});

test("dates in figures and words, and a day of the month alone, in every language", () => {
  for (const message of ["am 3. Oktober", "el 3 de octubre", "il 3 ottobre", "dia 3 de outubro", "op 3 oktober", "10月3日", "10월 3일", "le 3 octobre", "October 3rd", "am 3.10.", "3.10.2026", "2026-10-03"]) {
    assert.equal(days(message), "2026-10-03", message);
  }
  // A day alone: this month's, or next month's once it has gone by.
  for (const message of ["Was habe ich am 30.?", "¿Qué tengo el 30?", "il 30", "no dia 30", "op de 30e", "le 30", "on the 30th", "30日の予定", "30号有什么安排", "30일 약속"]) {
    assert.equal(days(message), "2026-09-30", message);
  }
  assert.equal(days("le 12"), "2026-10-12");
  assert.equal(days("来月12日"), "2026-10-12");
  // A number that is no date.
  for (const message of ["le 12 h", "Ich habe 3 Tage frei", "el 12 % de descuento", "3日間かかる", "3号线怎么走", "3일 동안", "il 12 per cento", "3-4 personnes", "1/2 tasse de farine"]) {
    assert.equal(days(message), null, message);
  }
});

test("words that look like a day and are not one", () => {
  for (const message of [
    // German and Dutch « hier » is « here »; « Morgen » the morning.
    "Was gibt es hier?", "Wat ligt hier?", "Guten Morgen!", "Goedemorgen", "Am Morgen trinke ich Kaffee",
    // « la mañana » is the morning; Portuguese « segunda » a second, « sexta » a sixth.
    "Por la mañana corro", "É a segunda vez", "a sexta parte", "J'ai terminé le rapport", "Ich habe Zeit",
    "Wie geht es dir?", "¿Cómo estás?", "你好", "안녕하세요",
  ]) assert.equal(days(message), null, message);
  // French « hier » still is yesterday.
  assert.equal(days("Qu'est-ce que j'ai fait hier ?"), "2026-09-28");
});

test("the agenda asked about without a day, and birthdays, in every language: the next weeks", () => {
  const events = [{ title: "Zahnarzt", start: new Date("2026-10-02T07:00:00Z"), end: new Date("2026-10-02T07:30:00Z"), allDay: false, location: null, calendar: null, notes: null }];
  for (const message of ["Was steht in meinem Kalender?", "Habe ich Termine?", "¿Qué citas tengo?", "Che appuntamenti ho?", "Quais compromissos eu tenho?", "Welke afspraken heb ik?", "予定を教えて", "我有什么安排？", "내 일정 보여줘"]) {
    assert.match(personalContextBlock({ message, contacts: [], events, now: NOW, timeZone: PARIS, budget: 2_000 }) ?? "", /Zahnarzt/, message);
  }
  assert.equal(personalContextBlock({ message: "Erkläre mir die Photosynthese", contacts: [], events, now: NOW, timeZone: PARIS, budget: 2_000 }), null);
  const contacts = [{ name: "Lea Weber", firstName: "Lea", lastName: "Weber", organization: null, phones: [], emails: [], birthday: "--10-01" }];
  for (const message of ["Wer hat bald Geburtstag?", "¿Quién cumple años pronto? Cumpleaños", "compleanni", "verjaardagen", "誕生日", "生日", "생일"]) {
    assert.match(personalContextBlock({ message, contacts, events: [], now: NOW, timeZone: PARIS, budget: 2_000 }) ?? "", /birthday: \{"name":"Lea Weber"/, message);
  }
});

test("a contact named inside Japanese, Chinese or Korean text", () => {
  const card = (name: string, firstName: string | null, lastName: string | null) => ({ name, firstName, lastName, organization: null, phones: [], emails: [], birthday: null });
  const contacts = [card("田中 太郎", "太郎", "田中"), card("王伟", null, null), card("김민수", "민수", "김"), card("Paul Martin", "Paul", "Martin")];
  const names = (message: string) => matchContacts(message, contacts).map((match) => match.contact.name);
  assert.deepEqual(names("田中さんとの予定は？"), ["田中 太郎"]);
  assert.deepEqual(names("王伟的电话是多少？"), ["王伟"]);
  assert.deepEqual(names("김민수한테 연락해야 해"), ["김민수"]);
  assert.deepEqual(names("Paul给我打电话了吗"), ["Paul Martin"]);
  assert.deepEqual(names("Paulさんの予定"), ["Paul Martin"]);
  // One character is no name: « 김 » is millions of people.
  assert.deepEqual(names("김치 좋아해?"), []);
});

test("the period of a question about e-mails, in every language", () => {
  for (const message of ["Hat Paul mir diese Woche geschrieben?", "¿Paul me ha escrito esta semana?", "Paul mi ha scritto questa settimana?", "O Paul me escreveu esta semana?", "Heeft Paul me deze week gemaild?", "Paulさんから今週メール来た？", "Paul这周给我写信了吗？", "Paul이 이번 주에 나한테 메일 보냈어?"]) {
    assert.equal(periodIn(message), "this_week", message);
  }
  assert.equal(periodIn("Was kam gestern?"), "yesterday");
  assert.equal(periodIn("Was gibt es hier?"), null);
  assert.equal(periodIn("¿Qué me llegó el mes pasado?"), "last_month");
  assert.equal(periodIn("先週のメール"), "last_week");
  assert.equal(periodIn("最近几天的邮件"), "last_7_days");
  assert.equal(periodIn("e-mails van de afgelopen weken"), "last_30_days");
  assert.equal(periodIn("negli ultimi mesi"), "last_3_months");
  assert.equal(periodIn("vorgestern"), null);
  // « since Monday »: from the last Monday (a week back said on a Monday).
  const wednesday = Date.parse("2026-10-07T10:00:00+02:00");
  const monday = Date.parse("2026-10-05T00:00:00+02:00");
  for (const message of ["depuis lundi", "since Monday", "seit Montag", "desde el lunes", "da lunedì", "desde segunda", "sinds maandag", "月曜から", "从周一开始", "周一以来", "월요일부터"]) {
    const span = periodSpanIn(message, wednesday, PARIS);
    assert.equal(span?.after, monday, message);
    assert.equal(span?.label, "since Monday", message);
  }
  assert.equal(periodSpanIn("seit Montag", Date.parse("2026-10-05T10:00:00+02:00"), PARIS)?.after, Date.parse("2026-09-28T00:00:00+02:00"));
  assert.equal(periodSpanIn("seit gestern", wednesday, PARIS)?.after, Date.parse("2026-10-06T00:00:00+02:00"));
  assert.deepEqual(periodSpanIn("anteayer", wednesday, PARIS), { label: "the day before yesterday", after: Date.parse("2026-10-05T00:00:00+02:00"), before: Date.parse("2026-10-06T00:00:00+02:00") });
  // A weekday alone is what the e-mail is about, not when it came.
  assert.equal(periodSpanIn("Antworte Paul, dass Donnerstag passt", wednesday, PARIS), null);
  // The question's own words, without the ones that only say « e-mail ».
  assert.equal(messageWords("Hat Paul mir diese Woche geschrieben?"), "paul");
  assert.equal(messageWords("Heeft Paul me deze week gemaild?"), "paul");
  assert.equal(messageWords("Paulさんから今週メール来た？"), "paul");
  assert.equal(messageWords("Paul这周给我发邮件了吗？"), "paul");
  assert.equal(messageWords("Paul이 이번 주에 나한테 메일 보냈어?"), "paul");
});

test("which messages plainly ask about e-mails, in every language — and which do not", () => {
  for (const message of [
    "Hat Paul mir diese Woche geschrieben?", "Hat Paul geantwortet?", "Habe ich die Rechnung von EDF erhalten?", "Welche Mails sind unbeantwortet?", "Antworte Paul, dass es passt",
    "¿Me escribió Paul esta semana?", "¿He recibido algo de Iberdrola?", "¿Qué correos esperan mi respuesta?", "Responde a Paul que sí",
    "Paul mi ha scritto questa settimana?", "Ho ricevuto la fattura?", "Rispondi a Marco che va bene",
    "O Paul me escreveu esta semana?", "Recebi algum e-mail do Paul?", "Quais e-mails estão sem resposta?",
    "Heeft Paul me deze week geschreven?", "Heb ik de factuur van KPN ontvangen?", "Welke e-mails zijn onbeantwoord?",
    "Mach einen Entwurf für Claire", "Resume el último intercambio con Claire", "Wat waren de laatste berichten van Paul?", "Claireさんとのやり取りをまとめて",
    "Paulさんから今週連絡あった？", "未返信のメールは？", "Paul这周给我写信了吗？", "我收到Paul的回复了吗？", "Paul이 이번 주에 나한테 연락했어?", "답장 안 한 메일 있어?",
  ]) assert.equal(aboutEmails(message), true, message);
  for (const message of [
    "Hat Goethe Faust geschrieben?", "Antworte auf Deutsch", "Wie schreibe ich eine E-Mail an meinen Vermieter?", "Habe ich Fieber bekommen?", "Hast du das verstanden?",
    "¿Me escribes un poema?", "¿Cómo escribir un correo formal?", "Responde a esta pregunta", "Scrivi una poesia", "Recebi meu salário", "Schrijf een gedicht",
    "给我发个笑话", "这是什么意思？", "日本の首都は？", "오늘 날씨 어때?",
  ]) assert.equal(aboutEmails(message), false, message);
  assert.equal(asksForADraft("Antworte Paul, dass es passt"), true);
  assert.equal(asksForADraft("Responde a Paul que sí"), true);
  assert.equal(asksForADraft("Hat Paul mir geschrieben?"), false);
});

test("« tell Mum I'll be late » in every language: whom, and no draft yet; not a question, another way, or Twoody itself", () => {
  for (const [message, recipient] of [
    ["Sag Mama, dass ich später komme", "Mama"], ["Kannst du Mama sagen, dass ich später komme?", "Mama"], ["Frag Paul, ob er morgen kommt", "Paul"], ["Richte Paul aus, dass ich später komme", "Paul"], ["Sag ihm, dass ich komme", "ihm"],
    ["Dile a mamá que llegaré tarde", "mamá"], ["¿Puedes decirle a mamá que llegaré tarde?", "mamá"], ["Avisa a Paul de que llego tarde", "Paul"], ["Dile que llego tarde", "le"],
    ["Di' alla mamma che farò tardi", "mamma"], ["Avvisa Paul che arrivo tardi", "Paul"], ["Digli che arrivo", "gli"],
    ["Diga à mamãe que vou me atrasar", "mamãe"], ["Fala pra mãe que vou atrasar", "mãe"], ["Avisa o Paul que vou atrasar", "Paul"],
    ["Zeg tegen mama dat ik later ben", "mama"], ["Laat Paul weten dat ik later ben", "Paul"], ["Vraag Paul of hij morgen komt", "Paul"],
    ["ママに遅れるって伝えて", "ママ"], ["お母さんに遅くなると伝えて", "お母さん"], ["告诉妈妈我会晚点到", "妈妈"], ["跟妈妈说我要晚点", "妈妈"],
    ["엄마한테 늦는다고 전해줘", "엄마"], ["엄마한테 늦을 거라고 말해 줘", "엄마"],
  ]) assert.equal(passOnWithoutHow(message!)?.recipient, recipient, message);
  for (const message of [
    "Sag mir, wie spät es ist", "Sag mal, was ist los?", "Wie sage ich meinem Chef, dass ich kündige?", "Sag Mama per WhatsApp, dass ich später komme", "Schreib Paul eine E-Mail, dass ich später komme",
    "Dime la capital de Italia", "Dile a Siri que es tonta", "¿Cómo le digo a mi jefe que renuncio?", "Di' qualcosa", "Diz-me as horas", "Zeg maar dat het goed is",
    "告诉我怎么做", "电话告诉妈妈我会晚点到", "나한테 알려줘", "엄마한테 전화해서 늦는다고 말해 줘", "LINEでママに遅れるって伝えて",
  ]) assert.equal(passOnWithoutHow(message), null, message);
  // « deadline », « online »: no LINE, the messaging app.
  assert.equal(passOnWithoutHow("Tell Mom that the deadline is Friday")?.recipient, "Mom");
});

test("the question before a draft is shaped in the message's language, never a whole French example to copy", () => {
  const ask = (recipient: string, language: string | null) => passOnFirst(recipient, { userId: "nobody", timeZone: PARIS, budgetChars: 8_000, language }).block;
  const german = ask("Mama", "de");
  assert.match(german, /in German, such as « Soll ich eine E-Mail an Mama entwerfen, dass…\? »/);
  assert.doesNotMatch(german, /Voulez-vous|dimanche|Sonntag/);
  assert.match(ask("ママ", "ja"), /in Japanese, such as « ママに「…」と伝えるメールを下書きしましょうか？ »/);
  assert.match(ask("妈妈", "zh"), /要我给妈妈写一封邮件/);
  assert.match(ask("maman", null), /in French, such as « Voulez-vous que je rédige un e-mail à maman pour lui dire que… \? »/);
  assert.match(ask("ihm", "de"), /an … entwerfen/);
  assert.match(ask("Paul", "he"), /in their language, such as « Would you like me to draft an e-mail to Paul/);
});

test("the « yes » to Twoody's offer of a draft, in every language; not to another question, nor another way", () => {
  const cases: Array<[string, string]> = [
    ["Soll ich eine E-Mail an Mama entwerfen, dass Sie später kommen?", "Ja, bitte"],
    ["¿Quieres que redacte un correo a mamá para decirle que llegarás tarde?", "Sí"],
    ["Vuoi che scriva un'e-mail alla mamma per dirle che farai tardi?", "Sì, grazie"],
    ["Você quer que eu escreva um e-mail para a mamãe dizendo que vai se atrasar?", "Sim"],
    ["Zal ik een e-mail aan mama opstellen om te zeggen dat u later bent?", "Ja graag"],
    ["遅れることを伝えるメールを、ママ宛てに下書きしましょうか？", "はい、お願いします"],
    ["要我给妈妈写一封邮件，告诉她你会晚点到吗？", "好的"],
    ["엄마에게 늦는다고 이메일 초안을 작성해 드릴까요?", "네, 부탁해요"],
  ];
  for (const [offer, yes] of cases) {
    assert.equal(agreedToDraft(offer, yes), true, `${offer} → ${yes}`);
    assert.equal(agreedToDraft("Die Hauptstadt Italiens ist Rom. Noch etwas?", yes), false, yes);
  }
  for (const reply of ["Nein", "No", "Nee", "いいえ", "不用", "아니요", "Sí, pero por WhatsApp", "Ja, aber per SMS", "はい、LINEで"]) assert.equal(agreedToDraft(cases[1]![0], reply), false, reply);
});

test("the model's « I'll look it up » and « I'm drafting it » in every language: held back, not an answer", () => {
  for (const said of ["Ich schaue in Ihren E-Mails nach.", "Voy a buscar en tus correos.", "Controllo nelle tue e-mail.", "Vou verificar seus e-mails.", "Ik ga even in uw e-mails zoeken.", "メールを確認します。", "让我查一下你的邮件。", "이메일을 확인해 보겠습니다.", "Zal ik in uw e-mails zoeken?", "Hier sind Ihre Termine："]) {
    assert.equal(looksLikeAnnouncement(said), true, said);
  }
  for (const said of ["Paul hat Ihnen am Montag geschrieben: Er kommt am Freitag.", "Paul te escribió el lunes: llega el viernes.", "Paul heeft u maandag gemaild.", "ポールさんは月曜日にメールを送りました。", "Paul周一给你发了邮件。"]) {
    assert.equal(looksLikeAnnouncement(said), false, said);
    assert.equal(onlyNarration(said, true), false, said);
  }
  for (const said of ["Ich entwerfe jetzt eine Antwort an Paul.", "Voy a redactar un correo para Paul.", "Ora scrivo la bozza per Paul.", "Vou escrever um e-mail para o Paul.", "Ik stel nu een e-mail aan Paul op.", "Ik ga een e-mail aan Paul schrijven.", "ポールさん宛てのメールを作成します。", "我来为你起草一封邮件。", "이메일 초안을 작성하겠습니다."]) {
    assert.equal(draftAnnounced(said), true, said);
    assert.equal(onlyNarration(said, true), true, said);
  }
  for (const said of ["Hier ist der Entwurf:\n\nBetreff: Freitag\n\nHallo Paul, …", "Aquí tienes el borrador:\n\nAsunto: Viernes", "Ecco la bozza:\n\nOggetto: venerdì", "Aqui está o rascunho:\n\nAssunto: sexta", "Hier is het concept:\n\nOnderwerp: vrijdag", "件名：金曜日\n\nポールさん、", "主题：周五\n\nPaul你好，", "제목: 금요일\n\n폴에게,"]) {
    assert.equal(writtenOut(said), true, said);
  }
});

test("the system prompt's examples follow the conversation's language; French as before; the same for the whole conversation", () => {
  const prompt = (locale: string | undefined) => buildChatMessages({ userName: null, prefs: {}, history: [], memories: [], content: "Hallo", local: true, now: NOW, locale, actionTools: true, emailTools: true, hasDocuments: true, documentTool: true })[0]!.content as string;
  const french = prompt("fr-FR");
  assert.match(french, /« rappelle-moi… », « note que je dois… », « c'est acheté »/);
  assert.match(french, /for « cette semaine », « last month »… give it the period/);
  assert.match(french, /« dis à X que… »/);
  assert.match(french, /in Documents\/Factures, .*« jimmy\/Desktop\/Projets », « Factures »/);
  assert.equal(prompt(undefined).includes("« rappelle-moi… »"), true);
  const german = prompt("de-DE");
  assert.match(german, /« erinnere mich… », « notiere mir, dass ich… », « ist gekauft »/);
  assert.match(german, /« diese Woche », « letzten Monat »/);
  assert.match(german, /« sag X, dass… »/);
  assert.doesNotMatch(german, /rappelle-moi|cette semaine|dis à X|Factures/);
  assert.match(prompt("ja-JP"), /« 今週 », « 先月 »/);
  assert.equal(prompt("de-DE"), german, "the same prompt each time: the runtime's cache");
  assert.equal(promptExamples("pt-BR").invoices, "Notas fiscais");
  assert.equal(promptExamples("he-IL").invoices, "Invoices");
});
