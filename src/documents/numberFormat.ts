// A spreadsheet cell's number as its format shows it: 0.153 under « 0.0% »
// is 15.3%, 45295 under a date format is a date, 1250 under « #,##0.00 € »
// is 1250.00 €. Decimals, percentages, currency symbols, dates and times
// follow the cell's format; two things do not, on purpose: thousands are
// not grouped and the decimal mark is a point, whatever the language the
// file was written in — so that a number stays one word for the search
// (« 1250 » finds it) and reads the same to a model in any language. A
// date shown the computer's way (Excel's « short date », kept in the file
// as no format at all) is written 2026-01-03, which no reader can take
// for the 1st of March.

/// Excel's built-in formats (ECMA-376 §18.8.30) that a file names by id.
const BUILT_IN: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: "#,##0",
  6: "#,##0",
  7: "#,##0.00",
  8: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "yyyy-mm-dd",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "yyyy-mm-dd hh:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;(#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;(#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};
// The dates and times of East Asian versions of Excel, shown the computer's way.
for (const id of [27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]) BUILT_IN[id] = "yyyy-mm-dd";
for (const id of [32, 33, 55, 56]) BUILT_IN[id] = "h:mm:ss";

/// The format of a built-in id; General for an id it does not know.
export function builtInFormat(id: number): string {
  return BUILT_IN[id] ?? "General";
}

type Language = "en" | "fr";

const MONTHS: Record<Language, string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
};
const MONTHS_SHORT: Record<Language, string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fr: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
};
const DAYS: Record<Language, string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
};
const DAYS_SHORT: Record<Language, string[]> = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  fr: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
};

/// A number as General shows it: integers whole, decimals without the
/// noise of binary floating point (0.1 + 0.2 is 0.3).
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number(value.toPrecision(15))).replace(/e\+?/, "E+").replace("E+-", "E-");
}

/// A format's sections (positive;negative;zero;text), `;` inside quotes
/// and brackets left alone.
function sections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]!;
    if (char === "\\" && !quoted && i + 1 < code.length) {
      current += char + code[i + 1];
      i += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "[") bracket = true;
    else if (!quoted && char === "]") bracket = false;
    if (char === ";" && !quoted && !bracket) {
      out.push(current);
      current = "";
    } else current += char;
  }
  out.push(current);
  return out;
}

/// A section without its literals, colours and locale tags: what tells a
/// date from a number.
function bare(section: string): string {
  return section
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "");
}

export function isDateFormat(code: string): boolean {
  const stripped = bare(sections(code)[0] ?? "");
  if (/general/i.test(stripped)) return false;
  return /[dmyhs]/i.test(stripped.replace(/E[+-]/g, ""));
}

/// The language a format asks for its month and day names: French for
/// [$-40C] and the other French locale ids, or [$-fr-FR]; « system » for
/// the computer's own long date or time ([$-F800], [$-F400]).
function languageOf(section: string): Language | "system" {
  const tag = /\[\$[^\]-]*-([^\]]+)\]/.exec(section);
  if (!tag) return "en";
  const locale = tag[1]!;
  if (/^fr\b/i.test(locale)) return "fr";
  if (/^x-sys/i.test(locale)) return "system";
  const lcid = parseInt(locale, 16);
  if (Number.isNaN(lcid)) return "en";
  if ((lcid & 0xffff) === 0xf800 || (lcid & 0xffff) === 0xf400) return "system";
  return (lcid & 0xff) === 0x0c ? "fr" : "en";
}

