import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";

type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  depth: 1 | 2 | 3;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  exposeAsGuide: boolean;
  pdfAssetCount: number;
  videoAssetCount: number;
};

type LoaderData = {
  items: CategoryItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const data = await callGkvAdminApi<{ items: CategoryItem[] }>(request, "/admin/gkv/categories");
    return json<LoaderData>({ items: data.items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "카테고리를 불러오지 못했습니다.";
    return json<LoaderData>({ items: [], error: message });
  }
};

function parseBool(value: FormDataEntryValue | null): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

function parseIntSafe(value: FormDataEntryValue | null, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const id = String(formData.get("id") || "");

    if (intent === "create") {
      const parentIdRaw = String(formData.get("parentId") || "");
      const parentId = parentIdRaw.length > 0 ? parentIdRaw : null;
      const depth = parseIntSafe(formData.get("depth"), 1);
      await callGkvAdminApi<{ id: string }>(request, "/admin/gkv/categories", {
        method: "POST",
        body: JSON.stringify({
          name: String(formData.get("name") || ""),
          slug: String(formData.get("slug") || ""),
          depth,
          parentId,
          sortOrder: parseIntSafe(formData.get("sortOrder"), 0),
          isActive: parseBool(formData.get("isActive")),
          exposeAsGuide: parseBool(formData.get("exposeAsGuide")),
        }),
      });
      return json<ActionData>({ ok: true, message: "카테고리를 생성했습니다." });
    }

    if (!id) {
      return json<ActionData>({ ok: false, message: "id가 필요합니다." }, { status: 400 });
    }

    if (intent === "delete") {
      await callGkvAdminApi<{ id: string; deleted: boolean }>(
        request,
        `/admin/gkv/categories/${id}`,
        { method: "DELETE" },
      );
      return json<ActionData>({ ok: true, message: "카테고리를 삭제했습니다." });
    }

    if (intent === "toggle-active") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/categories/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({ isActive: parseBool(formData.get("nextActive")) }),
        },
      );
      return json<ActionData>({ ok: true, message: "활성 상태를 변경했습니다." });
    }

    if (intent === "toggle-expose") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/categories/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({ exposeAsGuide: parseBool(formData.get("nextExpose")) }),
        },
      );
      return json<ActionData>({ ok: true, message: "Expose as Guide 설정을 변경했습니다." });
    }

    if (intent === "rename") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/categories/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: String(formData.get("name") || ""),
            slug: String(formData.get("slug") || ""),
          }),
        },
      );
      return json<ActionData>({ ok: true, message: "이름/Slug를 변경했습니다." });
    }

    if (intent === "reparent") {
      const parentIdRaw = String(formData.get("parentId") || "");
      const parentId = parentIdRaw.length > 0 ? parentIdRaw : null;
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/categories/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({ parentId }),
        },
      );
      return json<ActionData>({ ok: true, message: "상위 카테고리를 변경했습니다." });
    }

    if (intent === "move-up" || intent === "move-down") {
      const direction = intent === "move-up" ? "up" : "down";
      await callGkvAdminApi<{ id: string; swappedWith: string | null }>(
        request,
        `/admin/gkv/categories/${id}/move`,
        {
          method: "POST",
          body: JSON.stringify({ direction }),
        },
      );
      return json<ActionData>({
        ok: true,
        message: `순서를 ${direction === "up" ? "위" : "아래"}로 이동했습니다.`,
      });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }
    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

type TreeNode = CategoryItem & { children: TreeNode[] };

function buildTree(items: CategoryItem[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const it of items) {
    byId.set(it.id, { ...it, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      const nameOrder = a.name.localeCompare(b.name);
      if (nameOrder !== 0) {
        return nameOrder;
      }
      return a.id.localeCompare(b.id);
    });
    for (const n of nodes) {
      sortNodes(n.children);
    }
  };
  sortNodes(roots);
  return roots;
}

function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length > 0) {
        walk(n.children);
      }
    }
  };
  walk(roots);
  return out;
}

function buildPathById(items: CategoryItem[]): Map<string, string> {
  const byId = new Map(items.map((c) => [c.id, c]));
  const result = new Map<string, string>();
  for (const c of items) {
    const parts: string[] = [];
    let cur: CategoryItem | undefined = c;
    let safety = 0;
    while (cur && safety < 5) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      safety += 1;
    }
    result.set(c.id, parts.join(" / "));
  }
  return result;
}

