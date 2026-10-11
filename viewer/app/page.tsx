"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Report = {
  report_id: string;
  report_date: string;
  run_id: string;
  attempt: number;
  code_sha: string;
  data_through: string | null;
  report_status: "limited" | "complete";
};
type Catalog = { latest: Report | null; reports: Report[] };
type OpenReport = { metadata: Report; html: string };
type LoadError = "unavailable" | "missing" | "invalid";

const REPORT_ID = /^20\d{2}-\d{2}-\d{2}\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}-[1-9][0-9]{0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRAME_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReport(value: unknown): value is Report {
  if (!isRecord(value)) return false;
  return (
    typeof value.report_id === "string" && REPORT_ID.test(value.report_id) &&
    typeof value.report_date === "string" && DATE.test(value.report_date) &&
    typeof value.run_id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.run_id) &&
    typeof value.attempt === "number" && Number.isSafeInteger(value.attempt) && value.attempt > 0 && value.attempt <= 1000 &&
    value.report_id === `${value.report_date}/${value.run_id}-${value.attempt}` &&
    typeof value.code_sha === "string" && /^[a-f0-9]{40}$/.test(value.code_sha) &&
    (value.data_through === null || (typeof value.data_through === "string" && DATE.test(value.data_through))) &&
    (value.report_status === "limited" || value.report_status === "complete")
  );
}

function readCatalog(value: unknown): Catalog {
  if (!isRecord(value) || !Array.isArray(value.reports) ||
      !value.reports.every(isReport) || !(value.latest === null || isReport(value.latest))) {
    throw new Error("invalid");
  }
  const reports = value.reports as Report[];
  if (new Set(reports.map((report) => report.report_id)).size !== reports.length) {
    throw new Error("invalid");
  }
  return { latest: value.latest as Report | null, reports };
}

function currentSelection(): string | null {
  const report = new URL(window.location.href).searchParams.get("r");
  return report && REPORT_ID.test(report) ? report : null;
}

function reportPath(report: Report): string {
  return `/reports/${report.report_id}`;
}

