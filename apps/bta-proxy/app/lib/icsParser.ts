type ParsedEvent = {
  dtstart?: string;
  dtend?: string;
  dtstartIsDateOnly?: boolean;
  dtendIsDateOnly?: boolean;
  summary?: string;
  rrule?: string;
  exdates: string[];
  hasTimeValue: boolean;
};

export type IcsParseOptions = {
  from?: string;
  to?: string;
  includePast?: boolean;
  maxOccurrences?: number;
  maxRangeDays?: number;
};

export type IcsPreviewResult = {
  calendarTitle?: string;
  eventsParsed: number;
  expandedDates: string[];
  dateNotes: Record<string, string>;
  warnings: string[];
};

const DEFAULT_MAX_OCCURRENCES = 2000;
const DEFAULT_MAX_RANGE_DAYS = 365;
const dateOnlyRegex = /^\d{8}$/;
const dateTimeRegex = /^\d{8}T\d{6}Z?$/;

class IcsParseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function unfoldLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if (!line) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const prev = lines.pop() || "";
      lines.push(`${prev}${line.slice(1)}`);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function toDateString(value: string): { date: string; hasTime: boolean } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (dateOnlyRegex.test(trimmed)) {
    return {
      date: `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`,
      hasTime: false,
    };
  }
  if (dateTimeRegex.test(trimmed)) {
    return {
      date: `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`,
      hasTime: true,
    };
  }
  return null;
}

function parseRrule(value: string): {
  freq?: "DAILY" | "WEEKLY";
  count?: number;
  until?: string;
  byday?: string[];
} {
  const parts = value.split(";").map((part) => part.trim());
  const result: {
    freq?: "DAILY" | "WEEKLY";
    count?: number;
    until?: string;
    byday?: string[];
  } = {};

  for (const part of parts) {
    const [key, rawValue] = part.split("=");
    if (!key || !rawValue) continue;
    if (key === "FREQ" && (rawValue === "DAILY" || rawValue === "WEEKLY")) {
      result.freq = rawValue;
    }
    if (key === "COUNT") {
      const count = Number(rawValue);
      if (!Number.isNaN(count)) {
        result.count = count;
      }
    }
    if (key === "UNTIL") {
      const until = toDateString(rawValue);
      if (until) {
        result.until = until.date;
      }
    }
    if (key === "BYDAY") {
      result.byday = rawValue.split(",").map((day) => day.trim());
    }
  }

  return result;
}

function parseEvents(lines: string[]): {
  events: ParsedEvent[];
  calendarTitle?: string;
  warnings: string[];
} {
  const events: ParsedEvent[] = [];
  let current: ParsedEvent | null = null;
  let calendarTitle: string | undefined;
  const warnings: string[] = [];

  for (const line of lines) {
    if (line.startsWith("X-WR-CALNAME:")) {
      calendarTitle = line.split(":").slice(1).join(":").trim() || calendarTitle;
      continue;
    }
    if (line === "BEGIN:VEVENT") {
      current = {
        exdates: [],
        hasTimeValue: false,
      };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        events.push(current);
      }
      current = null;
      continue;
    }

    if (!current) continue;
    const [rawKey, rawValue] = line.split(":", 2);
    if (!rawValue) continue;
    const keyParts = rawKey.split(";");
    const key = keyParts[0];
    const params = keyParts.slice(1);

    const hasValueDate = params.some((param) => param.toUpperCase() === "VALUE=DATE");
    const hasTz = params.some((param) => param.toUpperCase().startsWith("TZID="));

    if (key === "DTSTART") {
      const parsed = toDateString(rawValue);
      if (parsed) {
        current.dtstart = parsed.date;
        current.dtstartIsDateOnly = !parsed.hasTime;
        if (parsed.hasTime || hasTz) {
          current.hasTimeValue = true;
        }
      }
      continue;
    }
    if (key === "DTEND") {
      const parsed = toDateString(rawValue);
      if (parsed) {
        current.dtend = parsed.date;
        current.dtendIsDateOnly = !parsed.hasTime;
        if (parsed.hasTime || hasTz) {
          current.hasTimeValue = true;
        }
      }
      continue;
    }
    if (key === "SUMMARY") {
      current.summary = rawValue.trim();
      continue;
    }
    if (key === "RRULE") {
      current.rrule = rawValue.trim();
      continue;
    }
    if (key === "EXDATE") {
      const rawDates = rawValue.split(",");
      for (const rawDate of rawDates) {
        const parsed = toDateString(rawDate.trim());
        if (parsed) {
          current.exdates.push(parsed.date);
          if (parsed.hasTime || hasTz) {
            current.hasTimeValue = true;
          }
        }
      }
      continue;
    }
  }

  if (events.some((event) => event.hasTimeValue)) {
    warnings.push("시간/타임존 값은 날짜 기준으로 처리됩니다.");
  }

  return { events, calendarTitle, warnings };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateString(value: string): Date {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
}

