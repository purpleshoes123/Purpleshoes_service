import { useEffect, useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData } from "react-router";
import {
  BlockStack,
  Box,
  Badge,
  Button,
  Card,
  DataTable,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { listGlobalBlackouts } from "~/lib/shopifyAdmin";

type GlobalBlackoutItem = {
  id: string;
  date: string;
  note?: string;
  source: "manual" | "ics";
};

type LoaderData = {
  month: string;
  from: string;
  to: string;
  dates: string[];
  items: GlobalBlackoutItem[];
  error?: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseMonth(value: string | null): { year: number; month: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function getMonthRange(year: number, month: number): {
  from: string;
  to: string;
  daysInMonth: number;
  firstWeekday: number;
} {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  return {
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(daysInMonth)}`,
    daysInMonth,
    firstWeekday,
  };
}

function shiftMonth(year: number, month: number, delta: number): {
  year: number;
  month: number;
} {
  let nextYear = year;
  let nextMonth = month + delta;
  while (nextMonth < 1) {
    nextMonth += 12;
    nextYear -= 1;
  }
  while (nextMonth > 12) {
    nextMonth -= 12;
    nextYear += 1;
  }
  return { year: nextYear, month: nextMonth };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const url = new URL(request.url);
  const monthParam = parseMonth(url.searchParams.get("month"));
  const now = new Date();
  const year = monthParam?.year ?? now.getFullYear();
  const month = monthParam?.month ?? now.getMonth() + 1;
  const range = getMonthRange(year, month);

  let result: { dates: string[] } = { dates: [] };
  let items: GlobalBlackoutItem[] = [];
  let error: string | undefined;
  try {
    const response = await listGlobalBlackouts({
      admin: auth.admin,
      shop: auth.session.shop,
      from: range.from,
      to: range.to,
    });
    result = { dates: response.dates };
    items = response.items;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error =
      message.includes("Access denied for metaobjects")
        ? "Metaobject 권한이 없습니다. 앱 권한에 read_metaobjects/write_metaobjects가 포함되어 있는지 확인하세요."
        : "Metaobject 조회에 실패했습니다. metaobject 정의와 권한을 확인하세요.";
  }

  return json<LoaderData>({
    month: formatMonth(year, month),
    from: range.from,
    to: range.to,
    dates: result.dates,
    items,
    ...(error ? { error } : {}),
  });
};

export default function GlobalBlackoutPage() {
  const loaderData = useLoaderData<LoaderData>();
  const listFetcher = useFetcher<any>();
  const toggleFetcher = useFetcher<any>();
  const createFetcher = useFetcher<any>();
  const updateFetcher = useFetcher<any>();
  const deleteFetcher = useFetcher<any>();
  const previewFetcher = useFetcher<any>();
  const applyFetcher = useFetcher<any>();

  const initialMonth = parseMonth(loaderData.month) || {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
  };
  const today = useMemo(() => new Date(), []);

  const [currentYear, setCurrentYear] = useState(initialMonth.year);
  const [currentMonth, setCurrentMonth] = useState(initialMonth.month);
  const [blackoutDates, setBlackoutDates] = useState<string[]>(loaderData.dates);
  const [blackoutItems, setBlackoutItems] = useState<GlobalBlackoutItem[]>(
    loaderData.items || []
  );
  const [rangeMode, setRangeMode] = useState<"month" | "next90">("month");
  const [searchTerm, setSearchTerm] = useState("");
  const [createDate, setCreateDate] = useState("");
  const [createNote, setCreateNote] = useState("");
  const [editTarget, setEditTarget] = useState<GlobalBlackoutItem | null>(null);
  const [editNote, setEditNote] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<GlobalBlackoutItem | null>(null);
  const [icsFile, setIcsFile] = useState<File | null>(null);
  const [icsPreview, setIcsPreview] = useState<any | null>(null);
  const [icsWarnings, setIcsWarnings] = useState<string[]>([]);
  const [icsConfirmOpen, setIcsConfirmOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    loaderData.error || null
  );
  const [optimisticBackup, setOptimisticBackup] = useState<string[] | null>(null);

  const range = getMonthRange(currentYear, currentMonth);
  const listRange = useMemo(() => {
    if (rangeMode === "next90") {
      return {
        from: formatDate(today),
        to: formatDate(addDays(today, 89)),
      };
    }
    return { from: range.from, to: range.to };
  }, [range.from, range.to, rangeMode, today]);
  const blackoutSet = useMemo(() => new Set(blackoutDates), [blackoutDates]);
  const weekLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const items = blackoutItems.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!term) {
      return items;
    }
    return items.filter((item) => {
      const note = item.note?.toLowerCase() || "";
      return item.date.includes(term) || note.includes(term);
    });
  }, [blackoutItems, searchTerm]);

  const refreshList = () => {
    listFetcher.load(
      `/proxy/internal/admin/blackouts?from=${listRange.from}&to=${listRange.to}`
    );
  };

  useEffect(() => {
    refreshList();
  }, [listRange.from, listRange.to]);

  useEffect(() => {
    if (!listFetcher.data || !("ok" in listFetcher.data)) {
      return;
    }
    const payload = listFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "Failed to load blackouts.");
      return;
    }
    const dates = payload.data?.dates || [];
    const items = payload.data?.items || [];
    setBlackoutDates(dates);
    setBlackoutItems(items);
  }, [listFetcher.data]);

  useEffect(() => {
    if (!toggleFetcher.data || !("ok" in toggleFetcher.data)) {
      return;
    }
    const payload = toggleFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "Failed to toggle blackout.");
      if (optimisticBackup) {
        setBlackoutDates(optimisticBackup);
        setOptimisticBackup(null);
      }
      return;
    }
    setOptimisticBackup(null);
    const action = payload.data?.action;
    const date = payload.data?.date;
    const item = payload.data?.item;
    if (!date) {
      return;
    }
    setBlackoutDates((prev) => {
      const next = new Set(prev);
      if (action === "created") {
        next.add(date);
      } else if (action === "deleted") {
        next.delete(date);
      }
      return Array.from(next).sort();
    });
    setBlackoutItems((prev) => {
      if (action === "created" && item) {
        const next = prev.filter((existing) => existing.date !== date);
        next.push(item);
        return next.sort((a, b) => a.date.localeCompare(b.date));
      }
      if (action === "deleted") {
        return prev.filter((existing) => existing.date !== date);
      }
      return prev;
    });
  }, [toggleFetcher.data]);

  useEffect(() => {
    if (!createFetcher.data || !("ok" in createFetcher.data)) {
      return;
    }
    const payload = createFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "Failed to create blackout.");
      return;
    }
    setCreateDate("");
    setCreateNote("");
    refreshList();
  }, [createFetcher.data]);

  useEffect(() => {
    if (!updateFetcher.data || !("ok" in updateFetcher.data)) {
      return;
    }
    const payload = updateFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "Failed to update blackout.");
      return;
    }
    setEditTarget(null);
    setEditNote("");
    refreshList();
  }, [updateFetcher.data]);

  useEffect(() => {
    if (!deleteFetcher.data || !("ok" in deleteFetcher.data)) {
      return;
    }
    const payload = deleteFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "Failed to delete blackout.");
      return;
    }
    setDeleteTarget(null);
    refreshList();
  }, [deleteFetcher.data]);

  useEffect(() => {
    if (!previewFetcher.data || !("ok" in previewFetcher.data)) {
      return;
    }
    const payload = previewFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "ICS 미리보기에 실패했습니다.");
      return;
    }
    setIcsPreview(payload.data);
    setIcsWarnings(payload.data?.warnings || []);
  }, [previewFetcher.data]);

  useEffect(() => {
    if (!applyFetcher.data || !("ok" in applyFetcher.data)) {
      return;
    }
    const payload = applyFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "ICS 적용에 실패했습니다.");
      return;
    }
    setIcsConfirmOpen(false);
    setIcsPreview(null);
    setIcsWarnings([]);
    setIcsFile(null);
    refreshList();
  }, [applyFetcher.data]);

  const calendarCells: Array<{ date: string | null; day: number | null }> = [];
  for (let i = 0; i < range.firstWeekday; i += 1) {
    calendarCells.push({ date: null, day: null });
  }
  for (let day = 1; day <= range.daysInMonth; day += 1) {
    calendarCells.push({
      date: `${currentYear}-${pad2(currentMonth)}-${pad2(day)}`,
      day,
    });
  }
  while (calendarCells.length % 7 !== 0) {
    calendarCells.push({ date: null, day: null });
  }

  const handleMonthChange = (delta: number) => {
    const next = shiftMonth(currentYear, currentMonth, delta);
    setCurrentYear(next.year);
    setCurrentMonth(next.month);
    setErrorMessage(null);
    if (rangeMode === "month") {
      const nextRange = getMonthRange(next.year, next.month);
      listFetcher.load(
        `/proxy/internal/admin/blackouts?from=${nextRange.from}&to=${nextRange.to}`
      );
    }
  };

  const handleToggle = (date: string) => {
    if (toggleFetcher.state !== "idle") {
      return;
    }
    setErrorMessage(null);
    setOptimisticBackup(blackoutDates);
    setBlackoutDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return Array.from(next).sort();
    });
    toggleFetcher.submit(JSON.stringify({ date }), {
      method: "post",
      encType: "application/json",
      action: "/proxy/internal/admin/blackouts/toggle",
    });
  };

  return (
    <Page>
      <TitleBar title="Global Blackout" />
      <BlockStack gap="500">
        {errorMessage ? (
          <Banner tone="critical" title="Request failed">
            <p>{errorMessage}</p>
          </Banner>
        ) : null}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              블랙아웃 목록
            </Text>
            <InlineStack gap="300" align="space-between" blockAlign="center">
              <InlineStack gap="300" blockAlign="center">
                <Select
                  label="범위"
                  options={[
                    { label: "현재 달", value: "month" },
                    { label: "다음 90일", value: "next90" },
                  ]}
                  value={rangeMode}
                  onChange={(value) => {
                    setRangeMode(value as "month" | "next90");
                    setErrorMessage(null);
                  }}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  표시 범위: {listRange.from} ~ {listRange.to}
                </Text>
              </InlineStack>
              <TextField
                label="검색"
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder="YYYY-MM-DD 또는 메모"
                autoComplete="off"
              />
            </InlineStack>
            <InlineStack gap="300">
              <TextField
                label="날짜"
                type="date"
                value={createDate}
                onChange={setCreateDate}
                autoComplete="off"
              />
              <TextField
                label="메모(선택)"
                value={createNote}
                onChange={setCreateNote}
                placeholder="사유/참고"
                autoComplete="off"
              />
              <Button
                variant="primary"
                onClick={() => {
                  if (!createDate) {
                    setErrorMessage("날짜를 입력해주세요.");
                    return;
                  }
                  createFetcher.submit(
                    JSON.stringify({ date: createDate, note: createNote || undefined }),
                    {
                      method: "post",
                      encType: "application/json",
                      action: "/proxy/internal/admin/blackouts",
                    }
                  );
                }}
                loading={createFetcher.state !== "idle"}
              >
                추가
              </Button>
            </InlineStack>
            {filteredItems.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                표시할 블랙아웃이 없습니다.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["날짜", "메모", "Source", "작업"]}
                rows={filteredItems.map((item) => [
                  item.date,
                  item.note || "-",
                  item.source,
                  <InlineStack key={item.id} gap="100">
                    <Button
                      size="micro"
                      onClick={() => {
                        setEditTarget(item);
                        setEditNote(item.note || "");
                      }}
                    >
                      메모 편집
                    </Button>
                    <Button
                      size="micro"
                      tone="critical"
                      onClick={() => setDeleteTarget(item)}
                    >
                      삭제
                    </Button>
                  </InlineStack>,
                ])}
              />
            )}
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              ICS 가져오기
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Google 캘린더 내보내기(ICS)를 업로드하면 전역 블랙아웃으로
              변환합니다. 과거 날짜는 기본 제외됩니다.
            </Text>
            <input
              type="file"
              accept=".ics,text/calendar"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                setIcsFile(file);
                setIcsPreview(null);
                setIcsWarnings([]);
              }}
            />
            <InlineStack gap="200">
              <Button
                onClick={() => {
                  if (!icsFile) {
                    setErrorMessage("ICS 파일을 선택해주세요.");
                    return;
                  }
                  const formData = new FormData();
                  formData.append("file", icsFile);
                  previewFetcher.submit(formData, {
                    method: "post",
                    action: "/proxy/internal/admin/blackouts/ics/preview",
                    encType: "multipart/form-data",
                  });
                }}
                loading={previewFetcher.state !== "idle"}
              >
                미리보기
              </Button>
              <Button
                variant="primary"
                disabled={!icsPreview?.toCreateDates?.length}
                onClick={() => setIcsConfirmOpen(true)}
                loading={applyFetcher.state !== "idle"}
              >
                가져오기 적용
              </Button>
            </InlineStack>
            {icsPreview ? (
              <BlockStack gap="300">
                <Text as="p" variant="bodySm">
                  이벤트 {icsPreview.stats?.eventsParsed ?? 0}건, 확장{" "}
                  {icsPreview.stats?.datesExpanded ?? 0}일, 신규{" "}
                  {icsPreview.stats?.datesNew ?? 0}일, 기존{" "}
                  {icsPreview.stats?.datesExisting ?? 0}일
                </Text>
                {icsWarnings.length > 0 ? (
                  <Banner tone="warning" title="주의 사항">
                    <ul>
                      {icsWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}
                <Text as="p" variant="bodySm" tone="subdued">
                  신규 날짜(최대 50건 표시)
                </Text>
                <Box>
                  <div style={{ maxHeight: "160px", overflow: "auto" }}>
                    <ul style={{ margin: 0, paddingLeft: "18px" }}>
                      {(icsPreview.toCreateDates || []).slice(0, 50).map((date: string) => (
                        <li key={date}>{date}</li>
                      ))}
                    </ul>
                  </div>
                </Box>
                <Text as="p" variant="bodySm" tone="subdued">
                  기존 날짜(최대 50건 표시)
                </Text>
                <Box>
                  <div style={{ maxHeight: "160px", overflow: "auto" }}>
                    <ul style={{ margin: 0, paddingLeft: "18px" }}>
                      {(icsPreview.existingDates || [])
                        .slice(0, 50)
                        .map((date: string) => (
                          <li key={date}>{date}</li>
                        ))}
                    </ul>
                  </div>
                </Box>
              </BlockStack>
            ) : null}
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <InlineStack gap="200" align="center">
                <Button onClick={() => handleMonthChange(-1)}>&lt;</Button>
                <Text as="h2" variant="headingMd">
                  {formatMonth(currentYear, currentMonth)}
                </Text>
                <Button onClick={() => handleMonthChange(1)}>&gt;</Button>
              </InlineStack>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="critical">Global blackout</Badge>
                <Text as="p" variant="bodyMd">
                  날짜를 클릭하면 전역 블랙아웃이 토글됩니다.
                </Text>
              </InlineStack>
            </InlineStack>
            <Box>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                  gap: "6px",
                }}
              >
                {weekLabels.map((label) => (
                  <div key={label} style={{ textAlign: "center", fontWeight: 600 }}>
                    {label}
                  </div>
                ))}
                {calendarCells.map((cell, index) => {
                  const isBlackout = cell.date ? blackoutSet.has(cell.date) : false;
                  const isDisabled = cell.date === null;
                  return (
                    <button
                      key={`${cell.date || "empty"}-${index}`}
                      type="button"
                      onClick={() => cell.date && handleToggle(cell.date)}
                      disabled={isDisabled || toggleFetcher.state !== "idle"}
                      style={{
                        minHeight: "36px",
                        border: "1px solid #dfe3e8",
                        borderRadius: "6px",
                        background: isBlackout ? "#ffe2e5" : "#ffffff",
                        color: isBlackout ? "#8a0b18" : "#202223",
                        cursor: isDisabled ? "default" : "pointer",
                        opacity: isDisabled ? 0.4 : 1,
                      }}
                    >
                      {cell.day ?? ""}
                    </button>
                  );
                })}
              </div>
            </Box>
          </BlockStack>
        </Card>
      </BlockStack>
      <Modal
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        title="메모 편집"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="메모"
              value={editNote}
              onChange={setEditNote}
              autoComplete="off"
            />
            <InlineStack gap="200">
              <Button onClick={() => setEditTarget(null)}>취소</Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (!editTarget) return;
                  updateFetcher.submit(
                    JSON.stringify({ note: editNote }),
                    {
                      method: "patch",
                      encType: "application/json",
                      action: `/proxy/internal/admin/blackouts/${encodeURIComponent(
                        editTarget.id
                      )}`,
                    }
                  );
                }}
                loading={updateFetcher.state !== "idle"}
              >
                저장
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
      <Modal
        open={icsConfirmOpen}
        onClose={() => setIcsConfirmOpen(false)}
        title="ICS 가져오기 적용"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm">
              미리보기에서 신규로 표시된 날짜를 전역 블랙아웃으로
              등록합니다. 계속할까요?
            </Text>
            <InlineStack gap="200">
              <Button onClick={() => setIcsConfirmOpen(false)}>취소</Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (!icsPreview?.toCreateDates?.length) {
                    setIcsConfirmOpen(false);
                    return;
                  }
                  applyFetcher.submit(
                    JSON.stringify({
                      dates: icsPreview.toCreateDates,
                      calendarTitle: icsPreview.calendarTitle || undefined,
                      dateNotes: icsPreview.dateNotes || undefined,
                    }),
                    {
                      method: "post",
                      encType: "application/json",
                      action: "/proxy/internal/admin/blackouts/ics/apply",
                    }
                  );
                }}
                loading={applyFetcher.state !== "idle"}
              >
                적용
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="블랙아웃 삭제"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm">
              {deleteTarget?.date} 블랙아웃을 삭제할까요?
            </Text>
            <InlineStack gap="200">
              <Button onClick={() => setDeleteTarget(null)}>취소</Button>
              <Button
                tone="critical"
                onClick={() => {
                  if (!deleteTarget) return;
                  deleteFetcher.submit(null, {
                    method: "delete",
                    action: `/proxy/internal/admin/blackouts/${encodeURIComponent(
                      deleteTarget.id
                    )}`,
                  });
                }}
                loading={deleteFetcher.state !== "idle"}
              >
                삭제
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
