/**
 * SSOT 11장: 로깅/마스킹 규칙
 * 전화/이메일 등 PII는 부분 마스킹
 */

/**
 * 이메일 주소를 마스킹합니다.
 * 예: user@example.com -> u***@e***.com
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) {
    return email;
  }

  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) {
    return email;
  }

  // 로컬 파트: 첫 글자만 보이고 나머지는 마스킹
  const maskedLocal = localPart.length > 1 ? `${localPart[0]}***` : localPart;

  // 도메인: 첫 글자만 보이고 나머지는 마스킹
  const [domainName, ...tldParts] = domain.split(".");
  const maskedDomain =
    domainName.length > 1 ? `${domainName[0]}***` : domainName;

  const maskedTld = tldParts.length > 0 ? `.${tldParts.join(".")}` : "";
  return `${maskedLocal}@${maskedDomain}${maskedTld}`;
}

/**
 * 전화번호를 마스킹합니다.
 * 예: 010-1234-5678 -> 010-****-5678
 */
export function maskPhone(phone: string): string {
  if (!phone) {
    return phone;
  }

  // 숫자만 추출
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) {
    return "***";
  }

  // 마지막 4자리만 보이고 나머지는 마스킹
  const last4 = digits.slice(-4);
  const masked = "*".repeat(Math.max(0, digits.length - 4));
  return `${masked}${last4}`;
}

/**
 * 이름을 마스킹합니다.
 * 예: 홍길동 -> 홍***, John Smith -> J***
 */
export function maskName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return name;
  }
  const [firstChar] = Array.from(trimmed);
  return `${firstChar}***`;
}

function isPhoneKey(key: string): boolean {
  return key.includes("phone") || key.includes("tel");
}

function isReservationContactNameKey(key: string): boolean {
  return key === "reservation_contact_name" || key === "reservationcontactname";
}

/**
 * 객체에서 PII를 마스킹합니다.
 */
export function maskPII(data: unknown): unknown {
  if (typeof data !== "object" || data === null) {
    if (typeof data === "string") {
      // 문자열이 이메일 형식인지 확인
      if (data.includes("@") && data.includes(".")) {
        return maskEmail(data);
      }
      // 전화번호 형식인지 확인 (숫자와 하이픈 포함)
      if (/[\d-+()\s]{7,}/.test(data)) {
        return maskPhone(data);
      }
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(maskPII);
  }

  const sanitized: Record<string, unknown> = {};
  const record = data as Record<string, unknown>;
  const propertyName =
    typeof record.name === "string" ? record.name.toLowerCase() : null;

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();

    // 이메일 필드
    if (lowerKey.includes("email") && typeof value === "string") {
      sanitized[key] = maskEmail(value);
    }
    // Shopify line item property: { name: "reservation_contact_name", value: "..." }
    else if (
      lowerKey === "value" &&
      propertyName &&
      typeof value === "string"
    ) {
      if (isReservationContactNameKey(propertyName)) {
        sanitized[key] = maskName(value);
      } else if (isPhoneKey(propertyName)) {
        sanitized[key] = maskPhone(value);
      } else {
        sanitized[key] = maskPII(value);
      }
    }
    // 전화번호 필드
    else if (isPhoneKey(lowerKey) && typeof value === "string") {
      sanitized[key] = maskPhone(value);
    }
    // 예약자 이름 필드
    else if (
      isReservationContactNameKey(lowerKey) &&
      typeof value === "string"
    ) {
      sanitized[key] = maskName(value);
    }
    // 중첩 객체 재귀 처리
    else {
      sanitized[key] = maskPII(value);
    }
  }

  return sanitized;
}
