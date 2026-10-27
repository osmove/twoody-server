import { wordDocument } from "../../fileActions/wordFile.js";
import type { SectionKind } from "./prompts.js";
import type { OverviewRow, Section } from "./store.js";

// The overview as a Word document (« Exporter en Word »): its sections, each
// line with its sources (the document, the page, its own words), in the
// overview's language.

type Words = Record<SectionKind, string> & { title: string; made: (date: string, count: number) => string; source: string; page: string; empty: string };

const WORDS: Record<string, Words> = {
  en: { title: "Project overview", brief: "What the brief asks for", decisions: "Decisions", status: "Where the project stands", next_steps: "Next steps", open_questions: "Open questions", made: (date, count) => `Made on ${date} from ${count} documents.`, source: "Source", page: "p.", empty: "Nothing in the documents." },
  fr: { title: "Synthèse du projet", brief: "Ce que demande le brief", decisions: "Décisions", status: "Où en est le projet", next_steps: "Prochaines étapes", open_questions: "Questions ouvertes", made: (date, count) => `Faite le ${date} à partir de ${count} documents.`, source: "Source", page: "p.", empty: "Rien dans les documents." },
  de: { title: "Projektübersicht", brief: "Anforderungen aus dem Briefing", decisions: "Entscheidungen", status: "Stand des Projekts", next_steps: "Nächste Schritte", open_questions: "Offene Fragen", made: (date, count) => `Erstellt am ${date} aus ${count} Dokumenten.`, source: "Quelle", page: "S.", empty: "Nichts in den Dokumenten." },
  es: { title: "Resumen del proyecto", brief: "Lo que pide el briefing", decisions: "Decisiones", status: "Estado del proyecto", next_steps: "Próximos pasos", open_questions: "Preguntas abiertas", made: (date, count) => `Hecho el ${date} a partir de ${count} documentos.`, source: "Fuente", page: "p.", empty: "Nada en los documentos." },
  it: { title: "Sintesi del progetto", brief: "Cosa chiede il brief", decisions: "Decisioni", status: "A che punto è il progetto", next_steps: "Prossimi passi", open_questions: "Domande aperte", made: (date, count) => `Fatta il ${date} da ${count} documenti.`, source: "Fonte", page: "p.", empty: "Niente nei documenti." },
  pt: { title: "Resumo do projeto", brief: "O que o briefing pede", decisions: "Decisões", status: "Situação do projeto", next_steps: "Próximos passos", open_questions: "Questões em aberto", made: (date, count) => `Feito em ${date} a partir de ${count} documentos.`, source: "Fonte", page: "p.", empty: "Nada nos documentos." },
  nl: { title: "Projectoverzicht", brief: "Wat de briefing vraagt", decisions: "Besluiten", status: "Stand van het project", next_steps: "Volgende stappen", open_questions: "Open vragen", made: (date, count) => `Gemaakt op ${date} uit ${count} documenten.`, source: "Bron", page: "p.", empty: "Niets in de documenten." },
  ja: { title: "プロジェクトの概要", brief: "ブリーフの要件", decisions: "決定事項", status: "プロジェクトの状況", next_steps: "次のステップ", open_questions: "未解決の課題", made: (date, count) => `${date}に${count}件の文書から作成。`, source: "出典", page: "p.", empty: "文書に記載はありません。" },
  zh: { title: "项目概览", brief: "简报的要求", decisions: "决定", status: "项目进展", next_steps: "下一步", open_questions: "待解决的问题", made: (date, count) => `${date}根据${count}份文档生成。`, source: "来源", page: "第", empty: "文档中没有相关内容。" },
  ko: { title: "프로젝트 개요", brief: "브리프 요구 사항", decisions: "결정 사항", status: "프로젝트 현황", next_steps: "다음 단계", open_questions: "미해결 질문", made: (date, count) => `${date}에 문서 ${count}개로 작성했습니다.`, source: "출처", page: "p.", empty: "문서에 내용이 없습니다." },
};

export function overviewWords(language: string): Words {
  return WORDS[language] ?? WORDS.en!;
}

const LOCALES: Record<string, string> = { en: "en-GB", fr: "fr-FR", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-BR", nl: "nl-NL", ja: "ja-JP", zh: "zh-CN", ko: "ko-KR" };

/// Markdown for the Word writer: escaped, so that a document's words never
/// become formatting.
const escape = (text: string) => text.replace(/([\\`*_{}[\]()#+\-.!|~<>])/g, "\\$1");

const quoted = (language: string, text: string) => (language === "fr" ? `« ${text} »` : language === "de" ? `„${text}“` : language === "ja" ? `「${text}」` : `“${text}”`);

export function overviewMarkdown(title: string, overview: OverviewRow, sections: Section[]): string {
  const words = overviewWords(overview.language);
  const date = new Date(overview.builtAt ?? Date.now()).toLocaleDateString(LOCALES[overview.language] ?? "en-GB", { day: "numeric", month: "long", year: "numeric" });
  const out = [`# ${escape(words.title)} — ${escape(title)}`, "", `*${escape(words.made(date, overview.documents?.read ?? 0))}*`, ""];
  for (const section of sections) {
    out.push(`## ${escape(words[section.kind])}`, "");
    if (!section.lines.length) out.push(escape(words.empty), "");
    for (const line of section.lines) {
      out.push(`- ${escape(line.text)}`);
      for (const source of line.sources.slice(0, 4)) {
        const page = source.page !== null ? (overview.language === "zh" ? `, ${words.page}${source.page}页` : `, ${words.page} ${source.page}`) : "";
        out.push(`  - ${escape(words.source)}: ${escape(source.name)}${escape(page)} — ${quoted(overview.language, escape(source.quote))}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export function overviewDocument(title: string, overview: OverviewRow, sections: Section[]): Uint8Array {
  return wordDocument(overviewMarkdown(title, overview, sections), `${overviewWords(overview.language).title} — ${title}`);
}
