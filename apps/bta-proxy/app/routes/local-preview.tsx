import type { LinksFunction, MetaFunction } from "react-router";
import { json } from "~/lib/httpJson";
import { useLoaderData } from "react-router";

import previewStyles from "~/styles/local-preview.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: previewStyles }];

export const meta: MetaFunction = () => [
  { title: "BTA Proxy · Local UI Preview" },
  {
    name: "description",
    content: "Local-only UI preview without Shopify, AWS, Redis, or production data.",
  },
];

export const loader = () => {
  if (process.env.LOCAL_UI_PREVIEW !== "true") {
    throw new Response("Not Found", { status: 404 });
  }

  return json({ startedAt: new Date().toISOString() });
};

const checklist = [
  ["Shopify", "외부 연결 없음", "disabled"],
  ["AWS / Redis", "외부 연결 없음", "disabled"],
  ["데이터", "컨테이너 내 mock preview", "ready"],
] as const;

export default function LocalPreview() {
  const { startedAt } = useLoaderData<typeof loader>();

  return (
    <main className="preview-shell">
      <aside className="preview-sidebar" aria-label="Preview navigation">
        <div className="preview-mark">B</div>
        <div>
          <p className="preview-overline">LOCAL ONLY</p>
          <h1>BTA Proxy</h1>
        </div>
        <nav>
          <a className="is-active" href="#overview">
            Overview
          </a>
          <a href="#workbench">UI workbench</a>
          <a href="#safety">Safety</a>
        </nav>
        <p className="preview-sidebar-note">
          이 페이지는 UI 검토 전용입니다. 실제 예약, 주문, 고객 데이터에는 연결하지 않습니다.
        </p>
      </aside>

      <section className="preview-content">
        <header className="preview-topbar">
          <div>
            <p className="preview-overline">BTA-PROXY / DESIGN SANDBOX</p>
            <h2>Local UI Preview</h2>
          </div>
          <span className="preview-status">Container running</span>
        </header>

        <section id="overview" className="preview-hero">
          <div>
            <p className="preview-overline">SAFE BY DEFAULT</p>
            <h3>운영과 분리된 UI 작업 공간</h3>
            <p>
              이 화면에서 레이아웃, 카피, 컬러, 컴포넌트를 먼저 다듬은 뒤 실제 Embedded Admin
              화면으로 옮길 수 있습니다.
            </p>
          </div>
          <div className="preview-hero-stat">
            <strong>0</strong>
            <span>external services connected</span>
          </div>
        </section>

        <section id="workbench" className="preview-grid">
          <article className="preview-card preview-card-wide">
            <div className="preview-card-heading">
              <div>
                <p className="preview-overline">WORKBENCH</p>
                <h3>변경점 확인 흐름</h3>
              </div>
              <span className="preview-badge">Hot reload</span>
            </div>
            <ol className="preview-steps">
              <li>
                <span>01</span>
                <div>
                  <strong>UI 코드 수정</strong>
                  <p>`app/` 아래 React route와 style을 저장합니다.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>브라우저 새로고침</strong>
                  <p>Vite가 변경을 감지해 preview를 갱신합니다.</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>승인된 변경만 이식</strong>
                  <p>실제 Shopify 연동 화면에는 검토 후 반영합니다.</p>
                </div>
              </li>
            </ol>
          </article>

          <article id="safety" className="preview-card">
            <p className="preview-overline">CONNECTION POLICY</p>
            <h3>안전 상태</h3>
            <ul className="preview-checklist">
              {checklist.map(([label, detail, state]) => (
                <li key={label}>
                  <span className={`preview-dot ${state}`} aria-hidden="true" />
                  <div>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </div>
                </li>
              ))}
            </ul>
          </article>
        </section>

        <footer className="preview-footer">
          <span>Started {new Date(startedAt).toLocaleString()}</span>
          <code>http://localhost:3000/local-preview</code>
        </footer>
      </section>
    </main>
  );
}
