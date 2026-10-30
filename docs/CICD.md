# CI/CD

## 실행

- `main` push 및 수동 실행: 검증 후 변경된 AWS 서버·Shopify 테마·앱 확장을 배포합니다. 작성자 이름 조건은 없습니다.
- PR: 비밀키 없이 검증만 실행합니다. `pull_request_target`과 자체 호스팅 러너는 사용하지 않습니다.
- 운영 작업은 직렬 실행하며 진행 중인 배포를 다음 push로 취소하지 않습니다. GitHub는 대기 중인 실행을 최신 실행으로 대체할 수 있습니다. 배포 기준과 최신 커밋을 비교하므로 중간 변경이 빠지지 않습니다.

## 필수 연결

저장소 Actions 변수는 `AWS_REGION`(리전)만 사용합니다. 아래 운영 대상 식별자는 공개 저장소에서 일반 변수로 등록하지 않고 모두 Actions Secrets에 암호화해 보관합니다.

| 이름 | 내용 |
|---|---|
| `AWS_ACCOUNT_ID` | 기존 운영 계정 번호 |
| `RELEASE_BUCKET` | 기존 비공개 배포 버킷 |
| `ASG_NAME` | 기존 운영 ASG |
| `LAUNCH_TEMPLATE_ID` | 기존 시작 템플릿 ID |
| `SHOPIFY_STORE` | 운영 `.myshopify.com` 주소 |
| `SHOPIFY_THEME_ID` | 운영 테마 ID |
| `PUBLIC_HEALTH_URL` | HTTPS 준비 상태 확인 URL |

추가 Actions Secrets:

| 이름 | 범위 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | 해당 저장소 main의 OIDC만 신뢰하는 배포 역할. 장기 AWS 키를 저장하지 않습니다. |
| `SHOPIFY_CLI_THEME_TOKEN` | 해당 스토어 테마 배포용 Theme Access 토큰 |
| `SHOPIFY_SERVICE_ACCOUNT_TOKEN` | 앱 개발 권한을 가진 전용 서비스 계정 토큰. 앱 설정·확장 변경 배포 시 필요 |

개인 Shopify CLI 로그인 캐시를 GitHub에 복사하지 않습니다. 토큰을 셸 인수·로그·보고서에 넣지 않습니다. 공식 Shopify 서비스 계정 인증을 지원하는 CLI 5.0.0을 고정합니다.

AWS 역할은 지정한 S3 배포 경로 읽기/쓰기, 지정한 시작 템플릿 버전 생성, 지정한 ASG 순차 교체, 해당 ASG 인스턴스의 SSM 확인에 한정합니다. DB·Shopify·메일 비밀값은 인스턴스의 기존 비밀정보 로더에서 읽습니다. 배포 역할에 Secrets Manager 비밀값 조회나 IAM 권한 변경을 허용하지 않습니다. OIDC의 audience와 main subject를 정확히 제한하고 저장소·소유자 불변 ID가 포함되는 현재 GitHub 형식을 사용합니다.

## 최초 운영 기준

실제 운영 코드와 저장소를 대조한 뒤 비공개 배포 버킷의 `releases/cicd/production/state.json`에 다음 항목을 등록해야 합니다.

```json
{
  "backendCommit": "검증한 Git 커밋 SHA 40자",
  "themeCommit": "검증한 Git 커밋 SHA 40자",
  "appCommit": "검증한 Git 커밋 SHA 40자",
  "backendDigest": "운영 FLEET 소스 매니페스트 SHA-256 64자"
}
```

빈 값을 임의로 채우거나 최신 커밋을 운영 코드와 대조 없이 등록하면 안 됩니다. 기준이 없으면 배포는 중단됩니다. 버킷 버전 관리·암호화와 기존 인스턴스의 신규 배포 경로 읽기 권한도 확인합니다. 운영 ASG는 숫자 시작 템플릿 버전을 사용해야 합니다.

