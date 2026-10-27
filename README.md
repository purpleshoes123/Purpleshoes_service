# Purple Shoes Service

Purple Shoes 웹 서비스의 운영 소스 저장소입니다.

## 구성

- `themes/kpurpleshoes-theme/`: Shopify 운영 테마. 2026-10-27 운영 테마 ID `136507654238`에서 직접 다운로드한 파일입니다.
- `apps/bta-proxy/`: AWS의 웹 서버, Shopify 임베디드 어드민, 회원 구매·예약·쿠폰·메일·뷰어 API 소스입니다.
- `shopify/bta-proxy/`: Shopify 앱 설정과 관리자·결제 확장 소스입니다. AWS 서버와 별도 잠금 파일로 관리하고 Shopify에 따로 배포합니다.
- `docs/provenance/`: 운영 배포 원본을 대조하기 위한 파일별 SHA-256 기록입니다.

모바일 앱, 과거 작업 백업, 테스트 고객/주문 기록, 환경변수 실값, DB와 업로드된 고객 파일, `node_modules`, 빌드 산출물은 포함하지 않습니다.

## 로컬 실행

Node.js 22 LTS를 권장합니다. 백엔드의 정확한 의존성은 `apps/bta-proxy/package-lock.json`을 기준으로 설치합니다.

```powershell
cd apps/bta-proxy
npm ci --workspaces=false --ignore-scripts
Copy-Item .env.example .env
# .env에 개발 전용 값을 채우고, 개발 DB만 연결합니다.
npx prisma generate
npm run build
npm run dev:local-ui
```

`.env.example`은 최소 설정 예시이며 운영 설정의 완전한 복제본이 아닙니다. DB 구조 반영이나 마이그레이션을 운영 DB에 임의로 실행하지 마세요. `npm run setup`은 `prisma db push`를 포함합니다.

Shopify 확장은 `shopify/bta-proxy`에서 의존성을 설치해 개발합니다. 운영 앱 설정 변경 및 확장 배포에는 별도 검증과 승인이 필요합니다. `apps/bta-proxy`의 과거 `deploy` 스크립트로 확장을 배포하지 마세요.

## 운영 반영 원칙

이 저장소에 `commit/push`하는 것만으로 AWS나 Shopify에 자동 배포되지 않습니다. 이번 소스 이관은 기존 운영 환경, 결제, 상품 데이터, AWS 시작 템플릿을 변경하지 않습니다. 자동 배포 연동은 별도 작업입니다.

배포 시에는 테스트·빌드·비밀정보 검사를 통과한 소스로 서버 패키지를 만들고 순차 반영합니다. Shopify 테마는 백업 후 검증된 변경 파일만 반영합니다. 운영 비밀정보는 기존 보안 저장소/실행 환경에서 주입하고 Git에 저장하지 않습니다.

## 검증 및 출처

자세한 이관 검증 범위는 `docs/PRODUCTION_SOURCE.md`를 확인하세요. 원본 매니페스트의 `NOT_APPROVED_FOR_TRAFFIC` 문자열은 패키징 전 생성된 기록을 그대로 보존한 값이며, 현재 승인 여부를 판정하는 스위치가 아닙니다.
