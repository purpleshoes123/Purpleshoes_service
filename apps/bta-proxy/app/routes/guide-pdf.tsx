import { useEffect, useRef, useState } from "react";
import type { HeadersFunction } from "react-router";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { pdfContentPath } from "~/lib/gkv/pdfViewerUrl";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": "frame-ancestors https://kpurpleshoes.com https://www.kpurpleshoes.com",
});

export default function GuidePdf() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pdf = useRef<PDFDocumentProxy | null>(null);
  const renderTask = useRef<RenderTask | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [width, setWidth] = useState(320);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    let loading: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    const resize = () => setWidth(Math.max(240, document.documentElement.clientWidth - 24));
    resize();
    window.addEventListener("resize", resize);
    const prevent = (event: Event) => event.preventDefault();
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ["p", "s"].includes(event.key.toLowerCase())) event.preventDefault();
    };
    document.addEventListener("contextmenu", prevent);
    document.addEventListener("keydown", keydown);
    (async () => {
      const file = new URLSearchParams(location.hash.slice(1)).get("file") || "";
      const path = pdfContentPath(file);
      const engine = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (disposed) return;
      engine.GlobalWorkerOptions.workerSrc = workerUrl;
      loading = engine.getDocument({ url: path, withCredentials: false, useWasm: false });
      const documentPdf = await loading.promise;
      if (disposed) { await loading.destroy(); return; }
      pdf.current = documentPdf;
      setPages(documentPdf.numPages);
    })().catch(() => {
      if (!disposed) {
        setError("This guide could not be opened. Please select the PDF again in the guide list to refresh your access.");
        setBusy(false);
      }
    });
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      document.removeEventListener("contextmenu", prevent);
      document.removeEventListener("keydown", keydown);
      renderTask.current?.cancel();
      void loading?.destroy();
      pdf.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pages || !pdf.current || !canvas.current) return;
    let disposed = false;
    const previous = renderTask.current;
    previous?.cancel();
    setBusy(true);
    (async () => {
      if (previous) await previous.promise.catch(() => {});
      const pdfPage = await pdf.current!.getPage(page);
      if (disposed || !canvas.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(2, window.devicePixelRatio || 1);
      const viewport = pdfPage.getViewport({ scale: width / base.width * scale });
      const element = canvas.current;
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      element.style.width = width + "px";
      element.style.height = Math.floor(viewport.height / scale) + "px";
      const task = pdfPage.render({ canvas: element, viewport });
      renderTask.current = task;
      await task.promise;
      if (!disposed) { setBusy(false); setError(""); window.scrollTo(0, 0); }
    })().catch(err => {
      if (!disposed && err?.name !== "RenderingCancelledException") {
        setError("This page could not be displayed. Please select the PDF again in the guide list.");
        setBusy(false);
      }
    });
    return () => { disposed = true; renderTask.current?.cancel(); };
  }, [page, pages, width]);

  return <main className="guide-pdf">
    <style>{`html,body{margin:0;background:#f5f2fb;font-family:Arial,sans-serif}.guide-pdf{text-align:center;color:#291541}.guide-pdf nav{position:sticky;top:0;display:flex;align-items:center;justify-content:center;gap:14px;padding:10px;background:#fff;box-shadow:0 1px 6px #0001;z-index:1}.guide-pdf button{border:0;border-radius:9px;background:#6224d6;color:white;padding:12px;min-height:44px;cursor:pointer}.guide-pdf button:disabled{background:#e4ddec;color:#81758f;cursor:default}.guide-pdf canvas{display:block;margin:12px auto;background:white;max-width:none}.guide-pdf p{padding:12px;line-height:1.5}@media print{.guide-pdf{display:none!important}}`}</style>
    <nav aria-label="PDF pages">
      <button type="button" disabled={!pages || page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
      <span aria-live="polite">{pages ? `${page} / ${pages}` : "Guide PDF"}</span>
      <button type="button" disabled={!pages || page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
    </nav>
    {busy && <p role="status">Opening your guide…</p>}
    {error && <p role="alert">{error}</p>}
    <canvas ref={canvas} aria-label={`Guide page ${page}`} hidden={!!error} />
  </main>;
}
