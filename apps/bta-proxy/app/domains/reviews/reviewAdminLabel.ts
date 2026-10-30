import { createRequire } from "module";
import { ErrorCode } from "~/lib/errors";
import { buildAdminLabel, ReviewServiceError } from "~/domains/reviews/reviewService";

const require = createRequire(import.meta.url);

let cachedClient: import("ioredis").Redis | null = null;
let warned = false;

function getRedisClient(): import("ioredis").Redis {
  if (cachedClient) {
    return cachedClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "Redis URL이 설정되어 있지 않습니다.",
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    cachedClient = new Redis(redisUrl);
    return cachedClient;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        JSON.stringify({
          message: "Redis connection failed for review labels",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    throw new ReviewServiceError(ErrorCode.REVIEW_SHOPIFY_API_ERROR, "Redis 연결에 실패했습니다.");
  }
}

function getDateKeyKST(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const formatted = formatter.format(date); // YYYY-MM-DD
  return formatted.replace(/-/g, "");
}

export async function getAdminReviewLabel(): Promise<{
  label: string;
  dateKey: string;
  seq: number;
}> {
  const client = getRedisClient();
  const dateKey = getDateKeyKST();
  const key = `reviews:admin_seq:${dateKey}`;
  const seq = Number(await client.incr(key));

  if (!Number.isFinite(seq)) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "리뷰 라벨 시퀀스를 생성할 수 없습니다.",
    );
  }

  return {
    label: buildAdminLabel(dateKey, seq),
    dateKey,
    seq,
  };
}
