import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// What a message asks for at once — a light switched, a reminder, a file
// listing, « try again », small talk, a site's statistics — understood in
// the ten languages of the app, not only French and English (10/10/2026: a
// German « Mach das Licht im Wohnzimmer an » was left to a model that said
// « Erledigt » without switching anything). Each detector: what it must
// catch, and what it must leave alone (a question about a light is no
// order; « Ich sitze am Schreibtisch » is no listing).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-multilingual-"));

const { homeShortcut, homeFollowUp, asksHome, asksHomeAgain, homeBlock, homeDoneNote, homeUnusedNote, homeErrorSentence, HomeError } = await import("../src/home/homeAssistant.js");
const { askedAction, namedDay } = await import("../src/projects/actions.js");
const { listingIntent, folderFollowUp, howToGrant, formatListing } = await import("../src/documents/fileListing.js");
const { aliasNamed, formatFolderListing } = await import("../src/documents/folderListing.js");
const { folderAliasIn } = await import("../src/documents/folderAliases.js");
const { retriesPrevious, questionBefore, smallTalk, asksNothing } = await import("../src/documents/query.js");
const { googleDataAsk, periodOf } = await import("../src/google/dataIntent.js");
const { googleDataErrorSentence } = await import("../src/google/dataTools.js");
const { askedBank } = await import("../src/bank/tools.js");
const { askedToRemember } = await import("../src/memoryLearning.js");
const { aboutEmails } = await import("../src/email/intent.js");
const { aboutDocuments, looksLikeAnnouncement } = await import("../src/routes/queries.js");
const { capabilityPlace, uiLabels, uiLanguage } = await import("../src/uiLabels.js");

const device = (entity_id: string, name: string) => ({ entity_id, name, domain: entity_id.split(".")[0]!, state: "off", brightness: null });
// A home in each language, named as its people name their devices.
const HOME = [
  device("light.wohnzimmer", "Wohnzimmer Licht"), device("light.kueche", "Küche Lampe"),
  device("light.salon", "Luz del salón"), device("light.bano", "Luz del baño"),
  device("light.soggiorno", "Luce soggiorno"), device("light.cucina", "Luce cucina"),
  device("light.sala", "Luz da sala"), device("light.cozinha", "Luz da cozinha"),
  device("light.woonkamer", "Woonkamer lamp"), device("light.keuken", "Keuken lamp"),
  device("light.living_ja", "リビングの照明"), device("light.kitchen_ja", "キッチンの照明"),
  device("light.keting", "客厅灯"), device("light.chufang", "厨房灯"),
  device("light.geosil", "거실 조명"), device("light.jubang", "주방 조명"),
  device("light.living", "Living room light"), device("light.kitchen", "Kitchen light"),
];
const shortcut = (message: string) => {
  const found = homeShortcut(message, HOME);
  return found ? `${found.action} ${found.entities.map((entity) => entity.entity_id).join(",")}` : null;
};

test("« turn on the living room light » in every language: the device and the action, at once", () => {
  const orders: Array<[string, string]> = [
    ["Mach das Licht im Wohnzimmer an", "on light.wohnzimmer"],
    ["Schalte das Wohnzimmerlicht aus", "off light.wohnzimmer"],
    ["Kannst du das Licht im Wohnzimmer einschalten?", "on light.wohnzimmer"],
    ["Licht in der Küche ausschalten", "off light.kueche"],
    ["Enciende la luz del salón", "on light.salon"],
    ["Apaga la luz del baño", "off light.bano"],
    ["¿Puedes encender la luz del salón?", "on light.salon"],
    ["Accendi la luce del soggiorno", "on light.soggiorno"],
    ["Spegni la luce in cucina", "off light.cucina"],
    ["Liga a luz da sala", "on light.sala"],
    ["Desliga a luz da cozinha", "off light.cozinha"],
    ["Zet de lamp in de woonkamer aan", "on light.woonkamer"],
    ["Doe het licht in de keuken uit", "off light.keuken"],
    ["リビングの電気をつけて", "on light.living_ja"],
    ["キッチンの照明を消して", "off light.kitchen_ja"],
    ["リビングの電気つけてくれる？", "on light.living_ja"],
    ["把客厅的灯打开", "on light.keting"],
    ["关掉厨房灯", "off light.chufang"],
    ["你能把客厅的灯打开吗？", "on light.keting"],
    ["거실 불 켜줘", "on light.geosil"],
    ["주방 조명 꺼 줘", "off light.jubang"],
    ["Turn on the living room light", "on light.living"],
  ];
  for (const [message, expected] of orders) {
    assert.equal(shortcut(message), expected, message);
    assert.equal(asksHome(message), true, message);
  }
});

