# 구조와 기능 지도

## 서비스 구성

```text
쇼핑몰 방문자
  └─ Shopify 테마 (Liquid + CSS + JS)
       ├─ 공개 소개 화면
       └─ 로그인·서명된 App Proxy 요청
            └─ AWS bta-proxy (React Router)
                 ├─ 요청 인증과 입력 검증
                 ├─ 기능별 domain 로직
                 ├─ Shopify 상품·주문·고객·쿠폰 연동
                 ├─ PostgreSQL: 영속 데이터·작업 기록
                 └─ Valkey: 예약 조정·임시 상태·캐시

Shopify 관리자 ── 임베디드 어드민 / 관리자·결제 확장
Shopify Webhook ── 검증 후 권한·예약·메일 작업 반영
구매 메일 작업자 ── 영속 발송 대기열 처리
```

CloudFront·ALB 등 서버 앞단 인프라는 기존 설정을 유지합니다. AWS 배포 대상은 EC2/ASG 서버 패키지이며 별도 S3 정적 프론트 업로드나 CloudFront 캐시 무효화 단계는 없습니다.

## 백엔드 폴더

```text
apps/bta-proxy/
  app/
    routes/          # URL 진입점·관리자 화면, 이름 유지
    domains/         # 기능별 로직·관련 테스트
    middleware/      # 요청자·서명 검증
    lib/             # 공통 HTTP·환경·로그·유틸
    db.server.ts
    shopify.server.ts
  scripts/           # 서버·DB·Valkey 시작과 메일 작업자
  prisma/            # 데이터 모델
  mail-templates/    # 검토된 구매 메일
  public/            # 정적 파일과 폰트
```

## 기능별 수정 위치

경로는 `apps/bta-proxy/app/` 기준입니다. 기존 모듈의 공개 함수와 업무 규칙은 유지합니다.

| 기능                          | 로직                    | 주요 진입점                                                                       |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| 상품·가격·게시                | `domains/catalog/`      | `routes/app.products.upsert.tsx`, 상품 read/upsert/publish 모듈                   |
| 예약·일정·인원·용량           | `domains/bookings/`     | `routes/proxy.bta.availability.ts`, `proxy.bta.reservations.ts`, `app.bookings.*` |
| 회원 결제·연장·투어 결제      | `domains/checkout/`     | `routes/proxy.bta.*prepare-checkout.ts`, `proxy.bta.guide-extension.checkout.ts`  |
| 쿠폰·소개 적립                | `domains/coupons/`      | `routes/proxy.bta.coupons.*`, `admin.coupons.*`, `app.coupons.tsx`                |
| PDF·동영상·Purple Map·세션    | `domains/guide-viewer/` | `routes/v1.gkv.*`, `proxy.bta.mypage.*`, `admin.gkv.*`                            |
| 구매/안내 메일·수신 거부      | `domains/mail/`         | `routes/proxy.bta.mail.*`, `app.mail.*`, `mail.unsubscribe.tsx`                   |
| 가입 확인·회원 태그·고객 검색 | `domains/members/`      | `routes/webhooks.customers.create.ts`, 검증된 고객 조회 route                     |
| Instagram·Klaviyo·측정        | `domains/marketing/`    | `routes/proxy.instagram.*`, `events.squeeze.*`                                    |
| 리뷰·검토 계정                | `domains/reviews/`      | `routes/app.reviews.*`, `proxy.bta.reviews.*`, `v1.reviewer.$operation.ts`        |
| Storefront 보조               | `domains/storefront/`   | 상품 조회·체크아웃 연동 모듈                                                      |
| 주문 Webhook 공통 처리        | `domains/webhooks/`     | `routes/proxy.webhooks.*`, `webhooks.*`                                           |

## 신뢰 경계

- 관리자 요청의 Shopify 인증과 내부 API 키 검증은 서로 다른 경계입니다.
- 회원 API는 서명된 App Proxy와 검증된 고객을 기준으로 처리합니다. URL 고객 ID만 믿지 않습니다.
- Webhook은 서명·발신 스토어 확인과 중복 방지가 필요합니다.
- 공개 소개와 회원 가격·예약 조회를 구분합니다. 화면 숨김만으로 인증을 대신하지 않습니다.
- 카드 결제는 Shopify hosted Checkout이 담당합니다. 카드번호를 이 앱에서 처리·보관하지 않습니다.
- PostgreSQL의 영속 기록·권한·발송 대기열과 Valkey의 임시 상태를 혼동하지 않습니다.

## 결제 후속 흐름

1. 회원 요청 검증 후 자격·쿠폰·가격·예약 상태를 서버에서 확인합니다.
2. 서버가 만든 회원 구매 초안 주문 링크로 Checkout에 연결합니다. 분기는 `domains/checkout/checkoutMode.server.ts`를 확인합니다.
3. 검증된 결제 Webhook에서 권한·예약·기간·후속 작업을 처리합니다.
4. 구매 메일은 영속 대기열과 작업자가 처리합니다. 전환 시각·대상 조건을 확인합니다.
5. 환불·취소 Webhook에서 연결 상태를 처리합니다. 관리자 수동 권한 발행은 결제사의 승인·환불 검증을 대신하지 않습니다.

## 유지해야 하는 계약

`app/routes/` 이름, Shopify 표준 폴더·템플릿 참조, 확장 UID·target·module, `build/server/index.js`, 서버/메일 시작 스크립트는 외부 시스템과 연결됩니다. 운영 패키지 매니페스트와 비공개 배포 기준은 실제 파일 대조 결과로 관리합니다.
