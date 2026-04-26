import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MediaRef } from "./types";
import { stripPlaybackFragment } from "./types";
import { MermaidBlock } from "./MermaidBlock";
import { ChartJsonBlock } from "./ChartJsonBlock";

interface MarkdownTouchViewerProps {
  mediaRef: MediaRef;
  onReady: () => void;
  onInteraction: () => void;
}

/**
 * Touch-first markdown viewer for wiki entries.
 *
 * Fetches `mediaRef.url` (expected to return text/markdown from
 * `GET /rag/wiki/:slug`), renders with react-markdown + remark-gfm, and
 * handles `mermaid` / `chart-json` fenced code blocks natively. A side TOC is
 * built from `##` headings; tap to scroll into view. Touch scrolling fires
 * `onInteraction` so MediaPresenter's 60s inactivity timeout can reset.
 */
export function MarkdownTouchViewer({
  mediaRef,
  onReady,
  onInteraction,
}: MarkdownTouchViewerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const readyFiredRef = useRef(false);

  const fetchUrl = stripPlaybackFragment(mediaRef.url);

  useEffect(() => {
    let cancelled = false;
    setMarkdown("");
    setError(null);
    setLoaded(false);
    readyFiredRef.current = false;

    (async () => {
      try {
        const res = await fetch(fetchUrl, {
          headers: { accept: "text/markdown,text/plain" },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        if (cancelled) return;
        setMarkdown(text);
        setLoaded(true);
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          onReady();
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
        if (!readyFiredRef.current) {
          readyFiredRef.current = true;
          onReady();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchUrl, onReady]);

  const toc = useMemo(() => {
    const lines = markdown.split("\n");
    const out: { id: string; title: string }[] = [];
    let inFence = false;
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m) {
        const title = m[1].trim();
        const id = sanitizeAnchor(title);
        out.push({ id, title });
      }
    }
    return out;
  }, [markdown]);

  const handleScroll = useCallback(() => {
    onInteraction();
  }, [onInteraction]);

  const scrollToHeading = useCallback(
    (id: string) => {
      onInteraction();
      const el = articleRef.current?.querySelector(`#${CSS.escape(id)}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [onInteraction],
  );

  const components = useMemo(
    () => ({
      h2: (props: { children?: React.ReactNode }) => {
        const text = flattenChildren(props.children);
        const id = sanitizeAnchor(text);
        return (
          <h2 id={id} className="markdown-h2">
            {props.children}
          </h2>
        );
      },
      code: (props: {
        inline?: boolean;
        className?: string;
        children?: React.ReactNode;
      }) => {
        const { inline, className, children } = props;
        const langMatch = /language-([\w-]+)/.exec(className || "");
        const lang = langMatch?.[1]?.toLowerCase();
        const code = String(flattenChildren(children) ?? "").replace(/\n$/, "");

        if (!inline && lang === "mermaid") {
          return <MermaidBlock code={code} />;
        }
        if (!inline && lang === "chart-json") {
          return <ChartJsonBlock raw={code} />;
        }
        return <code className={className}>{children}</code>;
      },
    }),
    [],
  );

  return (
    <div
      ref={wrapperRef}
      className="stage-md-viewer"
      onScroll={handleScroll}
      onWheel={onInteraction}
      onTouchStart={onInteraction}
    >
      <header className="stage-md-header">
        <div className="stage-md-title">{mediaRef.label || "图文资料"}</div>
      </header>

      <div className="stage-md-layout">
        {toc.length > 0 ? (
          <nav className="stage-md-toc">
            <div className="stage-md-toc-title">目录</div>
            <ul>
              {toc.map((t) => (
                <li key={t.id}>
                  <button onClick={() => scrollToHeading(t.id)}>{t.title}</button>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <article ref={articleRef} className="stage-md-article">
          {!loaded ? (
            <div className="stage-md-loading">加载中…</div>
          ) : error ? (
            <div className="stage-md-error">
              资料加载失败：{error}
              <pre className="stage-md-error-url">{fetchUrl}</pre>
            </div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {markdown}
            </ReactMarkdown>
          )}
        </article>
      </div>
    </div>
  );
}

function flattenChildren(children: React.ReactNode): string {
  if (children == null) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flattenChildren).join("");
  if (typeof children === "object" && "props" in (children as object)) {
    return flattenChildren((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

function sanitizeAnchor(s: string): string {
  return (
    "h2-" +
    s
      .toLowerCase()
      .replace(/[\s　]+/g, "-")
      .replace(/[^\w一-鿿-]+/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
  );
}
