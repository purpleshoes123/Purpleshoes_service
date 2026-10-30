# Purple Shoes Service

Shopify 쇼핑몰 UI와 AWS 웹 서버·어드민·API·메일 작업자를 함께 관리하는 운영 저장소입니다.
`main`에 push하거나 PR을 merge하면 검증 후 변경 영역이 운영에 자동 배포됩니다.
백엔드·Shopify 테마·앱 확장 중 바뀐 영역만 빌드·배포하며, 문서·테스트만 바뀐 경우 운영 배포를 건너뜁니다.

## 처음 인수인계받았다면

1. [인수인계 체크리스트](docs/maintenance/HANDOVER.md)에서 접근 권한과 담당자를 확인합니다.
2. [개발 환경](docs/maintenance/LOCAL_DEVELOPMENT.md)으로 설치·테스트·빌드를 준비합니다.
3. [구조와 기능 지도](docs/architecture/OVERVIEW.md)에서 수정할 기능의 위치를 찾습니다.
4. [추가 개발 규칙](CONTRIBUTING.md)에 따라 브랜치와 PR에서 작업합니다.
5. 배포·복구는 [운영 매뉴얼](docs/maintenance/OPERATIONS.md), [CI/CD 상세](docs/CICD.md)를 따릅니다.

## 저장소 구성

| 경로                                         | 역할                              | 배포 대상                   |
| -------------------------------------------- | --------------------------------- | --------------------------- |
| `themes/kpurpleshoes-theme/`                 | Liquid·CSS·JS·화면 템플릿         | Shopify 운영 테마           |
| `apps/bta-proxy/app/routes/`                 | HTTP 진입점·임베디드 어드민       | AWS EC2/ASG                 |
| `apps/bta-proxy/app/domains/`                | 예약·결제·쿠폰·회원 등 기능 로직  | AWS EC2/ASG                 |
| `apps/bta-proxy/app/lib/`, `app/middleware/` | 공통 유틸·요청 인증               | AWS EC2/ASG                 |
| `apps/bta-proxy/scripts/`                    | 시작·보안 저장소 연결·메일 작업자 | AWS EC2/ASG                 |
| `shopify/bta-proxy/`                         | 앱 설정·관리자 및 결제 확장       | Shopify 앱 버전             |
| `scripts/cicd/`                              | 검증·빌드·배포·복구               | GitHub Actions              |
| `scripts/maintenance/`                       | 코드 형식 검사                    | 로컬·PR 검증                |
| `docs/`                                      | 인수인계·개발·운영·UI·원본 출처   | [문서 목록](docs/README.md) |

루트 npm 패키지는 개발 도구용입니다. AWS 앱과 Shopify 확장의 잠금 파일은 독립적으로 유지하며 npm workspaces로 합치지 않습니다.

## 시작 명령

Node.js `22.23.3`, Python `3.12` 또는 `3.13`을 사용합니다. 개발 DB·스토어 설정은 개발 환경 문서를 먼저 확인합니다.

```sh
npm ci --ignore-scripts
python -m pip install -r requirements-dev.txt
npm --prefix apps/bta-proxy ci --workspaces=false --ignore-scripts
npm --prefix shopify/bta-proxy ci --ignore-scripts
npm run format:check
npm run format:python:check
npm run test:maintenance
```

운영 비밀값은 AWS 보안 저장소와 GitHub Actions Secrets에 보관합니다. `.env.example`은 개발 예시이며 운영 설정의 완전한 복제본이 아닙니다.

DB 구조 변경, Shopify `config/settings_data.json` 변경, 테마 파일 삭제는 자동 배포가 중단하는 별도 작업입니다. PR은 검증만 실행하며, main 쓰기 권한은 운영 배포 권한으로 관리합니다.

모바일 앱·서명키·고객/주문 내보내기·개인 인증 캐시는 이 운영 레포에 포함하지 않습니다. 원본 출처는 [이관 기록](docs/PRODUCTION_SOURCE.md)과 `docs/provenance/`에 보존합니다. 원본 해시는 이관 당시의 기록이며 현재 개발 코드의 정답이 아닙니다.
