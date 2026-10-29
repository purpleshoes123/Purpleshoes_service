# 스퀴즈 감사페이지 UI 변경 — 2026-10-29

대상은 `/pages/squeezthank`와 `page.squeeze-thankyou.json` 템플릿입니다. 사용자 제공 `시안_비교안내.html`의 02번 우측 `02_스퀴즈감사_시안_v2.png`를 기준으로 구현했습니다.

## 변경

- 기존 브랜드 로고, 보라색 그라데이션 완료 영역과 체크 아이콘을 시안의 크기·간격으로 배치했습니다.
- 제목은 `Your Free Starter Kit Is Ready.`, 설명은 `Start with the essentials for your first Korea trip.`로 변경했습니다.
- 노란 `Open My Free Starter Kit` 버튼의 기존 뷰어 목적지를 유지했습니다.
- 버튼 아래에는 `Free access. No purchase required.`를 표시합니다.
- 영상·가이드북·자유 열람 아이콘과 안내 3개를 추가했습니다. PC는 가로 3열, 모바일은 세로 배치입니다.
- 사용하지 않는 유료 Kit 소개 설정·스타일을 제거했습니다. 중복 하단 로고·메뉴가 없는 기존 `no-header` 레이아웃을 유지했습니다.
- `no-header` 레이아웃에 스퀴즈 감사 템플릿 전용 클래스를 추가했습니다. 해당 페이지에서만 고정 높이·내용 숨김을 해제해 모바일에서도 하단까지 스크롤할 수 있습니다. PDF 뷰어 등 다른 템플릿의 레이아웃에는 적용되지 않습니다.

## 검증

- Shopify Theme Check: 변경 파일 5개 오류 없음. 기존 `no-header.liquid`의 외부 Google Fonts 자산 3건과 `scheme_classes` 변수 1건 경고는 기존 코드에서 발생하며 이번 변경 줄과 무관합니다.
- LiquidJS로 실제 섹션·템플릿 설정·번역을 렌더링하고, 템플릿 설정과 섹션 스키마가 일치하는지 확인했습니다.
- 감사 템플릿에만 전용 클래스가 적용되고 Starter Kit 뷰어·무료신청 템플릿에는 적용되지 않는지 확인했습니다.
- Codex 내장 브라우저에서 PC 1280px, 모바일 390px·320px의 줄바꿈·CTA 크기·아이콘 배치를 확인했습니다. 세 폭 모두 가로 스크롤이 없으며 모바일 하단 내용이 잘리지 않습니다.
- 실제 버튼 클릭으로 `https://kpurpleshoes.com/pages/starter-kit-viewer` 이동과 무료 영상·가이드북 화면 로딩을 확인했습니다.
- 기존 `squeeze-thankyou-lead.js`는 변경하지 않았으며 섹션에서 기존과 같이 defer로 로드합니다. 리드 영수증·개인정보 동의·검증 후 전환 측정 흐름은 그대로입니다. 실제 리드 발급이나 운영 광고 전환 이벤트 검증은 수행하지 않았습니다.
- `git diff --check` 통과.

## 적용 상태

로컬 소스 수정 완료. 운영 테마 배포 및 이번 변경의 커밋·푸시는 실행하지 않았습니다.
검토용 HTML은 `output/squeeze-thankyou/preview.html`, 화면 이미지는 같은 폴더의 `desktop.png`, `mobile.png`입니다. `output/`은 Git 제외 경로입니다.

운영에 반영할 테마 파일:

- `sections/ps-squeeze-thankyou.liquid`
- `assets/squeeze-thankyou.css`
- `templates/page.squeeze-thankyou.json`
- `locales/en.default.json`
- `layout/no-header.liquid`
