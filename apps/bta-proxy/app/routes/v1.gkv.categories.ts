import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { respond } from "~/lib/respond";

type CategoryNode = {
  id: string;
  kind: string;
  name: string;
  slug: string;
  depth: number;
  sortOrder: number;
  children: CategoryNode[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const rows = await prisma.gkvCategory.findMany({
    where: { isActive: true },
    orderBy: [{ depth: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const byId = new Map<string, CategoryNode>();
  rows.forEach((row) => {
    byId.set(row.id, {
      id: row.id,
      kind: "SHARED",
      name: row.name,
      slug: row.slug,
      depth: row.depth,
      sortOrder: row.sortOrder,
      children: [],
    });
  });

  const roots: CategoryNode[] = [];
  rows.forEach((row) => {
    const node = byId.get(row.id);
    if (!node) {
      return;
    }
    if (row.parentId) {
      const parent = byId.get(row.parentId);
      if (parent) {
        parent.children.push(node);
        return;
      }
    }
    roots.push(node);
  });

  return respond.ok({ items: roots }, { correlationId });
};