test("« the kitchen light and the TV » in every language: both devices, at once; another action or an unclear device, the model", () => {
  // Bench of 10/10/2026: « Allume la lumière de la cuisine et la télé »
  // switched the kitchen only.
  const homes: Record<string, [string, string]> = {
    fr: ["Lumière cuisine", "Télé"], en: ["Kitchen light", "Television"], de: ["Küche Lampe", "Fernseher"], es: ["Luz de la cocina", "Televisor"],
    it: ["Luce cucina", "Televisore"], pt: ["Luz da cozinha", "Televisão"], nl: ["Keuken lamp", "Televisie"], ja: ["キッチンの照明", "テレビ"],
    zh: ["厨房灯", "电视"], ko: ["주방 조명", "티비"],
  };
  const orders: Array<[string, string, string]> = [
    ["fr", "Allume la lumière de la cuisine et la télé", "on"],
    ["fr", "Éteins la cuisine, la télé", "off"],
    ["en", "Turn on the kitchen light and the television", "on"],
    ["de", "Mach das Licht in der Küche und den Fernseher an", "on"],
    ["de", "Schalte die Küche und den Fernseher aus", "off"],
    ["es", "Enciende la luz de la cocina y el televisor", "on"],
    ["it", "Accendi la luce della cucina e il televisore", "on"],
    ["pt", "Liga a luz da cozinha e a televisão", "on"],
    ["nl", "Zet de lamp in de keuken en de televisie aan", "on"],
    ["ja", "キッチンの照明とテレビをつけて", "on"],
    ["zh", "打开厨房灯和电视", "on"],
    ["zh", "把厨房灯跟电视关掉", "off"],
    ["ko", "주방 조명과 티비 켜 줘", "on"],
    ["ko", "주방 조명 그리고 티비 꺼 줘", "off"],
  ];
  for (const [lang, message, action] of orders) {
    const [kitchen, tv] = homes[lang]!;
    const home = [device("light.kitchen", kitchen), device("media_player.tv", tv), device("light.living", lang === "ja" ? "リビングの照明" : "Living")];
    const found = homeShortcut(message, home);
    assert.equal(found ? `${found.action} ${found.entities.map((entity) => entity.entity_id).join(",")}` : null, `${action} light.kitchen,media_player.tv`, message);
  }
  const home = [device("light.kitchen", "Lumière cuisine"), device("light.spot", "Spot cuisine"), device("media_player.tv", "Télé"), device("light.salon_cuisine", "Salon et cuisine")];
  // Two actions in one message, a part naming two devices: left to the model.
  assert.equal(homeShortcut("Allume la lumière de la cuisine et éteins la télé", home), null);
  assert.equal(homeShortcut("Mach das Licht in der Küche an und schalte den Fernseher aus", [device("light.kueche", "Küche Lampe"), device("media_player.tv", "Fernseher")]), null);
  assert.equal(homeShortcut("Allume la cuisine et la télé", home), null, "two devices in the kitchen");
  // A device whose own name holds the « and »: that device alone.
  assert.deepEqual(homeShortcut("Allume salon et cuisine", home)?.entities.map((entity) => entity.entity_id), ["light.salon_cuisine"]);
  // One device, and words after a comma: as before.
  assert.deepEqual(homeShortcut("Allume la télé, s'il te plaît", home)?.entities.map((entity) => entity.entity_id), ["media_player.tv"]);
  assert.deepEqual(homeShortcut("和室の照明をつけて", [device("light.washitsu", "和室の照明"), device("light.living", "リビングの照明")])?.entities.map((entity) => entity.entity_id), ["light.washitsu"]);
  // « Éteins-les » after both: both.
  const both = { entities: [home[0]!, home[2]!], action: "on" as const };
  const off = homeFollowUp("Éteins-les", home, both);
  assert.equal(off ? `${off.action} ${off.entities.map((entity) => entity.entity_id).join(",")}` : null, "off light.kitchen,media_player.tv");
  const aus = homeFollowUp("Mach sie wieder aus", [device("light.kueche", "Küche Lampe"), device("media_player.tv", "Fernseher")], { entities: [device("light.kueche", "Küche Lampe"), device("media_player.tv", "Fernseher")], action: "on" });
  assert.equal(aus?.entities.length, 2);
});

