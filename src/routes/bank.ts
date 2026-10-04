import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { capabilityOn } from "../localCapabilities.js";
import { BANK_CATEGORIES, isBankCategory } from "../bank/categories.js";
import { CSV_DELIMITERS, CSV_ROLES, DATE_ORDERS, parseDay, StatementError, type CsvMapping, type CsvRole, type DateOrder } from "../bank/parse.js";
import { BankError, deleteImport, importStatements, listAccounts, listImports, previewImport, renameAccount, searchTransactions, setCategory } from "../bank/store.js";
import { isThisComputersApp } from "./usage.js";

// Capacités → Banque (src/bank/): the statements the person imports, read
// and kept on this computer.
//   GET    /bank                       accounts, imports, categories
//   GET    /bank/transactions          ?q=&account=&category=&from=&to=&direction=&limit=&offset=
//   POST   /bank/imports/preview       { file_name, text, mapping?, date_order?, account_id? }: what would be imported
//   POST   /bank/imports               { file_name, text, mapping?, date_order?, account_id? | account_name? }
//   DELETE /bank/imports/:id           the import, and the transactions no other import holds
//   PATCH  /bank/accounts/:id          { name }
//   PATCH  /bank/transactions/:id      { category, similar? }
// This computer's app only, reading as writing: nothing about the bank
// leaves this computer (the phone: later).

const MAX_TEXT = 10 * 1024 * 1024;

interface ImportBody {
  file_name?: unknown;
  text?: unknown;
  mapping?: unknown;
  date_order?: unknown;
  account_id?: unknown;
  account_name?: unknown;
}

/// The layout the page sends back (snake_case), as the parser takes it.
function mappingFrom(value: unknown): Partial<CsvMapping> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const mapping: Partial<CsvMapping> = {};
  if (typeof input.delimiter === "string" && (CSV_DELIMITERS as readonly string[]).includes(input.delimiter)) mapping.delimiter = input.delimiter;
  if (input.header_row === null) mapping.headerRow = null;
  else if (Number.isInteger(input.header_row) && (input.header_row as number) >= 0) mapping.headerRow = input.header_row as number;
  if (Number.isInteger(input.first_row) && (input.first_row as number) >= 0) mapping.firstRow = input.first_row as number;
  if (Array.isArray(input.columns) && input.columns.length <= 80 && input.columns.every((role) => (CSV_ROLES as readonly unknown[]).includes(role))) mapping.columns = input.columns as CsvRole[];
  if (typeof input.date_order === "string" && (DATE_ORDERS as readonly string[]).includes(input.date_order)) mapping.dateOrder = input.date_order as DateOrder;
  if (input.decimal === "," || input.decimal === ".") mapping.decimal = input.decimal;
  return mapping;
}

/// The parser's view, as the page reads it (snake_case).
function csvView(csv: ReturnType<typeof previewImport>["csv"]) {
  if (!csv) return null;
  const { mapping } = csv;
  return {
    mapping: { delimiter: mapping.delimiter, header_row: mapping.headerRow, first_row: mapping.firstRow, columns: mapping.columns, date_order: mapping.dateOrder, decimal: mapping.decimal },
    rows: csv.rows,
    columns: csv.columns,
  };
}

function readImport(body: ImportBody | undefined, reply: FastifyReply) {
  const fileName = typeof body?.file_name === "string" && body.file_name.trim() ? body.file_name.trim().split(/[\\/]/).pop()!.slice(0, 255) : "statement";
  if (typeof body?.text !== "string" || !body.text.trim()) {
    reply.code(422).send({ error: "empty" });
    return null;
  }
  if (body.text.length > MAX_TEXT) {
    reply.code(413).send({ error: "too_large" });
    return null;
  }
  const dateOrder = typeof body.date_order === "string" && (DATE_ORDERS as readonly string[]).includes(body.date_order) ? (body.date_order as DateOrder) : null;
  return {
    text: body.text,
    options: {
      fileName,
      mapping: mappingFrom(body.mapping),
      dateOrder,
      accountId: typeof body.account_id === "string" && body.account_id ? body.account_id : null,
      accountName: typeof body.account_name === "string" ? body.account_name : null,
    },
  };
}