## 검증과 배포 보호

잠금 파일 설치, 회원 가격 조회·할인·결제 요청·관리형 인증 정보 회귀 테스트, Node 22 Linux 빌드, Prisma 클라이언트 생성, native 의존성 로드, 전체 Git 이력 비밀정보 검사, 운영 의존성 critical 취약점 검사, 테마 JSON·JS·Theme Check 및 확장 컴파일을 통과해야 배포합니다. 실제 주문·결제·환불·메일을 생성하는 테스트는 실행하지 않습니다.

Theme Check의 기존 지적 사항은 `aca32ad` 버전과 비교합니다. 기존 8,226건(대부분 미관리 언어 번역 누락)을 해결한 것으로 표시하지 않으며 새 오류 그룹/건수 증가를 차단합니다. 기존 소스 이관의 SHA 기록은 변경 검증에 쓰지 않고 출처로 보존합니다.

운영 스키마 변경은 자동 배포하지 않습니다. `npm run setup`/`prisma db push`는 실행하지 않습니다. 별도 검토된 DB 마이그레이션 절차가 필요합니다.

서버는 커밋별 불변 패키지를 암호화된 비공개 S3에 올리고 기존 시작 설정을 복제합니다. 네트워크·인스턴스 역할·런타임 설정을 유지하며 100% 최소 정상 용량으로 순차 교체합니다. 전체 새 인스턴스의 ALB·로컬 준비 상태를 확인한 뒤 기존 구매 메일 작업자의 활성 버전만 전환하고 실제 작업자 자식 프로세스를 확인합니다.

테마는 바뀐 파일만 읽기 전용 백업하고 기존 기준과 비교합니다. 관리자나 다른 배포가 바꾼 파일과 충돌하면 먼저 중단합니다. 반영 후 Shopify에서 다시 내려받아 대조합니다. `config/settings_data.json` 및 테마 파일 삭제는 별도 작업으로 처리합니다. 앱은 기존 확장을 누락하지 않는지 컴파일 단계에서 확인하며 활성 버전을 저장한 뒤 배포합니다.

## 실패와 복구

실패하면 기존 숫자 시작 템플릿으로 다시 순차 교체하고 메일 작업자 활성 버전을 복구합니다. 테마는 백업된 기존 파일을 복원하고 앱은 이전 활성 버전으로 되돌립니다. 부분 업로드된 신규 테마 파일은 자동 삭제하지 않으므로 참조되지 않는 새 파일이 남을 수 있습니다. 복구 실패는 작업 요약에 별도 표시하며 성공으로 처리하지 않습니다.

비공개 S3 실행 경로에 이전 상태와 테마 백업을 보관합니다. GitHub 실행 요약에는 커밋·대상 영역·결과만 남깁니다. 수동 운영 변경 후에는 다음 자동 배포 전에 기준을 다시 대조해야 합니다.

## 보안 범위와 남은 검증

이 구성은 main 쓰기 권한을 운영 배포 권한으로 취급합니다. 저장소 소유자가 main 보호 규칙과 리뷰 정책을 관리해야 합니다. 현재 연결 계정에 저장소 관리자 권한이 없어 보호 규칙 적용을 완료한 것으로 간주하지 않습니다.

워크플로 파일을 push한 사실만으로 운영 자동화 검증이 끝나지 않습니다. AWS OIDC 실제 인증, 전용 Shopify 토큰, 최초 운영 기준, 실제 자동 배포·확인·복구 점검까지 성공해야 운영 연결 완료입니다. 외부 연동이 빠진 상태에서는 배포를 성공으로 건너뛰지 않고 명확하게 실패합니다.

참고: [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [Shopify 테마 CI/CD](https://shopify.dev/docs/storefronts/themes/tools/cli/ci-cd), [Shopify 앱 CI/CD](https://shopify.dev/docs/apps/launch/deployment/deploy-in-ci-cd-pipeline).