/// A cell's value under its format. `date1904`: the workbook counts its
/// days from 1904 (old Mac Excel).
export function formatValue(value: number, code: string | null, date1904 = false): string {
  if (!Number.isFinite(value)) return String(value);
  if (!code || /^\s*(general|@)?\s*$/i.test(code)) return generalNumber(value);
  const parts = sections(code);
  // Conditional sections ([>=100]) are rare and not worth their rules.
  if (parts.some((part) => /\[[<>=]/.test(part))) return generalNumber(value);
  let section = parts[0]!;
  // A negative section writes its own sign (« (1250.00) »).
  let ownSign = false;
  if (value < 0 && parts.length > 1 && bare(parts[1]!).trim() !== "") {
    section = parts[1]!;
    ownSign = true;
  } else if (value === 0 && parts.length > 2 && /0/.test(bare(parts[2]!))) {
    // The accounting formats' « - € » for zero says less than 0.00 €.
    section = parts[2]!;
  }
  if (isDateFormat(section)) {
    // To the second, unless the format shows fractions of one.
    const shown = /\.0/.test(bare(section)) ? value : Math.round(value * 86_400) / 86_400;
    const date = fromSerial(shown, date1904);
    return date ? formatDate(date, section) : generalNumber(value);
  }
  if (/\//.test(bare(section))) return generalNumber(value); // fractions
  return formatNumber(ownSign ? Math.abs(value) : value, section);
}

type NumberToken = { literal: string } | { code: string };

/// A numeric section cut into its code characters (0 # ? . , % E± and the
/// General keyword) and literals: quoted text, escaped characters,
/// currency symbols ([$€-40C]), spaces and signs.
function numberTokens(section: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (let i = 0; i < section.length; i += 1) {
    const char = section[i]!;
    const rest = section.slice(i);
    if (char === '"') {
      const end = section.indexOf('"', i + 1);
      out.push({ literal: section.slice(i + 1, end === -1 ? undefined : end) });
      i = end === -1 ? section.length : end;
    } else if (char === "\\") {
      out.push({ literal: section[i + 1] ?? "" });
      i += 1;
    } else if (char === "_") {
      out.push({ literal: " " }); // the width of the next character
      i += 1;
    } else if (char === "*") {
      i += 1; // a fill character: nothing in text
    } else if (char === "[") {
      const end = section.indexOf("]", i + 1);
      const currency = /^\$([^-\]]+)/.exec(section.slice(i + 1, end === -1 ? undefined : end));
      if (currency) out.push({ literal: currency[1]! });
      i = end === -1 ? section.length : end;
    } else if (/^general/i.test(rest)) {
      out.push({ code: "General" });
      i += 6;
    } else if (/[eE]/.test(char) && /^[+-]/.test(section[i + 1] ?? "")) {
      out.push({ code: `E${section[i + 1]}` });
      i += 1;
    } else if (/[0#?.,%]/.test(char)) out.push({ code: char });
    else out.push({ literal: char });
  }
  return out;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatNumber(value: number, section: string): string {
  const list = numberTokens(section);
  const isDigit = (token: NumberToken) => "code" in token && /^[0#?]$/.test(token.code);
  const general = list.findIndex((token) => "code" in token && token.code === "General");
  const first = general !== -1 ? general : list.findIndex(isDigit);
  if (first === -1) return tidy(`${list.map((token) => ("literal" in token ? token.literal : "")).join("")} ${generalNumber(value)}`);
  let last = first;
  if (general === -1) {
    for (let i = list.length - 1; i > first; i -= 1) {
      if (isDigit(list[i]!)) {
        last = i;
        break;
      }
    }
  }

  let integerZeros = 0;
  let decimals = 0;
  let minDecimals = 0;
  let afterPoint = false;
  let exponent: { sign: string; digits: number } | null = null;
  let percent = 0;
  let scale = 0;
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]!;
    if (!("code" in token)) continue;
    if (token.code === "%") percent += 1;
    if (index < first || index > last) {
      if (token.code === "," && index === last + 1 + scale) scale += 1; // « 0, » divides by a thousand
      continue;
    }
    if (token.code.startsWith("E")) exponent = { sign: token.code.slice(1), digits: 0 };
    else if (exponent) {
      if (token.code === "0") exponent.digits += 1;
    } else if (token.code === ".") afterPoint = true;
    else if (/^[0#?]$/.test(token.code)) {
      if (!afterPoint) {
        if (token.code === "0") integerZeros += 1;
      } else {
        decimals += 1;
        if (token.code === "0") minDecimals += 1;
      }
    }
  }

  let number = (value * 100 ** percent) / 1000 ** scale;
  let digits: string;
  if (general !== -1) digits = generalNumber(Math.abs(number));
  else if (exponent) {
    const [mantissa, power] = Math.abs(number).toExponential(decimals).split("e");
    const exp = Number(power);
    digits = `${mantissa}E${exp < 0 ? "-" : exponent.sign === "+" ? "+" : ""}${String(Math.abs(exp)).padStart(Math.max(1, exponent.digits), "0")}`;
  } else {
    number = round(number, decimals);
    let [whole, fraction = ""] = Math.abs(number).toFixed(decimals).split(".");
    if (fraction.length > minDecimals) fraction = fraction.replace(/0+$/, "").padEnd(minDecimals, "0");
    whole = whole!.padStart(integerZeros, "0");
    if (whole === "0" && integerZeros === 0) whole = fraction ? "" : "0";
    digits = fraction ? `${whole}.${fraction}` : whole;
  }
  const negative = number < 0 && Number(digits.replace(/[^0-9.]/g, "") || "0") !== 0;

  let before = "";
  let after = "";
  list.forEach((token, index) => {
    const text = "literal" in token ? token.literal : token.code === "%" ? "%" : "";
    if (index < first) before += text;
    else if (index > last) after += text;
  });
  return tidy(`${negative ? "-" : ""}${before}${digits}${after}`);
}

/// Rounded on the decimal digits, as Excel shows it (1.005 → 1.01).
function round(value: number, decimals: number): number {
  const shifted = Number(`${Math.abs(value)}e${decimals}`);
  if (!Number.isFinite(shifted)) return value;
  const rounded = Number(`${Math.round(shifted)}e-${decimals}`);
  return value < 0 ? -rounded : rounded;
}

export interface DateParts {
  year: number;
  month: number; // 1–12
  day: number;
  weekday: number; // 0 = Sunday
  hours: number;
  minutes: number;
  seconds: number;
  /// Of a second.
  fraction: number;
  /// The serial number itself, for elapsed times ([h]:mm).
  serial: number;
}

/// A serial date: days since 30 December 1899 (Excel's 1900 system, its
/// fictitious 29 February 1900 included), or since 1 January 1904.
export function fromSerial(serial: number, date1904 = false): DateParts | null {
  if (!(serial >= 0) || serial > 2_958_465) return null;
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86_400_000) / 1000;
  if (seconds >= 86_400) {
    days += 1;
    seconds -= 86_400;
  }
  let epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  if (!date1904 && days < 61) {
    if (days === 60) return { year: 1900, month: 2, day: 29, weekday: 3, hours: 0, minutes: 0, seconds: 0, fraction: 0, serial };
    epoch = Date.UTC(1899, 11, 31);
  }
  const date = new Date(epoch + days * 86_400_000);
  const whole = Math.floor(seconds);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hours: Math.floor(whole / 3600),
    minutes: Math.floor((whole % 3600) / 60),
    seconds: whole % 60,
    fraction: seconds - whole,
    serial,
  };
}

/// A date written in ISO 8601 (the cells of type « d »), as parts.
export function fromIso(text: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?/.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  const serial = (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000 + (hours * 3600 + minutes * 60 + seconds) / 86_400;
  return { year, month, day, weekday: date.getUTCDay(), hours, minutes, seconds, fraction: Number(match[7] ?? 0), serial };
}

type DateToken = { literal: string } | { code: string };

/// A date section cut into codes (yyyy, mm, d, h, ss, AM/PM, [h], .00…)
/// and literals.
function dateTokens(section: string): DateToken[] {
  const out: DateToken[] = [];
  let i = 0;
  while (i < section.length) {
    const char = section[i]!;
    const rest = section.slice(i);
    if (char === '"') {
      const end = section.indexOf('"', i + 1);
      out.push({ literal: section.slice(i + 1, end === -1 ? undefined : end) });
      i = end === -1 ? section.length : end + 1;
      continue;
    }
    if (char === "\\") {
      out.push({ literal: section[i + 1] ?? "" });
      i += 2;
      continue;
    }
    if (char === "_" || char === "*") {
      if (char === "_") out.push({ literal: " " });
      i += 2;
      continue;
    }
    if (char === "[") {
      const end = section.indexOf("]", i + 1);
      const inside = section.slice(i + 1, end === -1 ? undefined : end);
      if (/^(h+|m+|s+)$/i.test(inside)) out.push({ code: `[${inside[0]!.toLowerCase()}]` });
      i = end === -1 ? section.length : end + 1;
      continue;
    }
    const ampm = /^(am\/pm|a\/p)/i.exec(rest);
    if (ampm) {
      out.push({ code: ampm[1]!.length === 5 ? "AM/PM" : "A/P" });
      i += ampm[1]!.length;
      continue;
    }
    const run = /^(y+|m+|d+|h+|s+|e+)/i.exec(rest);
    if (run) {
      const code = run[1]!.toLowerCase();
      out.push({ code: code.startsWith("e") ? "yyyy" : code });
      i += run[1]!.length;
      continue;
    }
    const fraction = /^\.(0+)/.exec(rest);
    const previous = out[out.length - 1];
    if (fraction && previous && "code" in previous && /^(s+|\[s\])$/.test(previous.code)) {
      out.push({ code: `.${fraction[1]}` });
      i += fraction[0].length;
      continue;
    }
    out.push({ literal: char });
    i += 1;
  }
  return out;
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/// A date under a date section: y, m, d, h, s and their repetitions, m
/// as minutes after an hour or before seconds, AM/PM, elapsed [h], [m] and
/// [s], fractions of a second.
export function formatDate(date: DateParts, section: string): string {
  const language = languageOf(section);
  if (language === "system") {
    const stripped = bare(section);
    return /[hs]/i.test(stripped) && !/[dy]/i.test(stripped)
      ? `${pad(date.hours)}:${pad(date.minutes)}:${pad(date.seconds)}`
      : `${date.year}-${pad(date.month)}-${pad(date.day)}`;
  }
  const list = dateTokens(section);
  const codes = list.map((token, index) => ({ token, index })).filter((entry): entry is { token: { code: string }; index: number } => "code" in entry.token);
  const minutes = new Set<number>();
  codes.forEach(({ token, index }, position) => {
    if (token.code !== "m" && token.code !== "mm") return;
    const before = codes[position - 1]?.token.code ?? "";
    const after = codes[position + 1]?.token.code ?? "";
    if (/^(h+|\[h\])$/.test(before) || /^(s+|\[s\])$/.test(after)) minutes.add(index);
  });
  const twelve = codes.some(({ token }) => token.code === "AM/PM" || token.code === "A/P");
  const hours = twelve ? (date.hours % 12 === 0 ? 12 : date.hours % 12) : date.hours;

  let out = "";
  list.forEach((token, index) => {
    if ("literal" in token) {
      out += token.literal;
      return;
    }
    const code = token.code;
    if (code.startsWith("y")) out += code.length <= 2 ? pad(date.year % 100) : String(date.year);
    else if (minutes.has(index)) out += code === "mm" ? pad(date.minutes) : String(date.minutes);
    else if (code === "m") out += String(date.month);
    else if (code === "mm") out += pad(date.month);
    else if (code === "mmm") out += MONTHS_SHORT[language][date.month - 1];
    else if (code === "mmmmm") out += MONTHS[language][date.month - 1]!.slice(0, 1).toUpperCase();
    else if (code.startsWith("m")) out += MONTHS[language][date.month - 1];
    else if (code === "d") out += String(date.day);
    else if (code === "dd") out += pad(date.day);
    else if (code === "ddd") out += DAYS_SHORT[language][date.weekday];
    else if (code.startsWith("d")) out += DAYS[language][date.weekday];
    else if (code.startsWith("h")) out += code.length >= 2 ? pad(hours) : String(hours);
    else if (code.startsWith("s")) out += code.length >= 2 ? pad(date.seconds) : String(date.seconds);
    else if (code === "[h]") out += String(Math.floor(date.serial * 24 + 1e-9));
    else if (code === "[m]") out += String(Math.floor(date.serial * 1440 + 1e-9));
    else if (code === "[s]") out += String(Math.round(date.serial * 86_400));
    else if (code === "AM/PM") out += date.hours < 12 ? "AM" : "PM";
    else if (code === "A/P") out += date.hours < 12 ? "A" : "P";
    else if (code.startsWith(".")) out += `.${String(Math.round(date.fraction * 10 ** (code.length - 1))).padStart(code.length - 1, "0").slice(0, code.length - 1)}`;
  });
  return tidy(out);
}
