// A small JSON Schema checker for the contract fixtures (test/fixtures/
// *.schema.json): the keywords those files use, no dependency. Returns the
// problems found, empty when the value fits.

type Schema = Record<string, any> | boolean;

export function validate(schema: Schema, value: unknown, root: Schema = schema, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  const s = schema as Record<string, any>;
  if (s.$ref) {
    const target = String(s.$ref).replace(/^#\//, "").split("/").reduce((node: any, key: string) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    if (target === undefined) return [`${at}: unknown $ref ${s.$ref}`];
    return validate(target, value, root, at);
  }
  const errors: string[] = [];
  const type = typeOf(value);
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => t === type || (t === "number" && type === "integer"))) return [`${at}: ${type}, expected ${types.join("|")}`];
  }
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) errors.push(`${at}: not ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (s.anyOf && !s.anyOf.some((sub: Schema) => validate(sub, value, root, at).length === 0)) errors.push(`${at}: matches none of anyOf`);
  if (s.oneOf && s.oneOf.filter((sub: Schema) => validate(sub, value, root, at).length === 0).length !== 1) errors.push(`${at}: does not match exactly one of oneOf`);
  if (s.allOf) for (const sub of s.allOf) errors.push(...validate(sub, value, root, at));
  if (s.not && validate(s.not, value, root, at).length === 0) errors.push(`${at}: matches not`);
  if (s.if) {
    const branch = validate(s.if, value, root, at).length === 0 ? s.then : s.else;
    if (branch !== undefined) errors.push(...validate(branch, value, root, at));
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && [...value].length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && [...value].length > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(value)) errors.push(`${at}: does not match ${s.pattern}`);
    if (s.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${at}: not a date-time`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${at}: above ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push(`${at}: not above ${s.exclusiveMinimum}`);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) errors.push(`${at}: not below ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
    if (s.items !== undefined) value.forEach((item, i) => errors.push(...validate(s.items, item, root, `${at}[${i}]`)));
  }
  if (type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in object)) errors.push(`${at}: missing ${key}`);
    const properties = s.properties ?? {};
    for (const [key, child] of Object.entries(object)) {
      if (key in properties) errors.push(...validate(properties[key], child, root, `${at}.${key}`));
      else if (s.patternProperties && Object.keys(s.patternProperties).some((p) => new RegExp(p, "u").test(key))) {
        for (const [p, sub] of Object.entries(s.patternProperties)) if (new RegExp(p, "u").test(key)) errors.push(...validate(sub as Schema, child, root, `${at}.${key}`));
      } else if (s.additionalProperties !== undefined) errors.push(...validate(s.additionalProperties, child, root, `${at}.${key}`));
    }
    if (s.maxProperties !== undefined && Object.keys(object).length > s.maxProperties) errors.push(`${at}: too many properties`);
  }
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}