test("a question about a light, a reminder, another meaning of the verb: nothing switched", () => {
  for (const message of [
    "Ist das Licht im Wohnzimmer an?", "Erinnere mich, das Licht im Wohnzimmer auszuschalten", "Mach mal ein Foto",
    "¿Está encendida la luz del salón?", "Recuérdame apagar la luz del salón", "Dime la fecha de la factura de la luz", "Abre el documento de Paul",
    "La luce del soggiorno è accesa?", "A luz da sala está acesa?", "Me lembre de desligar a luz da sala", "Ligue para o Paul",
    "Staat de lamp in de woonkamer aan?",
    "リビングの電気はついてる？", "気をつけて帰ってね", "ファイルを見つけて",
    "客厅的灯开着吗？", "关于客厅灯的问题",
    "거실 불 켜져 있어?", "가방에서 꺼내줘",
  ]) {
    assert.equal(shortcut(message), null, message);
    assert.equal(asksHome(message), false, message);
  }
});

test("« turn it off » after a light was switched: the same light, in every language; another device or a question, not", () => {
  const after = (id: string, message: string) => {
    const last = { entities: HOME.filter((entity) => entity.entity_id === id), action: "on" as const };
    const found = homeFollowUp(message, HOME, last);
    return found ? `${found.action} ${found.entities.map((entity) => entity.entity_id).join(",")}${found.brightness ? ` ${found.brightness}%` : ""}${found.undo ? " undo" : ""}` : null;
  };
  const followUps: Array<[string, string, string]> = [
    ["light.wohnzimmer", "Mach es aus", "off light.wohnzimmer"],
    ["light.wohnzimmer", "Kannst du es ausschalten?", "off light.wohnzimmer"],
    ["light.wohnzimmer", "Dimme es auf 30 %", "on light.wohnzimmer 30%"],
    ["light.wohnzimmer", "Und die Küche auch", "on light.kueche"],
    ["light.wohnzimmer", "Wie vorher", "off light.wohnzimmer undo"],
    ["light.salon", "Apágala", "off light.salon"],
    ["light.salon", "¿Puedes apagarla?", "off light.salon"],
    ["light.salon", "Ponla al 30 %", "on light.salon 30%"],
    ["light.salon", "Y la del baño también", "on light.bano"],
    ["light.soggiorno", "Spegnila", "off light.soggiorno"],
    ["light.soggiorno", "Mettila al 20%", "on light.soggiorno 20%"],
    ["light.sala", "Apaga ela", "off light.sala"],
    ["light.sala", "Coloca em 50 por cento", "on light.sala 50%"],
    ["light.woonkamer", "Zet hem uit", "off light.woonkamer"],
    ["light.woonkamer", "De keuken ook", "on light.keuken"],
    ["light.living_ja", "消して", "off light.living_ja"],
    ["light.living_ja", "明るさを30%にして", "on light.living_ja 30%"],
    ["light.living_ja", "キッチンも", "on light.kitchen_ja"],
    ["light.living_ja", "元に戻して", "off light.living_ja undo"],
    ["light.keting", "关掉它", "off light.keting"],
    ["light.keting", "把它关了", "off light.keting"],
    ["light.keting", "调到30%", "on light.keting 30%"],
    ["light.geosil", "다시 꺼 줘", "off light.geosil"],
    ["light.geosil", "30%로 해줘", "on light.geosil 30%"],
    ["light.living", "turn it off", "off light.living"],
  ];
  for (const [id, message, expected] of followUps) {
    assert.equal(after(id, message), expected, message);
    const last = { entities: HOME.filter((entity) => entity.entity_id === id), action: "on" as const };
    if (!expected.endsWith("undo")) assert.equal(asksHomeAgain(message, HOME, last), true, message);
  }
  for (const [id, message] of [
    ["light.wohnzimmer", "Schalte den Fernseher aus"], ["light.wohnzimmer", "Ist es an?"], ["light.wohnzimmer", "Erinnere mich, es um 23 Uhr auszuschalten"],
    ["light.salon", "¿Está apagada?"], ["light.salon", "Apaga la tele"],
    ["light.living_ja", "消した？"], ["light.living_ja", "テレビを消して"],
    ["light.keting", "电视关掉"], ["light.geosil", "꺼졌어?"], ["light.geosil", "TV 꺼줘"],
  ]) assert.equal(after(id!, message!), null, message);
});

