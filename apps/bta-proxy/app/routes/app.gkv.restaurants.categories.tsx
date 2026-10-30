import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData, useLocation, useNavigate } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";

type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  updatedAt: string;
};

type LoaderData = {
  items: CategoryItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  id?: string;
  message?: string;
};

type RowDraft = {
  name: string;
  slug: string;
  sortOrder: string;
  isActive: boolean;
};

type PendingAction = {
  resolve: (value: ActionData) => void;
  reject: (reason: unknown) => void;
  started: boolean;
};

function parseBool(value: FormDataEntryValue | null) {
  return String(value || "").toLowerCase() === "true";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toDraft(item: CategoryItem): RowDraft {
  return {
    name: item.name,
    slug: item.slug,
    sortOrder: String(item.sortOrder),
    isActive: item.isActive,
  };
}

function sortItems(items: CategoryItem[]): CategoryItem[] {
  return items.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function upsertItemById(items: CategoryItem[], next: CategoryItem): CategoryItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) {
    return items.concat(next);
  }
  const cloned = items.slice();
  cloned[index] = { ...cloned[index], ...next };
  return cloned;
}

function normalizeError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: string }).message;
    if (message) {
      return message;
    }
  }
  return "요청 처리에 실패했습니다.";
}

function parseSortOrder(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const data = await callGkvAdminApi<{ items: CategoryItem[] }>(
      request,
      "/admin/restaurants/categories?includeInactive=true",
    );
    return json<LoaderData>({ items: data.items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "카테고리 목록을 불러오지 못했습니다.";
    return json<LoaderData>({ items: [], error: message });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const id = String(formData.get("id") || "");

    if (intent === "create") {
      const created = await callGkvAdminApi<{ id: string }>(
        request,
        "/admin/restaurants/categories",
        {
          method: "POST",
          body: JSON.stringify({
            name: String(formData.get("name") || ""),
            slug: String(formData.get("slug") || "") || undefined,
            sortOrder: Number(formData.get("sortOrder") || 0),
            isActive: parseBool(formData.get("isActive")),
          }),
        },
      );
      return json<ActionData>({ ok: true, id: created.id, message: "카테고리를 생성했습니다." });
    }

    if (!id) {
      return json<ActionData>({ ok: false, message: "id가 필요합니다." }, { status: 400 });
    }

    if (intent === "update") {
      await callGkvAdminApi<{ id: string }>(request, `/admin/restaurants/categories/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: String(formData.get("name") || ""),
          slug: String(formData.get("slug") || "") || undefined,
          sortOrder: Number(formData.get("sortOrder") || 0),
          isActive: parseBool(formData.get("isActive")),
        }),
      });
      return json<ActionData>({ ok: true, id, message: "카테고리를 수정했습니다." });
    }

    if (intent === "delete") {
      await callGkvAdminApi<{ id: string }>(request, `/admin/restaurants/categories/${id}`, {
        method: "DELETE",
      });
      return json<ActionData>({ ok: true, id, message: "카테고리를 삭제했습니다." });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }
    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

export default function GkvRestaurantCategoriesPage() {
  const { items, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const navigate = useNavigate();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);

  const pendingActionRef = useRef<PendingAction | null>(null);

  useEffect(() => {
    if (!pendingActionRef.current) {
      return;
    }

    const pending = pendingActionRef.current;
    if (!pending.started) {
      if (fetcher.state === "idle") {
        return;
      }
      pending.started = true;
      return;
    }

    if (fetcher.state !== "idle") {
      return;
    }

    pendingActionRef.current = null;

    const data = fetcher.data;
    if (!data) {
      pending.reject({ message: "요청 응답이 비어 있습니다." });
      return;
    }

    if (!data.ok) {
      pending.reject({ message: data.message ?? "요청 처리에 실패했습니다." });
      return;
    }

    pending.resolve(data);
  }, [fetcher.data, fetcher.state]);

  useEffect(() => {
    return () => {
      if (pendingActionRef.current) {
        pendingActionRef.current.reject({ message: "요청이 취소되었습니다." });
        pendingActionRef.current = null;
      }
    };
  }, []);

  const postAction = useCallback(
    (formData: FormData) => {
      if (pendingActionRef.current) {
        return Promise.reject({ message: "이전 요청이 아직 처리 중입니다." });
      }

      return new Promise<ActionData>((resolve, reject) => {
        pendingActionRef.current = { resolve, reject, started: false };
        fetcher.submit(formData, {
          method: "post",
          encType: "multipart/form-data",
        });
      });
    },
    [fetcher],
  );

  const [categoryList, setCategoryList] = useState<CategoryItem[]>(() => sortItems(items));
  const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>(() =>
    Object.fromEntries(items.map((item) => [item.id, toDraft(item)])),
  );
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newSortOrder, setNewSortOrder] = useState("0");
  const [newIsActive, setNewIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "critical"; message: string } | null>(
    null,
  );

  useEffect(() => {
    setCategoryList(sortItems(items));
  }, [items]);

  useEffect(() => {
    setRowDrafts((prev) => {
      const next: Record<string, RowDraft> = {};
      for (const item of categoryList) {
        next[item.id] = prev[item.id] ?? toDraft(item);
      }
      return next;
    });
  }, [categoryList]);

  const sortedList = useMemo(() => sortItems(categoryList), [categoryList]);

  function updateDraft(id: string, patch: Partial<RowDraft>) {
    const currentItem = categoryList.find((item) => item.id === id);
    setRowDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ??
          (currentItem
            ? toDraft(currentItem)
            : { name: "", slug: "", sortOrder: "0", isActive: true })),
        ...patch,
      },
    }));
  }

  async function handleCreate() {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      setBanner({ tone: "critical", message: "이름을 입력해 주세요." });
      return;
    }

    const sortOrder = parseSortOrder(newSortOrder);
    if (sortOrder === null) {
      setBanner({ tone: "critical", message: "Sort Order는 0 이상의 정수여야 합니다." });
      return;
    }

    try {
      setBusy(true);
      const normalizedSlug = newSlug.trim() || slugify(trimmedName);
      const fd = new FormData();
      fd.set("intent", "create");
      fd.set("name", trimmedName);
      fd.set("slug", normalizedSlug);
      fd.set("sortOrder", String(sortOrder));
      fd.set("isActive", String(newIsActive));

      const result = await postAction(fd);
      const createdItem: CategoryItem = {
        id: result.id ?? `tmp_${Date.now()}`,
        name: trimmedName,
        slug: normalizedSlug,
        sortOrder,
        isActive: newIsActive,
        updatedAt: new Date().toISOString(),
      };

      setCategoryList((prev) => sortItems(upsertItemById(prev, createdItem)));
      setRowDrafts((prev) => ({
        ...prev,
        [createdItem.id]: toDraft(createdItem),
      }));
      setNewName("");
      setNewSlug("");
      setNewSortOrder("0");
      setNewIsActive(true);
      setBanner({ tone: "success", message: result.message ?? "카테고리를 생성했습니다." });
    } catch (error) {
      setBanner({ tone: "critical", message: normalizeError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(item: CategoryItem) {
    const draft = rowDrafts[item.id] ?? toDraft(item);
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      setBanner({ tone: "critical", message: "이름을 입력해 주세요." });
      return;
    }

    const sortOrder = parseSortOrder(draft.sortOrder);
    if (sortOrder === null) {
      setBanner({ tone: "critical", message: "Sort 값은 0 이상의 정수여야 합니다." });
      return;
    }

    const normalizedSlug = draft.slug.trim() || slugify(trimmedName);

    try {
      setBusy(true);
      const fd = new FormData();
      fd.set("intent", "update");
      fd.set("id", item.id);
      fd.set("name", trimmedName);
      fd.set("slug", normalizedSlug);
      fd.set("sortOrder", String(sortOrder));
      fd.set("isActive", String(draft.isActive));

      const result = await postAction(fd);
      const nextItem: CategoryItem = {
        ...item,
        name: trimmedName,
        slug: normalizedSlug,
        sortOrder,
        isActive: draft.isActive,
        updatedAt: new Date().toISOString(),
      };

      setCategoryList((prev) =>
        sortItems(prev.map((entry) => (entry.id === item.id ? nextItem : entry))),
      );
      setRowDrafts((prev) => ({ ...prev, [item.id]: toDraft(nextItem) }));
      setBanner({ tone: "success", message: result.message ?? "카테고리를 수정했습니다." });
    } catch (error) {
      setBanner({ tone: "critical", message: normalizeError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(item: CategoryItem) {
    if (!window.confirm(`\"${item.name}\" 카테고리를 삭제하시겠습니까?`)) {
      return;
    }

    try {
      setBusy(true);
      const fd = new FormData();
      fd.set("intent", "delete");
      fd.set("id", item.id);
      const result = await postAction(fd);

      setCategoryList((prev) => prev.filter((entry) => entry.id !== item.id));
      setRowDrafts((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setBanner({ tone: "success", message: result.message ?? "카테고리를 삭제했습니다." });
    } catch (error) {
      setBanner({ tone: "critical", message: normalizeError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(item: CategoryItem, direction: "up" | "down") {
    const current = sortItems(categoryList);
    const index = current.findIndex((entry) => entry.id === item.id);
    if (index < 0) {
      return;
    }

    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= current.length) {
      return;
    }

    const reordered = current.slice();
    const [moved] = reordered.splice(index, 1);
    reordered.splice(swapIndex, 0, moved);

    const desiredOrders = reordered.map((entry, nextIndex) => ({
      id: entry.id,
      sortOrder: nextIndex * 10,
    }));

    const changed = desiredOrders.filter(({ id, sortOrder }) => {
      const original = current.find((entry) => entry.id === id);
      return (original?.sortOrder ?? 0) !== sortOrder;
    });

    if (changed.length === 0) {
      return;
    }

    try {
      setBusy(true);
      for (const change of changed) {
        const target = current.find((entry) => entry.id === change.id);
        if (!target) {
          continue;
        }
        const draft = rowDrafts[target.id] ?? toDraft(target);

        const fd = new FormData();
        fd.set("intent", "update");
        fd.set("id", target.id);
        fd.set("name", draft.name.trim() || target.name);
        fd.set("slug", draft.slug.trim() || slugify(draft.name.trim() || target.name));
        fd.set("sortOrder", String(change.sortOrder));
        fd.set("isActive", String(draft.isActive));
        await postAction(fd);
      }

      setCategoryList((prev) =>
        sortItems(
          prev.map((entry) => {
            const match = changed.find((changedItem) => changedItem.id === entry.id);
            if (!match) {
              return entry;
            }
            return {
              ...entry,
              sortOrder: match.sortOrder,
              updatedAt: new Date().toISOString(),
            };
          }),
        ),
      );

      setRowDrafts((prev) => {
        const next = { ...prev };
        for (const change of changed) {
          const currentDraft = next[change.id];
          if (!currentDraft) {
            continue;
          }
          next[change.id] = {
            ...currentDraft,
            sortOrder: String(change.sortOrder),
          };
        }
        return next;
      });

      setBanner({ tone: "success", message: "카테고리 정렬을 변경했습니다." });
    } catch (error) {
      setBanner({ tone: "critical", message: normalizeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <TitleBar title="Restaurant Categories" />
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <Text as="h1" variant="headingLg">
            Restaurant Categories
          </Text>
          <Button onClick={() => navigate(toInApp("/app/gkv/restaurants"))}>Back</Button>
        </InlineStack>

        {banner ? (
          <Banner tone={banner.tone}>
            <p>{banner.message}</p>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              New Category
            </Text>
            <BlockStack gap="200">
              <TextField
                label="Name"
                autoComplete="off"
                value={newName}
                onChange={setNewName}
                disabled={busy}
                requiredIndicator
              />
              <TextField
                label="Slug"
                autoComplete="off"
                value={newSlug}
                onChange={setNewSlug}
                disabled={busy}
              />
              <TextField
                label="Sort Order"
                type="number"
                autoComplete="off"
                value={newSortOrder}
                onChange={setNewSortOrder}
                disabled={busy}
              />
              <Select
                label="Is Active"
                options={[
                  { label: "ACTIVE", value: "true" },
                  { label: "INACTIVE", value: "false" },
                ]}
                value={String(newIsActive)}
                onChange={(value) => setNewIsActive(value === "true")}
                disabled={busy}
              />
              <Button variant="primary" onClick={handleCreate} loading={busy} disabled={busy}>
                Create
              </Button>
            </BlockStack>
          </BlockStack>
        </Card>

        <BlockStack gap="300">
          {sortedList.map((item, index) => {
            const draft = rowDrafts[item.id] ?? toDraft(item);
            return (
              <Card key={item.id}>
                <BlockStack gap="200">
                  <InlineStack gap="200" wrap={false}>
                    <div style={{ flex: 2 }}>
                      <TextField
                        label="Name"
                        autoComplete="off"
                        value={draft.name}
                        onChange={(value) => updateDraft(item.id, { name: value })}
                        disabled={busy}
                      />
                    </div>
                    <div style={{ flex: 2 }}>
                      <TextField
                        label="Slug"
                        autoComplete="off"
                        value={draft.slug}
                        onChange={(value) => updateDraft(item.id, { slug: value })}
                        disabled={busy}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Sort"
                        type="number"
                        autoComplete="off"
                        value={draft.sortOrder}
                        onChange={(value) => updateDraft(item.id, { sortOrder: value })}
                        disabled={busy}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Select
                        label="Active"
                        options={[
                          { label: "ACTIVE", value: "true" },
                          { label: "INACTIVE", value: "false" },
                        ]}
                        value={String(draft.isActive)}
                        onChange={(value) => updateDraft(item.id, { isActive: value === "true" })}
                        disabled={busy}
                      />
                    </div>
                  </InlineStack>

                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Updated: {new Date(item.updatedAt).toLocaleString()}
                    </Text>
                    <InlineStack gap="200">
                      <Button
                        size="micro"
                        onClick={() => handleMove(item, "up")}
                        disabled={busy || index === 0}
                      >
                        Up
                      </Button>
                      <Button
                        size="micro"
                        onClick={() => handleMove(item, "down")}
                        disabled={busy || index === sortedList.length - 1}
                      >
                        Down
                      </Button>
                      <Button size="micro" onClick={() => handleSave(item)} disabled={busy}>
                        Save
                      </Button>
                      <Button
                        size="micro"
                        tone="critical"
                        onClick={() => handleDelete(item)}
                        disabled={busy}
                      >
                        Delete
                      </Button>
                    </InlineStack>
                  </InlineStack>
                </BlockStack>
              </Card>
            );
          })}
        </BlockStack>

        {error ? (
          <Card>
            <Box padding="300">
              <Text as="p" variant="bodyMd" tone="critical">
                {error}
              </Text>
            </Box>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
