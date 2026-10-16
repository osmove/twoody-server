import assert from "node:assert/strict";
import test from "node:test";

// E-mails and Google Analytics / Search Console are offered to this
// account (src/reservedFeatures.ts: kept for the accounts Osmove chooses).
process.env.TWOODY_RESERVED_FEATURES = "all";

// No answer may tell the person a draft was made when none was (12/10/2026):
// « Dis à maman que je serai en retard », « はい », and Qwen3.5 9B answered
// « ママへのメールの下書きを作成しました … メールはあなたのメールアプリの「下書き」
// フォルダに保存されています » without calling draft_email (non-regression bench
// on 80cc8ca). What reads as a claim, in the ten languages of the app, what
// does not, and the sentence said instead.

const { claimsDraftMade, claimsDraftSaved, answerWithoutDraftClaim, notDraftedSentence, draftNotMadeReason, NOT_DRAFTED, NOT_SAVED } = await import("../src/email/chat.js");
const { agreedToDraft } = await import("../src/email/intent.js");

const LANGUAGES = ["fr", "en", "de", "es", "it", "pt", "nl", "ja", "zh", "ko"] as const;
const REASONS = ["not_called", "needs_address", "not_saved"] as const;

/// The bench's answer, word for word.
const BENCH_JA = "ママへのメールの下書きを作成しました。\n\n- 宛先：mama@example.com\n- 件名：遅れます\n- 本文：遅れるので、申し訳ありませんが、連絡させてください。\n\nメールはあなたのメールアプリの「下書き」フォルダに保存されています。確認して、必要であれば送信してください。";

test("an answer that says a draft was made, saved, sent or is in the Drafts, in the ten languages, is a claim", () => {
  const claims: Record<string, string[]> = {
    fr: ["J'ai créé le brouillon pour maman.", "C'est fait : le brouillon est dans vos brouillons.", "Le brouillon de l'e-mail à maman a été enregistré.", "Vous le trouverez dans votre dossier Brouillons.", "J'ai préparé un brouillon pour votre mère.", "Votre brouillon est prêt.", "Je vous ai envoyé l'e-mail."],
    en: ["I've created a draft to your mom.", "The draft has been saved to your Drafts folder.", "Done! The e-mail to Mom is in your drafts.", "Your draft is ready.", "I sent the e-mail to your mom."],
    de: ["Ich habe einen Entwurf an Mama erstellt.", "Der Entwurf liegt jetzt in Ihrem Ordner „Entwürfe“.", "Ich habe die E-Mail als Entwurf gespeichert.", "Erledigt, der Entwurf ist vorbereitet."],
    es: ["He creado un borrador para tu madre.", "Se ha guardado el borrador en tus borradores.", "Listo, el borrador está en tus borradores.", "Preparé el correo para tu mamá."],
    it: ["Ho creato una bozza per la mamma.", "La bozza è stata salvata nelle tue bozze.", "Fatto! Ho preparato l'e-mail per la mamma."],
    pt: ["Criei um rascunho para a sua mãe.", "O rascunho foi salvo na sua pasta de rascunhos.", "Pronto, o e-mail para sua mãe está nos seus rascunhos."],
    nl: ["Ik heb een concept voor mama aangemaakt.", "Het concept is opgeslagen in je concepten.", "Klaar, de e-mail aan mama staat in uw concepten."],
    ja: [BENCH_JA, "下書きを保存しました。", "ママへのメールを下書きフォルダに保存しました。", "メールの下書きを用意しました。"],
    zh: ["已为您创建邮件草稿。", "草稿已保存到草稿箱。", "我已经给妈妈写好了邮件草稿。"],
    ko: ["엄마에게 보낼 이메일 초안을 작성했습니다.", "초안이 임시 보관함에 저장되었습니다.", "이메일 초안을 만들었어요."],
  };
  assert.deepEqual(Object.keys(claims).sort(), [...LANGUAGES].sort());
  for (const [lang, said] of Object.entries(claims)) for (const answer of said) assert.ok(claimsDraftMade(answer), `${lang}: ${answer}`);
  // After a draft refused, too (the bench's words were missed before).
  assert.ok(claimsDraftSaved(BENCH_JA));
});

