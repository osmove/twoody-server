import assert from "node:assert/strict";
import test from "node:test";

// A message plainly about the person's website is given the likeliest
// figures with it (google/dataIntent.ts, 08/10/2026): Qwen3.5 9B, given the
// tools alone, asked which site or which period for 1 to 3 questions of 7.

const { googleDataAsk, periodOf } = await import("../src/google/dataIntent.js");
const both = { analytics: true, searchConsole: true };

test("the period a message names, else the last 28 days", () => {
  assert.deepEqual(periodOf("combien de visiteurs cette semaine ?"), { start_date: "6daysAgo", end_date: "today", said: true });
  assert.deepEqual(periodOf("sur les 90 derniers jours"), { start_date: "90daysAgo", end_date: "today", said: true });
  assert.deepEqual(periodOf("hier"), { start_date: "yesterday", end_date: "yesterday", said: true });
  assert.deepEqual(periodOf("d'où viennent mes visiteurs ?"), { start_date: "27daysAgo", end_date: "today", said: false });
});

test("what is read: a report, realtime, search queries, a page's indexing — or nothing", () => {
  assert.equal(googleDataAsk("Combien de visiteurs j'ai eu sur mon site cette semaine ?", both)?.tool, "google_analytics_report");
  assert.deepEqual(googleDataAsk("Quelles sont les pages les plus vues ce mois-ci ?", both)?.args.dimensions, ["pagePath"]);
  assert.deepEqual(googleDataAsk("D'où viennent mes visiteurs ?", both)?.args.dimensions, ["sessionDefaultChannelGroup"]);
  assert.equal(googleDataAsk("Combien de personnes sont sur le site en ce moment ?", both)?.tool, "google_analytics_realtime");
  assert.deepEqual(googleDataAsk("Sur quelles requêtes Google mon site apparaît ?", both)?.args.dimensions, ["query"]);
  assert.equal(googleDataAsk("Quel est mon taux de clic moyen dans Google ?", both)?.tool, "search_console_query");
  assert.deepEqual(googleDataAsk("Est-ce que la page https://twoody.com/beta est indexée ?", both), { tool: "search_console_inspect_url", args: { url: "https://twoody.com/beta" } });
  assert.equal(googleDataAsk("Salut, ça va ?", both), null);
  assert.equal(googleDataAsk("Rappelle-moi d'appeler maman", both), null);
  // Only what was granted.
  assert.equal(googleDataAsk("Combien de visiteurs cette semaine ?", { analytics: false, searchConsole: true }), null);
  assert.equal(googleDataAsk("Sur quelles requêtes Google j'apparais ?", { analytics: true, searchConsole: false }), null);
});