function dateLabel(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

function sandboxDocument(html: string): string {
  if (!/<html[\s>]/i.test(html) || !/<head[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    throw new Error("invalid");
  }
  const policy = `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><meta name="referrer" content="no-referrer">`;
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
}

function Icon({ name, spinning = false }: { name: "refresh" | "open" | "download" | "document"; spinning?: boolean }) {
  const paths = {
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.55-1.3L20 8M4 16l2.35 2.3A7 7 0 0 0 17.9 17" /></>,
    open: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5" /></>,
    document: <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></>,
  };
  return <svg className={spinning ? "icon spinning" : "icon"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  const loadReport = useCallback(async (requested: string | null, updateUrl = false) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort("timeout"), 30000);
    setBusy(true);
    setError(null);
    setSelection(requested);

    if (updateUrl) {
      const url = new URL(window.location.href);
      if (requested) url.searchParams.set("r", requested);
      else url.searchParams.delete("r");
      window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }

    try {
      const options: RequestInit = { signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error" };
      const response = await fetch("/api/reports", { ...options, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("unavailable");
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error("invalid"); }
      const nextCatalog = readCatalog(payload);
      if (controller.signal.aborted) return;
      setCatalog((previous) => previous ?? nextCatalog);
      const selected = requested
        ? [nextCatalog.latest, ...nextCatalog.reports].find((report) => report?.report_id === requested)
        : nextCatalog.latest ?? nextCatalog.reports[0] ?? null;
      if (requested && !selected) throw new Error("missing");

      let nextReport: OpenReport | null = null;
      if (selected) {
        const htmlResponse = await fetch(reportPath(selected), { ...options, headers: { Accept: "text/html" } });
        if (!htmlResponse.ok) throw new Error(htmlResponse.status === 404 ? "missing" : "unavailable");
        if (!htmlResponse.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error("invalid");
        nextReport = { metadata: selected, html: sandboxDocument(await htmlResponse.text()) };
      }
      if (controller.signal.aborted) return;
      setCatalog(nextCatalog);
      setOpened(nextReport);
      setCheckedAt(new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date()));
    } catch (cause: unknown) {
      if (controller.signal.aborted && controller.signal.reason !== "timeout") return;
      const code = cause instanceof Error ? cause.message : "unavailable";
      setError(code === "missing" || code === "invalid" ? code : "unavailable");
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadReport(currentSelection());
    const onHistoryChange = () => { void loadReport(currentSelection()); };
    window.addEventListener("popstate", onHistoryChange);
    return () => {
      activeRequest.current?.abort();
      window.removeEventListener("popstate", onHistoryChange);
    };
  }, [loadReport]);

  const report = opened?.metadata;
  const latest = catalog?.latest ?? catalog?.reports[0];
  const selectionExists = !selection || catalog?.reports.some((entry) => entry.report_id === selection) || catalog?.latest?.report_id === selection;
  const history = catalog?.reports ?? [];
  const errorDetail = error === "missing"
    ? "所选报告暂时无法打开。可以重试，或切换其他日期。"
    : error === "invalid"
      ? "报告内容未能完整读取，请稍后重试。"
      : "暂时无法读取报告，请检查连接后重试。";

  return (
    <main className="viewer">
      <header className="site-header">
        <div className="brand"><span className="brand-name">NocoBase</span><span className="brand-divider" aria-hidden="true">/</span><h1>增长报告</h1></div>
        <span className="private-label"><span aria-hidden="true" />私有报告</span>
      </header>

      <section className="reader-toolbar" aria-label="报告浏览工具">
        <div className="report-picker">
          <label htmlFor="report-date">报告日期</label>
          <select id="report-date" value={selection ?? ""} disabled={!catalog || (history.length === 0 && !latest)} onChange={(event) => { void loadReport(event.target.value || null, true); }}>
            <option value="">{latest ? `最新 · ${latest.report_date}` : "最新报告"}</option>
            {!selectionExists && selection && <option value={selection}>所选报告暂不可用</option>}
            {catalog?.latest && !history.some((entry) => entry.report_id === catalog.latest?.report_id) && <option value={catalog.latest.report_id}>{catalog.latest.report_date} · 最新</option>}
            {history.map((entry) => {
              const sameDay = history.filter((item) => item.report_date === entry.report_date);
              const sequence = sameDay.length - sameDay.findIndex((item) => item.report_id === entry.report_id);
              return <option key={entry.report_id} value={entry.report_id}>{entry.report_date}{sameDay.length > 1 ? ` · 第 ${sequence} 份` : ""}{entry.report_status === "limited" ? " · 页面巡检" : " · 增长报告"}</option>;
            })}
          </select>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="action-button" disabled={busy} onClick={() => { void loadReport(selection); }}><Icon name="refresh" spinning={busy} /><span>{busy ? "读取中" : "刷新"}</span></button>
          {report && <><a className="action-button" href={reportPath(report)} target="_blank" rel="noopener noreferrer"><Icon name="open" /><span>打开完整报告</span></a><a className="action-button" href={`${reportPath(report)}?download=1`} download><Icon name="download" /><span>下载</span></a></>}
        </div>
      </section>

      {error && <div className="notice notice-error" role="alert"><div><strong>{opened ? "未更新" : "报告读取失败"}</strong><span>{errorDetail}{opened ? " 当前仍显示上次成功打开的报告。" : ""}</span></div><button type="button" className="notice-retry" onClick={() => { void loadReport(selection); }}>重试</button></div>}

      {opened && <section className="report-reader" aria-label="当前报告">
        <div className="report-context">
          <div className="report-caption"><h2>{dateLabel(opened.metadata.report_date)}</h2><span className={`report-badge ${opened.metadata.report_status === "limited" ? "limited" : "complete"}`}>{opened.metadata.report_status === "limited" ? "页面巡检 / 数据受限" : "增长报告"}</span>{opened.metadata.data_through && <span className="data-through">搜索数据截至 {opened.metadata.data_through}</span>}</div>
          <span className="sync-status" role="status" aria-live="polite">{busy ? "正在读取，当前报告仍可阅读" : error ? "尚未更新" : checkedAt ? `${checkedAt} 已刷新` : ""}</span>
        </div>
        <iframe className="report-frame" title={`${opened.metadata.report_date} NocoBase 增长报告`} srcDoc={opened.html} sandbox="allow-popups" referrerPolicy="no-referrer" />
      </section>}

      {!opened && <section className="empty-state" aria-live="polite" aria-busy={busy}>
        <span className={`empty-icon${busy ? " loading-icon" : ""}`}><Icon name={busy ? "refresh" : "document"} spinning={busy} /></span>
        <h2>{busy ? "正在打开报告" : error ? "暂时无法显示报告" : "还没有可阅读的报告"}</h2>
        <p>{busy ? "正在读取最新日报，请稍候。" : error ? "请重试，或稍后重新打开此页面。" : "首份日报生成后会显示在这里。"}</p>
        {!busy && <button type="button" className="primary-button" onClick={() => { void loadReport(selection); }}><Icon name="refresh" />{error ? "重新读取" : "检查更新"}</button>}
      </section>}
    </main>
  );
}
