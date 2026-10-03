// A contact's phones, e-mails and addresses as stored (migration 2, as on
// the account): a JSON array of {label, value}. The API still gives plain
// strings; a row from before the migration may still hold strings.

export interface LabelledValue {
  label: string | null;
  value: string;
}

/// The values of a stored list, strings or {label, value}.
export function storedValues(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof (item as LabelledValue).value === "string" ? (item as LabelledValue).value : null))
      .filter((item): item is string => Boolean(item));
  } catch {
    return [];
  }
}

/// Values to store, without labels (the Mac's contacts give none).
export function toStored(values: string[]): string {
  return JSON.stringify(values.map((value): LabelledValue => ({ label: null, value })));
}
