import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_LABELS, type UiLabels, type UiLanguage } from "../src/uiLabels.js";

// The screens and buttons the model names are the Desktop's own words
// (10/10/2026): compared with its dictionaries when its checkout stands
// beside this one (Jimmy's Mac); skipped elsewhere (CI, a Pi).

const RENDERER = join(import.meta.dirname, "..", "..", "twoody-desktop", "src", "renderer");
const KEYS: Record<keyof UiLabels, string> = {
  capabilities: "nav.capabilities",
  home: "caps.home.title",
  connectors: "caps.connectors.title",
  bank: "caps.bank.title",
  email: "caps.email.title",
  documents: "nav.documents",
  addFolder: "documents.add",
  downloads: "documents.shortcut.downloads",
  desktop: "documents.shortcut.desktop",
  icloud: "documents.shortcut.icloud",
  tools: "chat.tools.title",
};

function dictionary(language: UiLanguage): string {
  if (language === "en" || language === "fr") {
    const main = readFileSync(join(RENDERER, "i18n.ts"), "utf8");
    const en = main.indexOf("const en: Dict = {");
    const fr = main.indexOf("const fr: Dict = {");
    return language === "en" ? main.slice(en, fr) : main.slice(fr);
  }
  return readFileSync(join(RENDERER, "locales", `${language}.ts`), "utf8");
}

test("each label is the Desktop's, word for word, in each of its languages", { skip: !existsSync(join(RENDERER, "i18n.ts")) && "no twoody-desktop checkout beside this one" }, () => {
  for (const [language, labels] of Object.entries(UI_LABELS) as Array<[UiLanguage, UiLabels]>) {
    const source = dictionary(language);
    for (const [field, key] of Object.entries(KEYS) as Array<[keyof UiLabels, string]>) {
      const found = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`).exec(source)?.[1];
      assert.equal(labels[field], found, `${language} ${key}`);
    }
  }
});
