import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { restaurantListCreateSchema } from "~/domains/guide-viewer/adminSchemas";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);

  const items = await prisma.gkvRestaurantList.findMany({
    orderBy: [{ updatedAt: "desc" }],
  });

  return respond.ok(
    {
      items: items.map((row) => ({
        id: row.id,
        title: row.title,
        city: row.city,
        country: row.country,
        version: row.version,
        isActive: row.isActive,
      })),
    },
    { correlationId },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);

  try {
    const payload = restaurantListCreateSchema.parse(await request.json());
    const id = payload.id ?? `rl_${randomUUID()}`;

    const created = await prisma.gkvRestaurantList.create({
      data: {
        id,
        title: payload.title,
        city: payload.city,
        country: payload.country,
        isActive: payload.isActive,
      },
    });

    return respond.ok(
      {
        id: created.id,
      },
      { correlationId },
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((i) => i.message).join(", "),
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
