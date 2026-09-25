#!/usr/bin/env node
// Stands in for twoody-ocr (the Mac app's Vision helper) in the tests: it
// answers each page it is asked for with a line naming it, and writes down
// how it was called when FAKE_OCR_LOG says where.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_OCR_LOG) appendFileSync(process.env.FAKE_OCR_LOG, JSON.stringify(args) + "\n");
if (process.env.FAKE_OCR_FAIL) {
  process.stderr.write("the fake helper was told to fail\n");
  process.exit(2);
}
const at = args.indexOf("--pages");
const pages = at >= 0 ? args[at + 1].split(",").map(Number) : [1];
process.stdout.write(JSON.stringify({ engine: "fake", pages: pages.map((page) => ({ page, text: `Texte lu par OCR, page ${page} : préavis de trois mois.` })) }));