test("a command done at once is confirmed in the message's language, never with a French example to copy", () => {
  const note = homeDoneNote(["« リビングの照明 » was off; Twoody has just switched it: it is now on."], "Japanese");
  assert.match(note, /in Japanese \(the language of their message\)/);
  assert.doesNotMatch(note, /Done, the/, "no example to copy");
  assert.match(note, /Never say you cannot control their devices/);
  assert.doesNotMatch(note, /C'est fait/);
  assert.match(homeDoneNote(["Not done: Home Assistant could not do it."], "German"), /what was done and what was not/);
  assert.match(homeDoneNote(["« Lamp » was off; Twoody has just switched it: it is now on."], null), /in the language of their message/);
});

test("the devices go with a message about the home, in every language; not with one about something else", () => {
  assert.ok(homeBlock("Wie hell ist das Wohnzimmer Licht?", HOME));
  assert.ok(homeBlock("客厅灯是什么颜色", HOME));
  assert.ok(homeBlock("거실 조명 상태 알려줘", HOME));
  assert.equal(homeBlock("Wie spät ist es?", HOME), null);
  assert.equal(homeBlock("今天天气怎么样", HOME), null);
});

test("« remind me tomorrow at 9 to call Paul »: a reminder, for tomorrow, in every language", () => {
  const saturday = new Date("2026-10-10T10:00:00Z");
  for (const message of [
    "Rappelle-moi demain à 9 h d'appeler Paul", "Remind me tomorrow at 9 to call Paul",
    "Erinnere mich morgen um 9, Paul anzurufen", "Recuérdame mañana a las 9 llamar a Paul", "Ricordami domani alle 9 di chiamare Paul",
    "Me lembre amanhã às 9 de ligar para o Paul", "Herinner me morgen om 9 uur eraan Paul te bellen",
    "明日の9時にポールに電話するようリマインドして", "提醒我明天9点给保罗打电话", "내일 9시에 폴에게 전화하라고 알려줘",
  ]) {
    assert.equal(askedAction(message), "create_reminder", message);
    assert.equal(namedDay(message, "Europe/Paris", saturday), "2026-10-11", message);
  }
  for (const message of ["Note que je dois rappeler Paul", "Notiere mir, dass ich Paul anrufen muss", "Añade una tarea: llamar a Paul", "Aggiungi un compito: chiamare Paul", "Nova tarefa: ligar para o Paul", "Zet Paul bellen op mijn lijst", "ポールに電話をタスクに追加して", "添加任务：给保罗打电话", "할 일에 추가해 줘: 폴에게 전화"]) {
    assert.equal(askedAction(message), "create_task", message);
  }
  for (const message of ["Wie spät ist es morgen in Tokio?", "¿Qué tiempo hará mañana?", "叫我小明", "날씨 알려줘", "Kannst du mir das erklären?"]) {
    assert.equal(askedAction(message), null, message);
  }
  // « this morning » is not tomorrow; a weekday is the next one; a date of
  // their own is the model's to read.
  assert.equal(namedDay("esta mañana", "Europe/Paris", saturday), "2026-10-10");
  assert.equal(namedDay("heute Morgen", "Europe/Paris", saturday), "2026-10-10");
  assert.equal(namedDay("übermorgen", "Europe/Paris", saturday), "2026-10-12");
  assert.equal(namedDay("viernes", "Europe/Paris", saturday), "2026-10-16");
  assert.equal(namedDay("金曜日に", "Europe/Paris", saturday), "2026-10-16");
  assert.equal(namedDay("segunda-feira", "Europe/Paris", saturday), "2026-10-12");
  assert.equal(namedDay("am 12.10. um 9", "Europe/Paris", saturday), null);
  assert.equal(namedDay("10月12日", "Europe/Paris", saturday), null);
  // Next week's Friday, on a Saturday: six days ahead, not thirteen.
  assert.equal(namedDay("下周五", "Europe/Paris", saturday), "2026-10-16");
  assert.equal(namedDay("vendredi de la semaine prochaine", "Europe/Paris", saturday), "2026-10-16");
});

test("« list the files on my desktop » in every language: the Desktop listed; « I sit at my desk » is no listing", () => {
  const intent = (message: string) => {
    const found = listingIntent(message);
    return found ? `${found.folder ?? `«${found.folderName}»`} ${found.sort}${found.count ? " count" : ""}` : null;
  };
  const asked: Array<[string, string]> = [
    ["Liste die Dateien auf meinem Schreibtisch auf", "desktop recent"],
    ["Was liegt auf meinem Schreibtisch?", "desktop recent"],
    ["Wie viele PDFs sind im Ordner Rechnungen?", "«Rechnungen» recent count"],
    ["Lista los archivos de mi escritorio", "desktop recent"],
    ["¿Cuál es el archivo más reciente de mis descargas?", "downloads recent"],
    ["Elenca i file sulla mia scrivania", "desktop recent"],
    ["Cosa c'è nella cartella Fatture?", "«Fatture» recent"],
    ["Liste os arquivos da minha área de trabalho", "desktop recent"],
    ["Toon de bestanden op mijn bureaublad", "desktop recent"],
    ["Welke bestanden zitten in de map Facturen?", "«Facturen» recent"],
    ["デスクトップのファイルを一覧にして", "desktop recent"],
    ["請求書フォルダの中身を見せて", "«請求書» recent"],
    ["列出我桌面上的文件", "desktop recent"],
    ["列出发票文件夹里的文件", "«发票» recent"],
    ["바탕화면에 있는 파일 목록 보여줘", "desktop recent"],
    ["청구서 폴더에 있는 파일 보여줘", "«청구서» recent"],
    ["list the files on my desktop", "desktop recent"],
    // « What do I have on my desktop? » (bench of 10/10/2026: offered, not listed).
    ["Qu'est-ce que j'ai sur mon bureau ?", "desktop recent"],
    ["Qu'ai-je sur mon bureau ?", "desktop recent"],
    ["What do I have on my desktop?", "desktop recent"],
    ["What's on my desktop?", "desktop recent"],
    ["Was habe ich auf meinem Schreibtisch?", "desktop recent"],
    ["¿Qué tengo en mi escritorio?", "desktop recent"],
    ["Cosa ho sulla scrivania?", "desktop recent"],
    ["O que eu tenho na minha área de trabalho?", "desktop recent"],
    ["Wat heb ik op mijn bureaublad?", "desktop recent"],
    ["デスクトップに何がありますか？", "desktop recent"],
    ["我桌面上有什么？", "desktop recent"],
    ["바탕화면에 뭐 있어?", "desktop recent"],
  ];
  for (const [message, expected] of asked) assert.equal(intent(message), expected, message);
  for (const message of ["Qu'est-ce que j'ai à faire sur mon bureau aujourd'hui ?", "What do I have to do today?", "Was habe ich heute zu tun?", "¿Qué tengo que hacer hoy?", "Cosa ho da fare oggi?", "O que eu tenho que fazer hoje?", "Wat heb ik vandaag te doen?", "Qu'est-ce que j'ai demain ?"]) {
    assert.equal(intent(message), null, message);
  }
  for (const message of ["Wie spät ist es?", "Was steht in meinem Mietvertrag über die Kündigungsfrist?", "¿Qué dice mi contrato sobre el preaviso?", "我的合同里写了什么？", "Ich sitze am Schreibtisch", "Mi escritorio es de madera"]) {
    assert.equal(intent(message), null, message);
  }
  // Dutch « bureau » is a desk; the Desktop is « bureaublad ».
  assert.equal(folderAliasIn("op mijn bureaublad"), "desktop");
});

test("« no, on the Desktop » after a listing asked, or after the answer said it could not list: that listing", () => {
  const listed = ["Liste die Dateien auf meinem Schreibtisch auf"];
  for (const message of ["Nein, auf dem Schreibtisch", "Ich habe gesagt auf dem Schreibtisch", "No, en el escritorio", "Ti ho detto sulla scrivania", "Eu disse na área de trabalho", "Ik zei op het bureaublad", "デスクトップだよ", "我说的是桌面", "바탕화면이라고 했잖아"]) {
    assert.equal(folderFollowUp(message, listed, null)?.folder, "desktop", message);
  }
  assert.equal(folderFollowUp("Auf dem Schreibtisch liegt ein Brief von Paul, was soll ich tun?", listed, null), null);
  for (const [answer, message] of [
    ["Ich kann den Ordner Schreibtisch leider nicht auflisten.", "Auf dem Schreibtisch"],
    ["No puedo acceder a los archivos de tu escritorio.", "En el escritorio"],
    ["デスクトップのファイルにはアクセスできません。", "デスクトップだよ"],
    ["我无法访问桌面上的文件。", "在桌面上"],
    ["데스크탑 파일에 접근할 수 없습니다.", "바탕화면"],
  ]) assert.equal(folderFollowUp(message!, ["Hallo"], answer!)?.folder, "desktop", message);
  assert.equal(folderFollowUp("Auf dem Schreibtisch", ["Hallo"], "Paris ist die Hauptstadt."), null);
});

test("the usual folders by their name in every language, as the model passes them to list_files", () => {
  for (const name of ["Schreibtisch", "Escritorio", "Scrivania", "Área de Trabalho", "Bureaublad", "デスクトップ", "桌面", "데스크탑", "바탕화면", "mein Schreibtisch", "Schreibtisch auf iCloud"]) assert.equal(aliasNamed(name), "desktop", name);
  for (const name of ["Descargas", "ダウンロード", "下载", "다운로드"]) assert.equal(aliasNamed(name), "downloads", name);
  for (const name of ["Dokumente", "Documentos", "文稿", "문서"]) assert.equal(aliasNamed(name), "documents", name);
  assert.equal(aliasNamed("Rechnungen"), null);
});

test("« done, try again » in every language reads the question before; anything else is a question of its own", () => {
  for (const message of ["Jetzt?", "Erledigt, versuch es nochmal", "Ya está, ¿ahora?", "Listo", "Fatto, riprova", "Pronto, tenta de novo", "Klaar, probeer het opnieuw", "Nu?", "できたよ、もう一度お願い", "今はどう？", "好了，现在呢？", "再试一次", "됐어, 다시 해봐", "이제 돼?"]) {
    assert.equal(retriesPrevious(message), true, message);
  }
  for (const message of ["Jetzt erzähl mir einen Witz", "Ahora dime el tiempo", "今天天气怎么样", "이제 뭐 먹지?"]) assert.equal(retriesPrevious(message), false, message);
  assert.equal(questionBefore(["Ja", "Liste die Dateien auf meinem Schreibtisch auf"]), "Liste die Dateien auf meinem Schreibtisch auf");
  assert.equal(questionBefore(["はい", "デスクトップのファイルを一覧にして"]), "デスクトップのファイルを一覧にして");
  assert.equal(questionBefore(["好的", "列出我桌面上的文件"]), "列出我桌面上的文件");
  assert.equal(questionBefore(["네, 좋아요", "바탕화면에 있는 파일 목록 보여줘"]), "바탕화면에 있는 파일 목록 보여줘");
});

test("small talk and a plain yes in every language ask nothing of the documents; a question with them does", () => {
  for (const message of ["Hallo!", "Guten Morgen Twoody", "Hola, ¿qué tal?", "Muchas gracias", "Ciao, come stai?", "Olá, tudo bem?", "Hoi, hoe gaat het?", "こんにちは", "ありがとうございます！", "你好", "谢谢你！", "안녕하세요", "감사합니다"]) {
    assert.equal(smallTalk(message), true, message);
  }
  for (const message of ["Hallo, wo ist mein Mietvertrag?", "Hola, ¿dónde está mi contrato?", "你好，帮我找一下合同", "こんにちは、契約書はどこ？"]) assert.equal(smallTalk(message), false, message);
  for (const message of ["Ja, gerne", "Sí, claro", "Sì, va bene", "Sim, pode ser", "Ja, graag", "はい、お願いします", "好的", "네, 좋아요"]) assert.equal(asksNothing(message), true, message);
});

test("a site's statistics asked in every language: read at once, with the period said", () => {
  const granted = { analytics: true, searchConsole: true };
  const read = (message: string) => {
    const ask = googleDataAsk(message, granted);
    return ask ? `${ask.tool}${"start_date" in ask.args ? ` ${ask.args.start_date}` : ""}` : null;
  };
  assert.equal(read("Wie viele Besucher hatte meine Website diese Woche?"), "google_analytics_report 6daysAgo");
  assert.equal(read("¿Cuántas visitas tuvo mi sitio web este mes?"), "google_analytics_report 29daysAgo");
  assert.equal(read("Quanti visitatori ha avuto il mio sito ieri?"), "google_analytics_report yesterday");
  assert.equal(read("Quantos visitantes meu site teve nos últimos 7 dias?"), "google_analytics_report 7daysAgo");
  assert.equal(read("Hoeveel bezoekers had mijn website vandaag?"), "google_analytics_report today");
  assert.equal(read("今週のサイトの訪問者数は？"), "google_analytics_report 6daysAgo");
  assert.equal(read("我的网站这个月有多少访客？"), "google_analytics_report 29daysAgo");
  assert.equal(read("이번 주 내 사이트 방문자 수는?"), "google_analytics_report 6daysAgo");
  assert.equal(read("Mit welchen Suchanfragen erscheine ich bei Google?"), "search_console_query 27daysAgo");
  assert.equal(read("今サイトに何人いる？"), "google_analytics_realtime");
  assert.equal(read("现在我的网站上有多少人？"), "google_analytics_realtime");
  assert.equal(read("Wie geht es dir?"), null);
  assert.equal(read("Tengo visitas este fin de semana"), null, "guests, not a site's visits");
  assert.equal(periodOf("letzten 14 Tage").start_date, "14daysAgo");
  assert.equal(periodOf("过去30天").start_date, "30daysAgo");
});

test("money, « remember that… », e-mails, documents and « shall I look? » in every language", () => {
  for (const message of ["Wie viel habe ich diesen Monat ausgegeben?", "¿Cuánto he gastado en octubre?", "Quanto ho speso a ottobre?", "Quanto eu gastei em outubro?", "Hoeveel heb ik in oktober uitgegeven?", "今月いくら使った？", "这个月花了多少钱？", "이번 달에 얼마 썼어?"]) {
    assert.equal(askedBank(message), true, message);
  }
  assert.equal(askedBank("Wie geht es dir?"), false);
  assert.equal(askedToRemember("Merk dir, dass meine Tochter Lea heißt."), "Meine Tochter Lea heißt");
  assert.equal(askedToRemember("Recuerda que soy alérgico a las nueces"), "Soy alérgico a las nueces");
  assert.equal(askedToRemember("Onthoud dat mijn tandarts op vrijdag is"), "Mijn tandarts op vrijdag is");
  assert.equal(askedToRemember("私の誕生日は5月3日だと覚えておいて"), "私の誕生日は5月3日");
  assert.equal(askedToRemember("记住我的生日是5月3日"), "我的生日是5月3日");
  assert.equal(askedToRemember("내 생일은 5월 3일이라는 걸 기억해 줘"), "내 생일은 5월 3일");
  assert.equal(askedToRemember("¿Recuerdas que fuimos a Roma?"), null);
  for (const message of ["Was steht in meinen E-Mails von gestern?", "¿Tengo correos nuevos de Ana?", "Cosa c'è nella mia posta?", "ポールからのメールはある？", "保罗给我发邮件了吗？", "폴한테서 이메일 왔어?"]) assert.equal(aboutEmails(message), true, message);
  for (const message of ["Wat staat er in mijn huurcontract?", "Zoek de factuur van KPN", "我的租房合同里写了什么？"]) assert.equal(aboutDocuments(message), true, message);
  assert.equal(aboutDocuments("Wat is de hoofdstad van Italië?"), false);
  for (const said of ["Soll ich in Ihren E-Mails suchen?", "¿Quieres que busque en tus documentos?", "メールを検索しましょうか？", "要我帮你查一下邮件吗？", "이메일을 검색할까요?"]) assert.equal(looksLikeAnnouncement(said), true, said);
});

test("a connector's data announced, not fetched, in every language: held and the tool asked for", () => {
  for (const said of [
    "Ich werde Ihre 5 letzten Angebote abrufen.", "Ich rufe Ihre offenen Tickets ab.", "Lassen Sie mich die Daten aus Linear holen.",
    "Voy a obtener tus últimas 5 ofertas.", "Puedo mostrar tus tickets abiertos.", "Déjame recuperar tus issues.",
    "Recupero le tue ultime 5 offerte.", "Posso elencare i tuoi ticket aperti.",
    "Vou obter suas últimas 5 ofertas.", "Deixe-me recuperar suas issues.",
    "Ik ga je laatste 5 offertes ophalen.", "Ik haal je open tickets op.",
    "最新のオファーを5件取得します。", "未解決のチケットを一覧表示します。", "我来获取你最近的5个报价。", "让我列出你的未结工单。",
    "최근 제안 5개를 가져오겠습니다.", "열린 티켓을 조회하겠습니다.",
  ]) assert.equal(looksLikeAnnouncement(said), true, said);
  for (const said of [
    "Ich habe Ihre 5 letzten Angebote: A, B, C, D und E.", "Ich hole morgen die Kinder ab und rufe dann Paul an.", "Ich zeige Ihnen gern, wie das geht, wenn Sie möchten. Das Angebot A kostet 100 €.",
    "Las ofertas son A, B y C.", "Il prezzo è mostrato nella tabella qui sotto.", "Posso dire che è andata bene.", "Vou bem, obrigado!",
    "Ik haal morgen de kinderen op van school, zei Paul.", "Ik vraag me af of dat klopt; Paul zei van wel.",
    "画面に表示されている数字は100です。", "数据显示销售额增长了10%。", "가져오신 서류는 잘 받았습니다.",
  ]) assert.equal(looksLikeAnnouncement(said), false, said);
});

test("the app's screens are named as the person's app names them; English when the language is not the app's", () => {
  assert.equal(uiLanguage("pt-BR"), "pt");
  assert.equal(uiLanguage("zh-Hans-CN"), "zh");
  assert.equal(uiLanguage("he-IL"), "en");
  assert.equal(uiLanguage(null), "en");
  assert.equal(capabilityPlace("de-DE", "home"), "Fähigkeiten → Zuhause");
  assert.equal(capabilityPlace("ja-JP", "connectors"), "機能 → コネクタ");
  assert.equal(capabilityPlace("fr-FR", "bank"), "Capacités → Banque");
  assert.match(homeUnusedNote("off", "de-DE"), /Fähigkeiten → Zuhause/);
  assert.doesNotMatch(homeUnusedNote("off", "de-DE"), /Capacités|Maison/);
  assert.match(homeUnusedNote("left_out", "es-ES"), /Casa is switched off for this message in Herramientas/);
  assert.match(homeErrorSentence(new HomeError("not_configured"), "ko-KR"), /기능 → 홈/);
  assert.match(googleDataErrorSentence("google_refused", "analytics", "nl-NL"), /Mogelijkheden → Koppelingen/);
  assert.match(howToGrant("de-DE"), /Dokumente.*« Ordner hinzufügen ».*« Downloads », « Schreibtisch »/);
  assert.match(howToGrant("zh-CN"), /文档.*« 添加文件夹 ».*« 下载 », « 桌面 »/);
  assert.doesNotMatch(howToGrant("it-IT"), /Ajouter|Bureau|Téléchargements/);
  const notGranted = { status: "not_granted" as const, label: "Desktop (~/Desktop)", where: [], total: 0, files: [], limited: false };
  assert.match(formatListing(notGranted, { sort: "recent", kinds: [], count: false }, null, "es-ES"), /« Añadir una carpeta »/);
  const notSelected = { status: "not_selected" as const, asked: "Schreibtisch", where: "", folders: [], folderTotal: 0, files: [], total: 0, limited: false, recursive: false };
  assert.match(formatFolderListing(notSelected, { sort: "name", kinds: [] }, null, "de-DE"), /Werkzeuge → Dokumente/);
  assert.equal(uiLabels("ko").desktop, "데스크탑");
});
