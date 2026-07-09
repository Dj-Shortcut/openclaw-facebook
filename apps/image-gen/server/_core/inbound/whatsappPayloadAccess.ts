export function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function arrayProperty(value: unknown, key: string): unknown[] {
  const object = objectValue(value);
  return Array.isArray(object?.[key]) ? (object[key] as unknown[]) : [];
}

export function stringProperty(value: unknown, key: string): string | null {
  const object = objectValue(value);
  const property = object?.[key];
  return typeof property === "string" ? property : null;
}

export function getNestedObject(
  value: unknown,
  key: string
): Record<string, unknown> | null {
  return objectValue(objectValue(value)?.[key]);
}
