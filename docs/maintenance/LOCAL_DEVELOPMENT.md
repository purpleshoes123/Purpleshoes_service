# 로컬 개발·검증 가이드

## 준비와 설치

Node.js `22.23.3`, Python `3.12` 또는 `3.13`, Git을 준비합니다. 기능에 따라 개발 전용 PostgreSQL·Redis/Valkey·Shopify 개발 스토어가 필요합니다. Shopify CLI는 `5.0.0`을 기준으로 합니다.

루트 개발 도구·AWS 앱·Shopify 확장의 잠금 파일은 독립적입니다.

Python 도구는 가상환경 사용을 권장합니다. `python -m venv .venv` 후 Windows는 `.venv\Scripts\Activate.ps1`, macOS/Linux는 `source .venv/bin/activate`로 활성화합니다. `.venv/`는 Git에서 제외됩니다.

```sh
npm ci --ignore-scripts
python -m pip install -r requirements-dev.txt
npm --prefix apps/bta-proxy ci --workspaces=false --ignore-scripts
npm --prefix shopify/bta-proxy ci --ignore-scripts
```

## 환경변수

`apps/bta-proxy/.env.example`을 같은 폴더의 `.env`로 복사합니다. `.env`는 Git에서 제외됩니다. 운영 설정의 완전한 복제본은 아닙니다.

| 구분        | 확인할 설정                                            |
| ----------- | ------------------------------------------------------ |
| 서버        | `NODE_ENV`, `PORT`, `SHOPIFY_APP_URL`                  |
| 개발 스토어 | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`      |
| 개발 데이터 | 로컬 `DATABASE_URL`, `REDIS_URL`, `BOOKING_STORE_TYPE` |
| 가이드 뷰어 | `GKV_*`, 개발용 자산·버킷·서명 설정                    |
| 결제        | `BTA_PRIVATE_CHECKOUT_ENABLED`, 관련 상품 variant 설정 |
| 메일        | 기본 발송 비활성. 검증은 전용 설정·지정 수신자만 사용  |

운영 비밀값을 개인 PC에 일괄 내보내지 않습니다. 로컬 검증은 운영 DB·Valkey·메일·Webhook에 연결하지 않습니다. 메일 전환 변수와 보안 저장소 로딩은 `scripts/`와 운영 매뉴얼을 함께 확인합니다.

## 실행과 DB

`apps/bta-proxy`에서:

```sh
node node_modules/prisma/build/index.js generate
npm run dev:local-ui
```

Prisma 클라이언트 생성은 DB 구조를 변경하지 않습니다. 초기화는 본인의 폐기 가능한 로컬 DB 주소인지 확인 후 별도 작업으로 진행합니다. `npm run setup`·`docker-start`는 `prisma db push`를 포함하므로 운영에서 실행하지 않습니다.

관리자 OAuth·고객 로그인·App Proxy 전체 검증에는 개발 스토어와 개발 주소 설정이 필요합니다. 로컬 화면 표시만으로 연동 검증을 마쳤다고 기록하지 않습니다.

## 검증 명령

루트:

```sh
npm run format:check
npm run format:python:check
npm run test:maintenance
python -m unittest discover -s scripts/cicd -p 'test_*.py' -v
node --test scripts/cicd/*.test.mjs
node scripts/cicd/verify-source.mjs
```

`apps/bta-proxy`:

```sh
npm run test:run
node --test scripts/*.test.mjs
node node_modules/prisma/build/index.js generate
npm run build
npm audit --omit=dev --audit-level=critical
```

확장 컴파일은 루트에서 실행합니다. Shopify 버전 배포는 하지 않습니다.

```sh
node scripts/cicd/build-extensions.mjs
```

테마 검사는 CLI 설치 후 루트에서 실행합니다. 기존 오류 기준보다 새 오류가 증가하는지 확인합니다.

```sh
npm install --global @shopify/cli@5.0.0 --ignore-scripts
node scripts/cicd/check-theme.mjs
```

## 환경 문제 구분

- Windows 격리 환경에서 Vite/Vitest 임시 파일 rename이 EPERM으로 실패하면 무시되는 저장소 임시 폴더로 `TEMP`·`TMP`를 지정해 확인합니다.
- Black은 여러 파일 처리 시 로컬 프로세스 통신을 사용합니다. 격리 환경의 로컬 소켓 차단으로 대기한다면 일반 개발 터미널에서 실행합니다.
- `scripts/verify-source.mjs`는 이관 당시 해시 검사 도구입니다. 현재 코드 검사는 `scripts/cicd/verify-source.mjs`를 사용합니다.
- 기존 TypeScript·테마·의존성 경고를 해결 완료로 간주하지 않습니다. 새로운 오류와 구분해 기록합니다.
