import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

// Japanese, Chinese and Korean in keyword search (10/10/2026): while the
// site's screenshots were captured in its ten languages with 0.13.92,
// « 解約予告期間 », « 解除通知期 » and « 해지 예고 기간 » found nothing although
// the words were in the files — FTS5's unicode61 made a whole clause one
// token. Their runs are indexed by pairs of characters (document_grams), a
// question's words cut at particles, and the other languages are searched
// exactly as before.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-cjk-search-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { bigrams, cjkFound, cjkWords, gramsMatch, indexGrams } = await import("../src/documents/cjk.js");
const { buildGramsQuery, buildMatchQuery, queryTerms, termsFound } = await import("../src/documents/query.js");
const { chunkSections } = await import("../src/documents/chunk.js");
const { keywords, memoryWords } = await import("../src/memory/rank.js");
const { sqlite } = await import("../src/db.js");
const { addFolder, reindex, removeFolder, searchPassages } = await import("../src/documents/library.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { searchConversations, searchMemories } = await import("../src/memory/search.js");
const { saveEmail, saveSource, searchEmails, upsertFolder } = await import("../src/email/store.js");
setSpotlightEnabled(false);

// ── a granted folder, indexed before the tests run ─────────────────────

const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const docs = realpathSync(mkdtempSync(join(base, "twoody-cjk-docs-test-")));
test.after(() => {
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  renameSync(docs, join(trash, `${basename(docs)}-${Date.now()}`));
});

const userId = "owner";
sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(userId, "owner@test.invalid", Date.now());
const files: Record<string, string> = {
  "業務委託契約書.txt": "業務委託契約書\n\n第4条（契約期間及び解約）\n本契約の有効期間は一年間とする。各当事者は、三か月の解約予告期間をもって書面で通知することにより、本契約を解約することができる。\n\n第7条（報酬）\n月額報酬は金四十三万円（消費税別）とする。",
  "請求書.txt": "請求書 No. 2026-117\n株式会社オスムーブ 御中\n品目：Twoody導入支援\n金額：¥430,000（税別）\n支払期限：2026年11月30日",
  "服务合同.txt": "服务合同\n\n第四条 合同期限与解除\n本合同有效期为一年。任何一方可提前书面通知对方解除本合同，解除通知期为三个月。\n\n第七条 费用\n每月服务费为人民币三万二千元（不含税）。",
  "용역계약서.txt": "용역 계약서\n\n제4조 (계약 기간 및 해지)\n본 계약의 유효 기간은 1년으로 한다. 각 당사자는 3개월의 해지 예고 기간을 두고 서면으로 통지하여 본 계약을 해지할 수 있다.\n\n제7조 (대금)\n월 용역 대금은 4,300,000원(부가가치세 별도)으로 한다.",
  "contrat-dupont.txt": "CONTRAT DE PRESTATION\n\nArticle 4 — Durée et préavis\nChaque partie peut le résilier par lettre recommandée avec un préavis de trois mois.",
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(docs, name), text);
const folder = await addFolder(userId, docs);
await reindex(userId);
const names = (question: string) => [...new Set(searchPassages(userId, question).map((passage) => passage.name))];

// ── the words ───────────────────────────────────────────────────────────

test("a run of Japanese, Chinese or Korean is indexed as its pairs of characters, and its last character", () => {
  assert.equal(indexGrams("解約予告期間"), "解約 約予 予告 告期 期間 間");
  assert.equal(indexGrams("解除通知期为三个月。"), "解除 除通 通知 知期 期为 为三 三个 个月 月");
  // Korean spaces its words: each one, its particle included.
  assert.equal(indexGrams("해지 예고 기간은"), "해지 지 예고 고 기간 간은 은");
  // Digits written inside a run belong to it; Latin words do not.
  assert.equal(indexGrams("第4条 Twoody導入"), "第4 4条 条 導入 入");
  // Half-width katakana and full-width digits are folded (NFKC).
  assert.equal(indexGrams("ｶﾅ３月"), indexGrams("カナ3月"));
  assert.equal(indexGrams("Le préavis est de trois mois."), "", "nothing for the other languages");
  assert.deepEqual(bigrams("期間"), ["期間"]);
});

test("a question's words are cut at Japanese particles, Chinese function words and Korean particles", () => {
  assert.deepEqual(cjkWords("解約予告期間は何ヶ月ですか？"), ["解約予告期間"], "何, か and 月 alone are left out");
  assert.deepEqual(cjkWords("合同的解除通知期是多久？"), ["合同", "解除通知期"]);
  assert.deepEqual(cjkWords("해지 예고 기간은 얼마인가요?"), ["해지", "예고", "기간"]);
  assert.deepEqual(cjkWords("계약의 해지예고기간이"), ["계약", "해지예고기간"]);
  // A single character is kept when nothing else is left.
  assert.deepEqual(cjkWords("税"), ["税"]);
  assert.deepEqual(cjkWords("税金は？"), ["税金"]);
});

test("a word is found where most of its pairs are: a compound said differently, a particle, a missing space", () => {
  assert.ok(cjkFound("各当事者は、三か月の解約の予告期間をもって", "解約予告期間"));
  assert.ok(cjkFound("본 계약의 해지 예고 기간은 3개월", "해지예고기간"));
  assert.ok(cjkFound("三ヶ月", "三か月"), "Japanese month counters spelled alike");
  assert.ok(!cjkFound("本契約の有効期間は一年間とする", "解約予告期間"), "期間 alone is not the notice period");
  assert.equal(termsFound("解除通知期为三个月", queryTerms("合同的解除通知期是多久？")), 1);
});

test("questions in those scripts search document_grams; the other words still search the main index", () => {
  assert.equal(buildMatchQuery("解約予告期間は何ヶ月ですか？"), null);
  assert.equal(buildGramsQuery("解除通知期"), '"解除 除通 通知 知期" OR "解除" OR "除通" OR "通知" OR "知期"');
  assert.equal(buildGramsQuery("해지 예고 기간"), '"해지" OR "예고" OR "기간"');
  assert.equal(buildGramsQuery("税"), '"税"*');
  // Mixed: the Latin word goes to the main index, glued to a run or not.
  assert.deepEqual(queryTerms("Twoodyの導入費用は？"), ["twoody", "導入費用"]);
  assert.equal(buildMatchQuery("Twoodyの導入費用は？"), '"twoody"*');
  assert.equal(gramsMatch([]), null);
});

test("French and English questions are searched exactly as before", () => {
  // The expressions of 64ac16a (before these scripts were looked at).
  const before: Record<string, string> = {
    "Quel est le délai de préavis du contrat Dupont ?": '"delai" OR "preavi"* OR "contrat"* OR "dupont"*',
    "What is the notice period in the Valvex licence agreement?": '"notic"* OR "period"* OR "valve"* OR "licenc"* OR "agre"*',
    "résume mon CV Product Owner": '"resum"* OR "cv" OR "product"* OR "owner"',
    "facture n° 2026-117 de Tessane": '"factur"* OR "2026" OR "117" OR "tessan"*',
    "m² et œuvre — l'Haÿ-les-Roses": '"m²" OR "œuvre" OR "hay" OR "roses"',
    "What was in the contract of the van?": '"contract"* OR "van"',
  };
  for (const [question, expression] of Object.entries(before)) {
    assert.equal(buildMatchQuery(question), expression, question);
    assert.equal(buildGramsQuery(question), null, question);
  }
  assert.equal(termsFound("Le préavis de résiliation est de trois mois.", queryTerms("délai de préavis")), 1);
});

test("a long Japanese or Chinese paragraph is cut after a sentence, not in the middle of a word", () => {
  const sentence = "本契約の有効期間は一年間とし、各当事者は三か月の解約予告期間をもって書面で通知することにより本契約を解約することができる。";
  const [first, second] = chunkSections([{ page: 1, text: sentence.repeat(40) }]);
  assert.ok(first!.text.endsWith("。"), first!.text.slice(-10));
  assert.ok(second!.text.startsWith("本契約"), "the next passage starts on a sentence");
});

test("memories are ranked on Japanese, Chinese and Korean words too (pairs on both sides)", () => {
  assert.ok(memoryWords("娘の名前はさくらです").includes("名前"));
  assert.ok(keywords("娘の名前は？").has("名前"));
  assert.ok(keywords("딸 이름이 뭐야?").has("이름"));
  // The other languages' words are as they were.
  assert.deepEqual([...keywords("Comment s'appelle ma fille ? Elle est née en 2015.")], ["fille", "nee", "2015"]);
});


test("the words of the files are found in Japanese, Chinese and Korean", () => {
  assert.deepEqual(names("解約予告期間"), ["業務委託契約書.txt"]);
  assert.deepEqual(names("解約予告期間は何ヶ月ですか？"), ["業務委託契約書.txt"]);
  assert.deepEqual(names("解除通知期"), ["服务合同.txt"]);
  assert.deepEqual(names("合同的解除通知期是多久？"), ["服务合同.txt"]);
  assert.deepEqual(names("해지 예고 기간"), ["용역계약서.txt"]);
  assert.deepEqual(names("해지예고기간은 얼마인가요?"), ["용역계약서.txt"]);
  assert.equal(names("支払期限はいつですか")[0], "請求書.txt");
  // The passage and its snippet are the text as written.
  const [passage] = searchPassages(userId, "解約予告期間");
  assert.match(passage!.text, /三か月の解約予告期間をもって/);
  assert.match(passage!.snippet, /解約予告期間/);
  // French as before.
  assert.deepEqual(names("Quel est le préavis ?"), ["contrat-dupont.txt"]);
});

test("a file changed, removed or its folder taken back leaves no pairs behind", async () => {
  const count = () => (sqlite.prepare("SELECT count(*) AS n FROM document_grams").get() as { n: number }).n;
  const before = count();
  assert.ok(before >= 4);
  writeFileSync(join(docs, "服务合同.txt"), "服务合同\n\n第四条 本合同自动续期。");
  // A newer modification time: the file is read again.
  const later = new Date(Date.now() + 5_000);
  (await import("node:fs")).utimesSync(join(docs, "服务合同.txt"), later, later);
  await reindex(userId);
  assert.deepEqual(names("解除通知期"), []);
  assert.deepEqual(names("自动续期"), ["服务合同.txt"]);
  assert.ok(removeFolder(userId, folder.id));
  assert.equal(count(), 0);
});

test("conversations and e-mails are searched in those scripts too, by their pairs", () => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('d1', ?, 'desktop', '契約', ?, ?)").run(userId, now, now);
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES ('m1', 'd1', ?, 'user', '取引先との契約の解約予告期間を確認したい', ?)").run(userId, now);
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES ('m2', 'd1', ?, 'assistant', '明日の天気は晴れです', ?)").run(userId, now + 1);
  const hits = searchConversations(userId, { q: "解約予告期間" });
  assert.deepEqual(hits.map((hit) => hit.message_id), ["m1"]);
  assert.match(hits[0]!.snippet, /解約予告期間/);
  assert.deepEqual(searchConversations(userId, { q: "notice period" }), []);

  const { source } = saveSource(userId, { email_address: "jimmy@example.com", imap_host: "imap.example.com", imap_port: 993, imap_security: "tls", username: "jimmy", import_after: 0 });
  const inbox = upsertFolder(source.id, { path: "INBOX", name: "INBOX", special_use: null, role: "inbox" });
  const mail = (uid: number, subject: string, body: string) => saveEmail({
    user_id: userId, email_source_id: source.id, email_folder_id: inbox.id, uid, uid_validity: 1, provider_message_id: `<${uid}@example.com>`, provider_thread_id: null,
    direction: "inbound", status: "inbox", subject, from_name: "김민수", from_email: "minsu@example.com", to_name: null, to_email: "jimmy@example.com",
    recipients: { to: [], cc: [], reply_to: [] }, text_body: body, body_format: "text", body_truncated: false, is_read: false, is_replied: false, important: false,
    provider_internal_date: now - uid, sent_at: now - uid, size: 100, attachments: [], labels: [], metadata: {}, trashed_at: null,
  } as Parameters<typeof saveEmail>[0]);
  mail(1, "계약 해지 안내", "용역 계약의 해지 예고 기간은 3개월입니다.");
  mail(2, "회의 일정", "다음 주 회의는 화요일입니다.");
  assert.deepEqual(searchEmails(userId, { query: "해지 예고 기간" }).map((email) => email.subject), ["계약 해지 안내"]);
  assert.deepEqual(searchEmails(userId, { query: "契約" }), [], "no pair of the words, no e-mail (not the newest ones)");
});

