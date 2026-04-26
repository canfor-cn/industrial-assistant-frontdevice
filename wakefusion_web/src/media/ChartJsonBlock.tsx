import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ChartJsonShape {
  type: "bar" | "line" | "pie" | string;
  title?: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

interface ChartJsonBlockProps {
  raw: string;
}

const PALETTE = ["#c9a96e", "#5d8aa8", "#7d9b76", "#b3825e", "#9a8aa3", "#5d4032"];

/** Render a `chart-json` code block using Recharts. */
export function ChartJsonBlock({ raw }: ChartJsonBlockProps) {
  const parsed = useMemo<ChartJsonShape | null>(() => {
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (!Array.isArray(obj.columns) || !Array.isArray(obj.rows)) return null;
      return obj as ChartJsonShape;
    } catch {
      return null;
    }
  }, [raw]);

  if (!parsed) {
    return (
      <div className="markdown-chart-error">
        <div className="markdown-chart-error-title">chart-json 解析失败</div>
        <pre>{raw}</pre>
      </div>
    );
  }

  const { type, title, columns, rows } = parsed;

  // Recharts wants array-of-objects; map rows[i][j] using columns[j] as key.
  const data = rows.map((row) => {
    const obj: Record<string, string | number> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i] ?? "";
    }
    return obj;
  });

  const labelKey = columns[0];
  const valueKeys = columns.slice(1);
  const lower = (type || "").toLowerCase();

  return (
    <div className="markdown-chart-block">
      {title ? <div className="markdown-chart-title">{title}</div> : null}
      <ResponsiveContainer width="100%" height={320}>
        {lower === "pie" ? (
          <PieChart>
            <Tooltip />
            <Legend />
            <Pie
              data={data}
              dataKey={valueKeys[0]}
              nameKey={labelKey}
              outerRadius={110}
              label
            >
              {data.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        ) : lower === "line" ? (
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3a4a66" />
            <XAxis dataKey={labelKey} stroke="#c9a96e" />
            <YAxis stroke="#c9a96e" />
            <Tooltip />
            <Legend />
            {valueKeys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                dot
              />
            ))}
          </LineChart>
        ) : (
          // Default + bar
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3a4a66" />
            <XAxis dataKey={labelKey} stroke="#c9a96e" />
            <YAxis stroke="#c9a96e" />
            <Tooltip />
            <Legend />
            {valueKeys.map((k, i) => (
              <Bar key={k} dataKey={k} fill={PALETTE[i % PALETTE.length]} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