function failed(err: unknown, reply: FastifyReply) {
  if (err instanceof StatementError) return reply.code(422).send({ error: err.code });
  if (err instanceof BankError) return reply.code(err.code === "invalid" ? 422 : 404).send({ error: err.code });
  throw err;
}

export async function bankRoutes(app: FastifyInstance) {
  const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];
  const guard = async (req: Parameters<typeof requireAuth>[0], reply: FastifyReply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    if (!isThisComputersApp(auth)) {
      reply.code(403).send({ error: "desktop_app_only" });
      return null;
    }
    return auth;
  };

  app.get("/bank", {
    schema: { tags: ["bank"], summary: "Bank: the accounts and imports of the statements kept on this computer", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      reply.send({ enabled: capabilityOn(auth.userId, "bank"), accounts: listAccounts(auth.userId), imports: listImports(auth.userId), categories: BANK_CATEGORIES });
    },
  });

  app.get<{ Querystring: { q?: string; account?: string; category?: string; from?: string; to?: string; direction?: string; limit?: string; offset?: string } }>("/bank/transactions", {
    schema: { tags: ["bank"], summary: "Bank: transactions, newest first", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      const query = req.query ?? {};
      const limit = Number(query.limit);
      const offset = Number(query.offset);
      reply.send(searchTransactions(auth.userId, {
        query: typeof query.q === "string" ? query.q.slice(0, 200) : null,
        accountId: query.account || null,
        category: isBankCategory(query.category) ? query.category : null,
        from: parseDay(query.from, "ymd"),
        to: parseDay(query.to, "ymd"),
        direction: query.direction === "in" || query.direction === "out" ? query.direction : null,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
        offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
      }));
    },
  });

  app.post<{ Body: ImportBody }>("/bank/imports/preview", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { tags: ["bank"], summary: "Bank: what a statement holds, before importing it", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      const input = readImport(req.body, reply);
      if (!input) return;
      try {
        const preview = previewImport(auth.userId, input.text, input.options);
        reply.send({ ...preview, csv: csvView(preview.csv) });
      } catch (err) {
        return failed(err, reply);
      }
    },
  });

  app.post<{ Body: ImportBody }>("/bank/imports", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { tags: ["bank"], summary: "Bank: import a statement (CSV, OFX/QFX, QIF)", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      if (!capabilityOn(auth.userId, "bank")) return reply.code(403).send({ error: "bank_off" });
      const input = readImport(req.body, reply);
      if (!input) return;
      try {
        reply.code(201).send(importStatements(auth.userId, input.text, input.options));
      } catch (err) {
        return failed(err, reply);
      }
    },
  });

  app.delete<{ Params: { id: string } }>("/bank/imports/:id", {
    schema: { tags: ["bank"], summary: "Bank: delete an import, with the transactions only it held", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      try {
        reply.send(deleteImport(auth.userId, req.params.id));
      } catch (err) {
        return failed(err, reply);
      }
    },
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/bank/accounts/:id", {
    schema: { tags: ["bank"], summary: "Bank: rename an account", security, body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      try {
        const account = renameAccount(auth.userId, req.params.id, String(req.body?.name ?? ""));
        if (!account) return reply.code(404).send({ error: "unknown_account" });
        reply.send(account);
      } catch (err) {
        return failed(err, reply);
      }
    },
  });

  app.patch<{ Params: { id: string }; Body: { category?: unknown; similar?: unknown } }>("/bank/transactions/:id", {
    schema: { tags: ["bank"], summary: "Bank: correct a transaction's category (and those of the same counterparty)", security, body: { type: "object", required: ["category"], properties: { category: { type: "string" }, similar: { type: "boolean" } } } },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      if (!isBankCategory(req.body?.category)) return reply.code(422).send({ error: "invalid_category", categories: BANK_CATEGORIES });
      try {
        reply.send(setCategory(auth.userId, req.params.id, req.body.category, req.body.similar === true));
      } catch (err) {
        return failed(err, reply);
      }
    },
  });
}
