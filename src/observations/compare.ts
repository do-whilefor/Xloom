import { createHash } from "node:crypto";

// Differences are not verdicts.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const missing = Symbol("missing");
type Value = Json | typeof missing;
const object = (value: Value): value is Record<string, Json> => value !== missing && value !== null && typeof value === "object" && !Array.isArray(value);
const conditions = ["conditions", "environment", "target_version", "credential_generation", "session_generation", "stage", "signal_kind"];
const identity = ["actor_ref", "tenant_ref", "owner_ref", "object_ref", "request_object_refs", "subject_refs"];
const own = (value: Record<string, Json>, key: string): Value => Object.hasOwn(value, key) ? value[key]! : missing;
const canonical = (value: Json): string => object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : JSON.stringify(value);
const equal = (a: Value, b: Value): boolean | null => a === missing || b === missing ? a === b ? null : false : canonical(a) === canonical(b);
const pointer = (path: string, part: string | number) => `${path}/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`;
export function changedPaths(a: Value, b: Value, path = ""): string[] {
  if (a === missing && b === missing || equal(a, b)) return [];
  if (object(a) && object(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => changedPaths(own(a, key), own(b, key), pointer(path, key)));
  if (Array.isArray(a) && Array.isArray(b)) return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => changedPaths(i < a.length ? a[i]! : missing, i < b.length ? b[i]! : missing, pointer(path, i))).flat();
  return [path];
}
function lookup(raw: Json, path: string): Value {
  let value: Value = raw;
  for (const part of path.split(".")) {
    if (object(value)) value = own(value, part);
    else if (Array.isArray(value) && /^\d+$/.test(part) && Number.isSafeInteger(Number(part))) value = value[Number(part)] ?? (Number(part) < value.length ? null : missing);
    else return missing;
  }
  return value;
}
function summary(value: Value) {
  if (value === missing) return { present: false as const };
  const data = typeof value === "string" ? value : canonical(value);
  return { present: true as const, type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    byteLength: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex"), encoding: typeof value === "string" ? "utf-8" : "canonical-json" };
}
const view = (value: Value, wholeBody = false) => value === missing ? { present: false } : wholeBody || typeof value === "object" && value !== null
  ? { ...summary(value), valueOmitted: true } : { present: true, value };
const pair = (a: Value, b: Value, wholeBody = false) => ({ left: view(a, wholeBody), right: view(b, wholeBody), equal: equal(a, b) });
const section = (a: Record<string, Json>, b: Record<string, Json>, keys: string[]) => {
  const pick = (raw: Record<string, Json>) => Object.fromEntries(keys.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]!]));
  const left = pick(a), right = pick(b);
  return { left, right, changedPaths: changedPaths(left, right) };
};

export function comparisonFields(fields: unknown): string[] {
  if (!Array.isArray(fields) || fields.length > 64 || fields.some(path => typeof path !== "string" || !path || path.length > 512 || path.split(".").some(part => !part)))
    throw new Error("fields must be up to 64 nonempty dot paths, e.g. response.body.status");
  return [...new Set(fields)] as string[];
}

/** Call only with parsed JSON from verified archives. Missing is distinct from null;
 * ECMAScript JSON numbers do not retain Python's integer/float distinction. */
export function compareValues(left: unknown, right: unknown, fields: unknown = []) {
  const selected = comparisonFields(fields), a = left as Json, b = right as Json;
  for (const raw of [a, b]) if (!object(raw) || ["request", "response"].some(key => Object.hasOwn(raw, key) && !object(raw[key]!)))
    throw new Error("Observation must be a JSON object; request/response must be objects when recorded");
  const x = a as Record<string, Json>, y = b as Record<string, Json>;
  const requestA = own(x, "request"), requestB = own(y, "request"), bodyA = lookup(a, "response.body"), bodyB = lookup(b, "response.body");
  const responseA = (x.response ?? {}) as Record<string, Json>, responseB = (y.response ?? {}) as Record<string, Json>;
  const selectedFields = selected.map(path => ({ path, ...pair(lookup(a, path), lookup(b, path), path === "response.body") }));
  const excluded = new Set([...conditions, ...identity, "request", "response", "observation_id", "run_id", "source_artifact"]);
  const rest = (raw: Record<string, Json>) => Object.fromEntries(Object.entries(raw).filter(([key]) => !excluded.has(key)));
  const gaps: { code: string; side?: string; fields?: string[]; path?: string; sides?: string[] }[] = [
    { code: "controls_not_established" }, { code: "business_outcome_not_established" },
  ];
  for (const [side, raw] of [["left", x], ["right", y]] as const) {
    const context = ["actor_ref", "environment", "session_generation"].filter(key => !Object.hasOwn(raw, key) || raw[key] === null || raw[key] === "");
    if (context.length) gaps.push({ code: "missing_context", side, fields: context });
    const http = ["request", "response.status", "response.body"].filter(path => lookup(raw, path) === missing);
    if (http.length) gaps.push({ code: "missing_http_observation", side, fields: http });
  }
  if (!selected.length) gaps.push({ code: "business_fields_not_selected" });
  for (const field of selectedFields) {
    const sides = ["left", "right"].filter(side => !field[side as "left" | "right"].present);
    if (sides.length) gaps.push({ code: "selected_field_missing", path: field.path, sides });
  }
  return { assessment: "comparison_only", conditions: section(x, y, conditions), identity: section(x, y, identity),
    request: { left: summary(requestA), right: summary(requestB), equal: equal(requestA, requestB),
      method: pair(lookup(a, "request.method"), lookup(b, "request.method")), changedPaths: changedPaths(requestA, requestB, "/request") },
    response: { leftPresent: Object.hasOwn(x, "response"), rightPresent: Object.hasOwn(y, "response"),
      status: pair(lookup(a, "response.status"), lookup(b, "response.status")),
      body: { left: summary(bodyA), right: summary(bodyB), equal: equal(bodyA, bodyB), changedPaths: changedPaths(bodyA, bodyB, "/response/body") },
      metadataChangedPaths: changedPaths(Object.fromEntries(Object.entries(responseA).filter(([key]) => key !== "body")),
        Object.fromEntries(Object.entries(responseB).filter(([key]) => key !== "body")), "/response") },
    selectedFields, otherChangedPaths: changedPaths(rest(x), rest(y)), gaps,
    notice: "Recorded differences only. Check controls, identity, conditions and actual business results; status, timing, hashes or equal bodies do not establish a verdict." };
}
