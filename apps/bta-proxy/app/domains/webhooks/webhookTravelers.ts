export interface TravelersSnapshot {
  adult: number;
  child: number;
  infant: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeTravelers(value: any): TravelersSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const adult = toNumber(value.adult);
  const child = toNumber(value.child);
  const infant = toNumber(value.infant);

  if (adult === null || child === null || infant === null) {
    return null;
  }

  return {
    adult: Math.max(0, Math.floor(adult)),
    child: Math.max(0, Math.floor(child)),
    infant: Math.max(0, Math.floor(infant)),
  };
}

export function extractTravelersFromLineItems(
  lineItems: Array<{ properties?: Array<{ name: string; value: string }> }>,
): TravelersSnapshot | null {
  for (const lineItem of lineItems) {
    const properties = lineItem.properties || [];
    const prop = properties.find(
      (entry) => entry.name === "travelers_json" || entry.name === "travelersJson",
    );
    if (!prop?.value) {
      continue;
    }
    try {
      const parsed = JSON.parse(prop.value);
      const normalized = normalizeTravelers(parsed);
      if (normalized) {
        return normalized;
      }
    } catch {
      // ignore invalid travelers_json
    }
  }

  return null;
}
