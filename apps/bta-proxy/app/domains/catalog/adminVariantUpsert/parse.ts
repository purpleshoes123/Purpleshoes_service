export type VariantKey = {
  ticketType: "adult" | "child" | "infant";
  tier: number;
};

type SelectedOption = { name: string; value: string };

type OptionMatch = {
  ticketType?: string;
  paxTier?: string;
};

function matchOptions(selectedOptions: SelectedOption[]): OptionMatch {
  const exactTicket = selectedOptions.find((opt) => opt.name === "Ticket Type");
  const exactTier = selectedOptions.find((opt) => opt.name === "Pax Tier");

  if (exactTicket || exactTier) {
    return {
      ticketType: exactTicket?.value,
      paxTier: exactTier?.value,
    };
  }

  const fallbackTicket = selectedOptions.find(
    (opt) => opt.name.trim().toLowerCase() === "ticket type",
  );
  const fallbackTier = selectedOptions.find((opt) => opt.name.trim().toLowerCase() === "pax tier");

  return {
    ticketType: fallbackTicket?.value,
    paxTier: fallbackTier?.value,
  };
}

function normalizeTicketType(value: string | undefined): VariantKey["ticketType"] | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "adult") {
    return "adult";
  }
  if (normalized === "child") {
    return "child";
  }
  if (normalized === "infant") {
    return "infant";
  }
  return null;
}

function parseTier(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const num = Number(value.trim());
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.trunc(num);
}

export function parseVariantKey(selectedOptions: SelectedOption[]): VariantKey | null {
  const { ticketType, paxTier } = matchOptions(selectedOptions);
  const normalizedTicket = normalizeTicketType(ticketType);
  const tier = parseTier(paxTier);

  if (!normalizedTicket || !tier) {
    return null;
  }

  return { ticketType: normalizedTicket, tier };
}