test("memory search weighs Japanese, Chinese and Korean words", async () => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, content, tags, source, created_at, updated_at) VALUES ('mem1', ?, 'user', '娘の名前はさくらです', '[]', 'manual', ?, ?)").run(userId, now, now);
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, content, tags, source, created_at, updated_at) VALUES ('mem2', ?, 'user', '好きな食べ物は寿司です', '[]', 'manual', ?, ?)").run(userId, now, now);
  const found = await searchMemories(userId, { q: "娘の名前は？" });
  assert.equal(found.items[0]?.id, "mem1");
  assert.ok(found.items[0]!.lexical > 0);
});

test("a word carried over a line break, as a PDF or a scan cuts it, is still one run", () => {
  assert.equal(indexGrams("解除通知期为三\n个月"), indexGrams("解除通知期为三个月"));
  assert.ok(cjkFound("서면으로 통\n지하여", "통지"));
});

test("a notice period asked in Japanese, Chinese or Korean is plainly about the documents, as « préavis » is", async () => {
  const { aboutDocuments } = await import("../src/routes/queries.js");
  for (const said of ["解約予告期間", "予告期間はどのくらい？", "解除通知期", "解约通知要提前多久？", "해지 예고 기간", "예고기간이 얼마야?"]) assert.equal(aboutDocuments(said), true, said);
  for (const said of ["明日の天気は？", "今天天气怎么样？", "오늘 날씨 어때?"]) assert.equal(aboutDocuments(said), false, said);
});

test("the radicals some Chinese PDFs give for characters are read as the characters", async () => {
  const { extractSections } = await import("../src/documents/extract.js");
  const file = join(docs, "..", `${basename(docs)}-radicals.txt`);
  writeFileSync(file, "解除通知期为三个⽉。每⽉服务费");
  try {
    assert.equal((await extractSections(file))[0]!.text, "解除通知期为三个月。每月服务费");
  } finally {
    renameSync(file, join(homedir(), ".Trash", `${basename(file)}-${Date.now()}`));
  }
  assert.equal(indexGrams("三个⽉"), indexGrams("三个月"));
});
