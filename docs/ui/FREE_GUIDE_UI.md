# 무료가이드 신청 UI 변경 — 2026-10-27

대상: `/pages/freeguideoptin`, `page.free-guide-optin.json` 템플릿.
사용자가 제공한 `시안_비교안내.html`의 01번 우측 `01_스퀴즈_시안_v2.png`와 `01_확정문구.json`을 기준으로 반영했습니다.

## 변경

- 중앙 정렬 제목·설명과 연보라색 서울 풍경 장식. 장식은 별도의 가벼운 SVG로 구현했습니다.
- 이메일 신청 폼을 혜택 카드 위로 이동하고 흰 카드·노란 CTA로 변경했습니다.
- 이메일의 명시적 라벨을 추가했습니다. 마케팅 동의는 선택 체크박스로 유지하고, 미동의 시에도 무료 Kit를 이용할 수 있다는 문구를 분리했습니다.
- 비행기·전철·지도 핀 아이콘을 사용한 혜택 카드 3개와 보라색 마무리 영역을 추가했습니다.
- 모바일에서는 혜택 카드를 세로로 배치합니다. 공통 레이아웃과 다른 페이지는 수정하지 않았습니다.

## 검증

- Shopify Theme Check: 변경 파일 5개 통과.
- LiquidJS로 실제 변경 섹션·템플릿 설정·번역을 렌더링했습니다.
- Codex 내장 브라우저: PC 1280px 및 1086px, 모바일 iframe 390px와 320px에서 시각 확인했습니다.
- PC에서 가로 넘침이 없고 신청 폼이 혜택 카드보다 위에 있음을 확인했습니다.
- 로컬 모의 신청: 빈 이메일 제출 차단, 마케팅 동의 없이 신청 성공 후 `/pages/squeezthank` 이동, 메일 서비스 실패 시 오류 표시·버튼 복구, 마케팅 구독 실패 시 무료 Kit 열기 링크 유지.
- 기존 `assets/free-guide-optin.js`는 변경하지 않았습니다. 신청 API, reCAPTCHA 실행, 요청 중복 방지, 리드 영수증 저장, 마케팅 선택 구독 흐름은 기존 코드를 사용합니다.
- 실제 이메일 발송·운영 reCAPTCHA·전환 측정은 이번 로컬 검사에서 실행하지 않았습니다.
- `git diff --check` 통과.

## 적용 상태

로컬 테마 소스 수정 완료. 운영 Shopify 테마에는 배포하지 않았습니다.
로컬 검토 자료는 `output/free-guide-optin/preview.html`, `output/free-guide-optin/desktop-mobile.png`에 저장했습니다. `output/`은 Git 제외 경로입니다.

운영 반영 시 기존 테마 백업 후 아래 5개 파일만 함께 반영합니다.

- `sections/ps-free-guide-optin.liquid`
- `assets/free-guide-optin.css`
- `assets/free-guide-seoul.svg`
- `templates/page.free-guide-optin.json`
- `locales/en.default.json`

반영 후 실제 모바일 화면, 선택 동의 여부별 신청과 감사페이지 이동, reCAPTCHA, 전환 측정을 운영 환경에서 확인합니다.
