import Ajv from 'ajv';
const ajv = new Ajv({ allErrors: true, strict: false });
export function assertStrictSchema(schema: unknown, path = '$'): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) { schema.forEach((v,i)=>assertStrictSchema(v, `${path}[${i}]`)); return; }
  const node = schema as Record<string, any>;
  if (typeof node.uniqueItems === 'boolean') throw new Error(`Schema ${path}: uniqueItems is not supported by Codex strict outputs; deduplicate in application code`);
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) || node.properties) {
    if (node.additionalProperties !== false) throw new Error(`Schema ${path}: additionalProperties must be false`);
    const keys = Object.keys(node.properties || {}).sort();
    const required = [...(node.required || [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(required)) throw new Error(`Schema ${path}: every property must be required`);
  }
  for (const [k,v] of Object.entries(node)) if (v && typeof v === 'object') assertStrictSchema(v, `${path}.${k}`);
}
export function validateOutput<T>(schema: Record<string, unknown>, value: unknown): T {
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`Invalid structured output: ${ajv.errorsText(validate.errors)}`);
  return value as T;
}