function collectDescendantIds(items: CategoryItem[], rootId: string): Set<string> {
  const childrenByParent = new Map<string | null, CategoryItem[]>();
  for (const c of items) {
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c);
    childrenByParent.set(c.parentId, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const top = stack.pop()!;
    const children = childrenByParent.get(top) ?? [];
    for (const child of children) {
      out.add(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

function buildExposeConfirmText(item: CategoryItem): string | undefined {
  const next = !item.exposeAsGuide;
  if (!next) {
    return undefined;
  }
  if (item.pdfAssetCount > 0 || item.videoAssetCount > 0) {
    return undefined;
  }
  return [
    `이 카테고리는 현재 PDF/VIDEO가 없습니다.`,
    `자산이 추가되면 자동으로 가상 가이드에 포함됩니다.`,
    `그래도 활성화하시겠습니까?`,
  ].join("\n");
}

type ParentOption = {
  id: string | null;
  label: string;
  depth: number;
  disabled?: boolean;
};

/**
 * Parent Picker 옵션 빌더.
 * - 새 부모 후보: 자기 자신/자손 제외 + 새 자식의 depth가 3을 넘는 후보 제외
 * - excludeId(자기 자신, reparent 시) 또는 movingDescendantsMaxDepth(자손 깊이 보존) 고려
 */
function buildParentOptions(
  items: CategoryItem[],
  options: {
    excludeId?: string | null;
    excludeDescendantsOf?: string | null;
    childMinDepth?: 1 | 2 | 3;
  },
): ParentOption[] {
  const { excludeId, excludeDescendantsOf, childMinDepth = 1 } = options;
  const excluded = new Set<string>();
  if (excludeId) {
    excluded.add(excludeId);
  }
  if (excludeDescendantsOf) {
    for (const d of collectDescendantIds(items, excludeDescendantsOf)) {
      excluded.add(d);
    }
  }

  const pathById = buildPathById(items);
  const result: ParentOption[] = [];
  // 최상위 후보 (parentId=null, 자식의 depth는 1)
  if (childMinDepth <= 1) {
    result.push({ id: null, label: "— 최상위 (depth=1)", depth: 0 });
  }
  for (const c of items) {
    if (excluded.has(c.id)) {
      continue;
    }
    // 자식이 될 노드의 depth = c.depth + 1
    const childDepth = c.depth + 1;
    if (childDepth > 3) {
      continue;
    }
    if (childDepth < childMinDepth) {
      continue;
    }
    const indent = "  ".repeat(c.depth - 1);
    result.push({
      id: c.id,
      label: `${indent}${pathById.get(c.id) ?? c.name} (자식 depth=${childDepth})`,
      depth: c.depth,
    });
  }
  return result;
}

export default function GkvCategoriesPage() {
  const { items, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const submitting = fetcher.state !== "idle";

  const tree = useMemo(() => buildTree(items), [items]);
  const flatVisible = useMemo(() => flattenTree(tree), [tree]);
  const pathById = useMemo(() => buildPathById(items), [items]);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    return new Set(items.filter((c) => c.depth === 1).map((c) => c.id));
  });

  // 새로 등장한 depth=1은 자동 펼침
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const c of items) {
        if (c.depth === 1 && !next.has(c.id)) {
          next.add(c.id);
        }
      }
      return next;
    });
  }, [items]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const exposedActiveCount = items.filter((c) => c.exposeAsGuide && c.isActive).length;
  const exposedEmptyCount = items.filter(
    (c) => c.exposeAsGuide && c.isActive && c.pdfAssetCount === 0 && c.videoAssetCount === 0,
  ).length;

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [createIsActive, setCreateIsActive] = useState(true);
  const [createExpose, setCreateExpose] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<CategoryItem | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameSlug, setRenameSlug] = useState("");

  const [reparentOpen, setReparentOpen] = useState(false);
  const [reparentTarget, setReparentTarget] = useState<CategoryItem | null>(null);
  const [reparentParentId, setReparentParentId] = useState<string | null>(null);

  // 액션 완료 시 모달 자동 닫기
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setCreateOpen(false);
      setRenameOpen(false);
      setReparentOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  const createParentOptions = useMemo(
    () => buildParentOptions(items, { childMinDepth: 1 }),
    [items],
  );
  const createDepthHint = useMemo(() => {
    if (!createParentId) {
      return 1;
    }
    const p = items.find((c) => c.id === createParentId);
    return p ? Math.min(3, p.depth + 1) : 1;
  }, [createParentId, items]);

  const reparentDescendantsMaxDepth = useMemo(() => {
    if (!reparentTarget) {
      return reparentTarget?.depth ?? 1;
    }
    const descendants = collectDescendantIds(items, reparentTarget.id);
    let max = reparentTarget.depth;
    for (const d of descendants) {
      const item = items.find((c) => c.id === d);
      if (item && item.depth > max) {
        max = item.depth;
      }
    }
    return max;
  }, [reparentTarget, items]);

  const reparentParentOptions = useMemo(() => {
    if (!reparentTarget) {
      return [];
    }
    return buildParentOptions(items, {
      excludeId: reparentTarget.id,
      excludeDescendantsOf: reparentTarget.id,
      childMinDepth: 1,
    }).filter((opt) => {
      // 자손 depth 보존: target 이동 시 깊이 변화량 (newDepth - oldDepth) 만큼 자손 depth가 shift됨
      const newChildDepth = opt.id ? opt.depth + 1 : 1;
      const delta = newChildDepth - reparentTarget.depth;
      return reparentDescendantsMaxDepth + delta <= 3;
    });
  }, [reparentTarget, items, reparentDescendantsMaxDepth]);

  const reparentNewDepth = useMemo(() => {
    if (!reparentTarget) {
      return 1;
    }
    if (!reparentParentId) {
      return 1;
    }
    const p = items.find((c) => c.id === reparentParentId);
    return p ? Math.min(3, p.depth + 1) : 1;
  }, [reparentParentId, reparentTarget, items]);

  const openRename = (item: CategoryItem) => {
    setRenameTarget(item);
    setRenameName(item.name);
    setRenameSlug(item.slug);
    setRenameOpen(true);
  };

  const openReparent = (item: CategoryItem) => {
    setReparentTarget(item);
    setReparentParentId(item.parentId);
    setReparentOpen(true);
  };

  const submitToggleExpose = (item: CategoryItem) => {
    const confirmText = buildExposeConfirmText(item);
    if (confirmText && !window.confirm(confirmText)) {
      return;
    }
    const fd = new FormData();
    fd.set("intent", "toggle-expose");
    fd.set("id", item.id);
    fd.set("nextExpose", String(!item.exposeAsGuide));
    fetcher.submit(fd, { method: "post" });
  };

  const submitToggleActive = (item: CategoryItem) => {
    const fd = new FormData();
    fd.set("intent", "toggle-active");
    fd.set("id", item.id);
    fd.set("nextActive", String(!item.isActive));
    fetcher.submit(fd, { method: "post" });
  };

  const submitMove = (item: CategoryItem, direction: "up" | "down") => {
    const fd = new FormData();
    fd.set("intent", direction === "up" ? "move-up" : "move-down");
    fd.set("id", item.id);
    fetcher.submit(fd, { method: "post" });
  };

  const submitDelete = (item: CategoryItem) => {
    if (!window.confirm(`"${item.name}" 카테고리를 삭제하시겠습니까?`)) {
      return;
    }
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("id", item.id);
    fetcher.submit(fd, { method: "post" });
  };

  const submitCreate = () => {
    if (!createName.trim() || !createSlug.trim()) {
      window.alert("이름과 Slug는 필수입니다.");
      return;
    }
    const depth = createDepthHint;
    const fd = new FormData();
    fd.set("intent", "create");
    fd.set("name", createName.trim());
    fd.set("slug", createSlug.trim());
    fd.set("depth", String(depth));
    if (createParentId) {
      fd.set("parentId", createParentId);
    }
    fd.set("sortOrder", "0"); // 서버에서 자동 채움(미래) 또는 0 사용. 현재는 명시 0.
    fd.set("isActive", String(createIsActive));
    fd.set("exposeAsGuide", String(createExpose));
    fetcher.submit(fd, { method: "post" });
  };

  const submitRename = () => {
    if (!renameTarget) {
      return;
    }
    if (!renameName.trim() || !renameSlug.trim()) {
      window.alert("이름과 Slug는 필수입니다.");
      return;
    }
    const fd = new FormData();
    fd.set("intent", "rename");
    fd.set("id", renameTarget.id);
    fd.set("name", renameName.trim());
    fd.set("slug", renameSlug.trim());
    fetcher.submit(fd, { method: "post" });
  };

  const submitReparent = () => {
    if (!reparentTarget) {
      return;
    }
    const fd = new FormData();
    fd.set("intent", "reparent");
    fd.set("id", reparentTarget.id);
    if (reparentParentId) {
      fd.set("parentId", reparentParentId);
    } else {
      fd.set("parentId", "");
    }
    fetcher.submit(fd, { method: "post" });
  };

  const renderRow = (node: TreeNode) => {
    const indent = (node.depth - 1) * 24;
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    const isVisible = (() => {
      // 부모가 모두 펼쳐진 경우만 렌더
      let cur = node;
      while (cur.parentId) {
        const parent = items.find((c) => c.id === cur.parentId);
        if (!parent) {
          break;
        }
        if (!expanded.has(parent.id)) {
          return false;
        }
        cur = { ...parent, children: [] } as TreeNode;
      }
      return true;
    })();

    if (!isVisible) {
      return null;
    }

    // 형제 위/아래 가능 여부
    const siblings = items
      .filter((c) => c.parentId === node.parentId && c.depth === node.depth)
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }
        const nameOrder = a.name.localeCompare(b.name);
        if (nameOrder !== 0) {
          return nameOrder;
        }
        return a.id.localeCompare(b.id);
      });
    const idx = siblings.findIndex((s) => s.id === node.id);
    const canUp = idx > 0;
    const canDown = idx >= 0 && idx < siblings.length - 1;

    return (
      <div
        key={node.id}
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 2fr) 90px 90px 90px 120px auto",
          gap: "8px",
          alignItems: "center",
          padding: "6px 8px",
          borderBottom: "1px solid #f1f1f1",
        }}
      >
        <div
          style={{ paddingLeft: `${indent}px`, display: "flex", alignItems: "center", gap: "6px" }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleExpand(node.id)}
              style={{
                width: 20,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 12,
              }}
              aria-label={isExpanded ? "접기" : "펼치기"}
            >
              {isExpanded ? "▼" : "▶"}
            </button>
          ) : (
            <span
              style={{ width: 20, display: "inline-block", textAlign: "center", color: "#bbb" }}
            >
              •
            </span>
          )}
          <Text as="span" variant="bodyMd">
            {node.name}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            ({node.slug}, sort {node.sortOrder})
          </Text>
        </div>
        <div>
          {node.isActive ? (
            <Badge tone="success">ACTIVE</Badge>
          ) : (
            <Badge tone="critical">INACTIVE</Badge>
          )}
        </div>
        <div>
          {node.exposeAsGuide ? (
            <Badge tone="info">노출 ON</Badge>
          ) : (
            <Badge tone="attention">노출 OFF</Badge>
          )}
        </div>
        <div>
          <Text as="span" variant="bodySm">
            PDF {node.pdfAssetCount} / VIDEO {node.videoAssetCount}
          </Text>
        </div>
        <div>
          <InlineStack gap="100" wrap={false}>
            <Button
              size="micro"
              disabled={!canUp || submitting}
              onClick={() => submitMove(node, "up")}
              accessibilityLabel="순서 위로"
            >
              ↑
            </Button>
            <Button
              size="micro"
              disabled={!canDown || submitting}
              onClick={() => submitMove(node, "down")}
              accessibilityLabel="순서 아래로"
            >
              ↓
            </Button>
          </InlineStack>
        </div>
        <div>
          <InlineStack gap="100" wrap={false}>
            <Button size="micro" onClick={() => openRename(node)} disabled={submitting}>
              이름
            </Button>
            <Button size="micro" onClick={() => openReparent(node)} disabled={submitting}>
              상위
            </Button>
            <Button size="micro" onClick={() => submitToggleExpose(node)} disabled={submitting}>
              {node.exposeAsGuide ? "노출 OFF" : "노출 ON"}
            </Button>
            <Button size="micro" onClick={() => submitToggleActive(node)} disabled={submitting}>
              {node.isActive ? "비활성" : "활성"}
            </Button>
            <Button
              size="micro"
              tone="critical"
              onClick={() => submitDelete(node)}
              disabled={submitting}
            >
              삭제
            </Button>
          </InlineStack>
        </div>
      </div>
    );
  };

  return (
    <Page>
      <TitleBar title="GKV Categories" />
      <BlockStack gap="400">
        <Banner tone="info" title="가이드로 노출 토글 안내">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">
              "가이드로 노출"을 켜면 해당 카테고리는 SHARED 가상
              가이드(`gkv_virtual_shared_&lt;id&gt;`)로 자동 노출됩니다.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              자산이 1개도 없는 카테고리도 정상입니다 — 자산이 추가되면 자동으로 가상 가이드에
              포함됩니다. 현재 활성+노출 카테고리는 <b>{exposedActiveCount}</b>건이고, 그중
              PDF/VIDEO 자산이 0건인 카테고리는 <b>{exposedEmptyCount}</b>건입니다 (정상 상태).
            </Text>
          </BlockStack>
        </Banner>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                카테고리 트리
              </Text>
              <Button
                variant="primary"
                onClick={() => {
                  setCreateName("");
                  setCreateSlug("");
                  setCreateParentId(null);
                  setCreateIsActive(true);
                  setCreateExpose(false);
                  setCreateOpen(true);
                }}
              >
                + 새 카테고리
              </Button>
            </InlineStack>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(280px, 2fr) 90px 90px 90px 120px auto",
                gap: "8px",
                padding: "6px 8px",
                background: "#f6f6f7",
                borderBottom: "2px solid #e1e3e5",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <div>이름</div>
              <div>상태</div>
              <div>노출</div>
              <div>자산</div>
              <div>순서</div>
              <div>편집</div>
            </div>

            {flatVisible.length === 0 ? (
              <Text as="p" tone="subdued" variant="bodyMd">
                카테고리가 없습니다. "+ 새 카테고리"로 추가하세요.
              </Text>
            ) : (
              flatVisible.map(renderRow)
            )}
          </BlockStack>
        </Card>

        {error ? (
          <Card>
            <Text as="p" variant="bodyMd" tone="critical">
              {error}
            </Text>
          </Card>
        ) : null}
        {fetcher.data?.message ? (
          <Card>
            <Text as="p" variant="bodyMd" tone={fetcher.data.ok ? "success" : "critical"}>
              {fetcher.data.message}
            </Text>
          </Card>
        ) : null}
      </BlockStack>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="새 카테고리">
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="이름"
              autoComplete="off"
              value={createName}
              onChange={setCreateName}
              requiredIndicator
            />
            <TextField
              label="Slug"
              autoComplete="off"
              value={createSlug}
              onChange={setCreateSlug}
              requiredIndicator
            />
            <Select
              label="상위(Parent)"
              options={createParentOptions.map((opt) => ({
                label: opt.label,
                value: opt.id ?? "",
              }))}
              value={createParentId ?? ""}
              onChange={(v) => setCreateParentId(v === "" ? null : v)}
            />
            <Text as="p" variant="bodySm" tone="subdued">
              자동 depth: <b>{createDepthHint}</b> (상위에 따라 결정)
            </Text>
            <Checkbox label="활성" checked={createIsActive} onChange={setCreateIsActive} />
            <Checkbox
              label="가이드로 노출 (SHARED 가상 가이드)"
              checked={createExpose}
              onChange={setCreateExpose}
            />
            <InlineStack gap="200" align="end">
              <Button onClick={() => setCreateOpen(false)} disabled={submitting}>
                취소
              </Button>
              <Button variant="primary" onClick={submitCreate} loading={submitting}>
                생성
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={renameTarget ? `이름/Slug 변경: ${renameTarget.name}` : "이름/Slug 변경"}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="이름"
              autoComplete="off"
              value={renameName}
              onChange={setRenameName}
              requiredIndicator
            />
            <TextField
              label="Slug"
              autoComplete="off"
              value={renameSlug}
              onChange={setRenameSlug}
              requiredIndicator
            />
            <InlineStack gap="200" align="end">
              <Button onClick={() => setRenameOpen(false)} disabled={submitting}>
                취소
              </Button>
              <Button variant="primary" onClick={submitRename} loading={submitting}>
                저장
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={reparentOpen}
        onClose={() => setReparentOpen(false)}
        title={reparentTarget ? `상위 변경: ${reparentTarget.name}` : "상위 변경"}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {reparentTarget ? (
              <Text as="p" variant="bodySm">
                현재 위치: <b>{pathById.get(reparentTarget.id) ?? reparentTarget.name}</b>
              </Text>
            ) : null}
            <Select
              label="새 상위"
              options={reparentParentOptions.map((opt) => ({
                label: opt.label,
                value: opt.id ?? "",
              }))}
              value={reparentParentId ?? ""}
              onChange={(v) => setReparentParentId(v === "" ? null : v)}
            />
            <Text as="p" variant="bodySm" tone="subdued">
              새 depth: <b>{reparentNewDepth}</b> (자손 depth는 자동 cascade)
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              ⚠ 자기 자신/자손으로는 이동할 수 없습니다. 자손 depth가 3을 초과하는 후보는 표시되지
              않습니다.
            </Text>
            <InlineStack gap="200" align="end">
              <Button onClick={() => setReparentOpen(false)} disabled={submitting}>
                취소
              </Button>
              <Button variant="primary" onClick={submitReparent} loading={submitting}>
                이동
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
