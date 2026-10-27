export function normalizeId(value?: string | number | null): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

export function normalizeCustomerId(value?: string | number | null): string | null {
  return normalizeId(value);
}

export function normalizeCode(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

export function normalizeTags(values?: string[] | null): Set<string> {
  const set = new Set<string>();
  if (!values) return set;
  for (const value of values) {
    if (!value) continue;
    set.add(value.trim().toUpperCase());
  }
  return set;
}

export function normalizeHandles(values?: string[] | null): Set<string> {
  const set = new Set<string>();
  if (!values) return set;
  for (const value of values) {
    if (!value) continue;
    set.add(value.trim().toLowerCase());
  }
  return set;
}
