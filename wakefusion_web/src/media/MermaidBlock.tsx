import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    themeVariables: {
      darkMode: true,
      background: "transparent",
      primaryColor: "#0f2440",
      primaryTextColor: "#f5f0e5",
      primaryBorderColor: "#c9a96e",
      lineColor: "#c9a96e",
      secondaryColor: "#143258",
      tertiaryColor: "#0a1f3a",
    },
    fontFamily: '"Source Han Sans CN", "Noto Sans SC", system-ui, sans-serif',
  });
  initialized = true;
}

interface MermaidBlockProps {
  code: string;
}

/**
 * Render a Mermaid diagram into the DOM. Source comes exclusively from our
 * own ingest pipeline (pandoc + VLM with strict prompt + chartClassifier
 * sanitizeMermaid), and Mermaid runs in `securityLevel: "strict"` mode. As a
 * belt-and-suspenders measure we strip <script> blocks and on* attributes
 * from the generated SVG before injection.
 */
export function MermaidBlock({ code }: MermaidBlockProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string>("");
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    ensureInitialized();
    let cancelled = false;
    (async () => {
      try {
        const { svg: rendered } = await mermaid.render(idRef.current, code.trim());
        if (!cancelled) {
          setSvg(sanitizeSvg(rendered));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="markdown-mermaid-error">
        <div className="markdown-mermaid-error-title">Mermaid 渲染失败</div>
        <pre>{error}</pre>
        <pre className="markdown-mermaid-source">{code}</pre>
      </div>
    );
  }

  return (
    <div
      className="markdown-mermaid-block"
      ref={hostRef}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\sjavascript:/gi, " ");
}