function getKstToday(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return formatDate(kst);
}

function expandEventDates(
  event: ParsedEvent,
  options: Required<IcsParseOptions>
): { dates: string[]; dateNotes: Record<string, string> } {
  if (!event.dtstart) {
    return { dates: [], dateNotes: {} };
  }

  const startDate = event.dtstart;
  const start = parseDateString(startDate);
  const minDate = options.includePast
    ? null
    : (() => {
        const today = getKstToday();
        if (!options.from) return today;
        return options.from > today ? options.from : today;
      })();
  const maxRangeEnd = formatDate(addDays(start, options.maxRangeDays - 1));
  const untilLimit = event.rrule ? parseRrule(event.rrule).until : undefined;

  let effectiveFrom = options.from || startDate;
  let effectiveTo = options.to || maxRangeEnd;
  if (untilLimit && untilLimit < effectiveTo) {
    effectiveTo = untilLimit;
  }

  const dates: string[] = [];
  const dateNotes: Record<string, string> = {};
  const exdates = new Set(event.exdates);
  const note = event.summary?.trim();

  const rrule = event.rrule ? parseRrule(event.rrule) : null;

  const includeDate = (date: string) => {
    if (minDate && date < minDate) {
      return;
    }
    if (date < effectiveFrom || date > effectiveTo) {
      return;
    }
    if (exdates.has(date)) {
      return;
    }
    dates.push(date);
    if (note && !dateNotes[date]) {
      dateNotes[date] = note;
    }
  };

  if (!rrule || !rrule.freq) {
    if (event.dtend && event.dtend > startDate) {
      const rawEnd = parseDateString(event.dtend);
      const endDate = event.dtendIsDateOnly ? addDays(rawEnd, -1) : rawEnd;
      for (let cursor = new Date(start); cursor <= endDate; cursor = addDays(cursor, 1)) {
        includeDate(formatDate(cursor));
        if (dates.length >= options.maxOccurrences) break;
      }
      return { dates, dateNotes };
    }
    includeDate(startDate);
    return { dates, dateNotes };
  }

  const byday = rrule.byday && rrule.byday.length > 0 ? rrule.byday : undefined;
  const targetByday = byday || [dayCodeFromDate(start)];
  const maxCount = rrule.count ?? options.maxOccurrences;
  let occurrences = 0;

  for (
    let cursor = new Date(start);
    cursor <= parseDateString(effectiveTo);
    cursor = addDays(cursor, 1)
  ) {
    const dateStr = formatDate(cursor);
    if (rrule.freq === "DAILY") {
      includeDate(dateStr);
      if (dates.length >= options.maxOccurrences) {
        break;
      }
      occurrences += 1;
      if (rrule.count && occurrences >= maxCount) {
        break;
      }
    } else if (rrule.freq === "WEEKLY") {
      const dayCode = dayCodeFromDate(cursor);
      if (targetByday.includes(dayCode)) {
        includeDate(dateStr);
        if (dates.length >= options.maxOccurrences) {
          break;
        }
        occurrences += 1;
        if (rrule.count && occurrences >= maxCount) {
          break;
        }
      }
    }
  }

  return { dates, dateNotes };
}

function dayCodeFromDate(date: Date): string {
  const mapping = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return mapping[date.getDay()];
}

export function parseIcsToDates(
  icsText: string,
  options: IcsParseOptions = {}
): IcsPreviewResult {
  const maxOccurrences = options.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const maxRangeDays = options.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;

  const lines = unfoldLines(icsText);
  const { events, calendarTitle, warnings } = parseEvents(lines);

  if (events.length === 0) {
    throw new IcsParseError("ICS에 이벤트가 없습니다.", 400);
  }

  const normalizedOptions: Required<IcsParseOptions> = {
    from: options.from,
    to: options.to,
    includePast: options.includePast ?? false,
    maxOccurrences,
    maxRangeDays,
  };

  const datesSet = new Set<string>();
  const dateNotes: Record<string, string> = {};
  for (const event of events) {
    const { dates, dateNotes: notes } = expandEventDates(event, normalizedOptions);
    for (const date of dates) {
      datesSet.add(date);
      if (notes[date] && !dateNotes[date]) {
        dateNotes[date] = notes[date];
      }
    }
    if (datesSet.size > maxOccurrences) {
      throw new IcsParseError(
        `생성 가능한 날짜가 ${maxOccurrences}건을 초과합니다. 범위를 줄여주세요.`,
        422
      );
    }
  }

  const expandedDates = Array.from(datesSet).sort();
  return {
    calendarTitle,
    eventsParsed: events.length,
    expandedDates,
    dateNotes,
    warnings,
  };
}

export function isIcsParseError(error: unknown): error is IcsParseError {
  return error instanceof IcsParseError;
}