test("a question, an offer, a condition, a denial, a text shown for the person to say, the capability described is no claim", () => {
  for (const answer of [
    "Voulez-vous que je rédige un e-mail à maman pour lui dire que vous serez en retard ?",
    "Je peux enregistrer un brouillon dans votre dossier Brouillons.",
    "Si vous voulez, je l'enregistre dans vos brouillons.",
    "Twoody enregistre les brouillons dans votre dossier Brouillons, sans jamais les envoyer.",
    "Voici un brouillon : Objet : Retard. Bonjour maman, je serai en retard. Voulez-vous que je l'enregistre ?",
    "J'ai préparé ce brouillon : Bonjour maman, je serai en retard. Voulez-vous que je l'enregistre dans vos brouillons ?",
    "Je n'ai pas créé de brouillon : il me manque l'adresse de votre mère.",
    "Le brouillon n'a pas été enregistré et rien n'a été envoyé.",
    "I can save a draft to your Drafts folder.", "Would you like me to draft an e-mail to Mom?", "Drafts are saved in your Drafts folder and never sent.", "I haven't saved anything yet.",
    "Soll ich eine E-Mail an Mama entwerfen?", "Ich kann einen Entwurf in Ihrem Ordner Entwürfe speichern.", "Ich habe noch keinen Entwurf erstellt.",
    "¿Quieres que redacte un correo a mamá?", "No he guardado ningún borrador.",
    "Posso salvare una bozza nelle tue bozze.", "Non ho creato nessuna bozza.",
    "Quer que eu escreva um e-mail para sua mãe?", "Ainda não criei nenhum rascunho.",
    "Wilt u dat ik een e-mail aan mama opstel?", "Ik heb nog geen concept gemaakt.",
    "ママにメールの下書きを作成しましょうか？", "下書きを作成できます。", "下書きはまだ作成していません。",
    "要我给妈妈写一封邮件吗？", "我还没有创建草稿。",
    "엄마에게 이메일 초안을 작성해 드릴까요?", "이메일 초안을 작성하겠습니다.", "초안을 만들지 않았습니다.",
    // About something else than a draft.
    "Paul vous a écrit mardi au sujet du devis de la cuisine.", "Vendredi, vous avez rendez-vous avec le Dr Weber à 10 h.",
  ]) assert.ok(!claimsDraftMade(answer), answer);
});

test("the sentence said instead: in the person's language, for each reason, never a claim itself; the offer is one a « yes » takes", () => {
  for (const lang of LANGUAGES) {
    for (const reason of REASONS) {
      const said = notDraftedSentence(reason, lang);
      assert.equal(said, NOT_DRAFTED[lang]![reason]);
      assert.ok(!claimsDraftMade(said), `${lang} ${reason}: ${said}`);
      assert.ok(!claimsDraftSaved(said), `${lang} ${reason}: no claim after a refusal either`);
    }
    assert.ok(!claimsDraftMade(NOT_SAVED[lang]!), `${lang}: the refusal's sentence is no claim`);
    const yes = { fr: "Oui", en: "Yes", de: "Ja, bitte", es: "Sí, por favor", it: "Sì, grazie", pt: "Sim", nl: "Ja graag", ja: "はい、お願いします", zh: "好的", ko: "네" }[lang];
    assert.ok(agreedToDraft(NOT_DRAFTED[lang]!.not_called, yes), `${lang}: « ${yes} » to the offer is a yes to the draft`);
  }
  assert.equal(notDraftedSentence("not_called", "ja-JP"), NOT_DRAFTED.ja!.not_called);
  assert.equal(notDraftedSentence("not_saved", null), NOT_DRAFTED.fr!.not_saved, "French when no language is told");
  assert.equal(notDraftedSentence("not_saved", "sv"), NOT_DRAFTED.en!.not_saved);
});

test("why: not called (or made before the person said how), an address missing, the mailbox not taking it", () => {
  assert.equal(draftNotMadeReason([]), "not_called");
  assert.equal(draftNotMadeReason(["ask_first"]), "not_called");
  for (const error of ["unknown_address", "invalid_address", "no_recipient", "which_address"]) assert.equal(draftNotMadeReason([error]), "needs_address");
  assert.equal(draftNotMadeReason(["no_drafts"]), "not_saved");
  assert.equal(draftNotMadeReason(["unknown_address", "imap_error"]), "not_saved", "the last one tells");
});

test("the answer is kept unless it claims, or says nothing", () => {
  const sentence = notDraftedSentence("not_called", "ja");
  assert.deepEqual(answerWithoutDraftClaim(BENCH_JA, sentence), { text: sentence, corrected: true });
  assert.deepEqual(answerWithoutDraftClaim("", sentence), { text: sentence, corrected: true });
  assert.deepEqual(answerWithoutDraftClaim("  \n", sentence), { text: sentence, corrected: true });
  const asked = "ママに遅れるとメールで伝えましょうか？";
  assert.deepEqual(answerWithoutDraftClaim(asked, sentence), { text: asked, corrected: false });
});
