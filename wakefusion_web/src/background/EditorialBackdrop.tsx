import React from "react";

/**
 * 中文时尚杂志风背景 — 纯 CSS，零状态。
 *
 * 灵感来自《Vogue 中国版》《嘉人 Marie Claire》《T Magazine 中文版》
 * 大字号宋体水印 + 中英混排刊头 + 印章感装饰 + 极细栅格。
 *
 * 元素层级：
 *   ① 米白纸张渐变（base）
 *   ② 96px 极细栅格（mask 渐隐到边缘）
 *   ③ 顶部刊头：HD logo + 曜曜慧道 + 期号（中英混排）
 *   ④ 左侧竖排："曜曜慧道科技"6 字宋体大水印（不透明 6%）
 *   ⑤ 右侧竖排："THE · GUIDE" 斜体衬线水印
 *   ⑥ 中央对角薄裸字"导赏"作为艺术留白点缀
 *   ⑦ 底部刊头：编号 + 中文副标 + 红章
 *   ⑧ 媒体播放时整层 dim
 */
export function EditorialBackdrop({ dimmed }: { dimmed: boolean }) {
  return (
    <div
      className={`editorial-backdrop ${dimmed ? "is-dimmed" : ""}`}
      aria-hidden="true"
    >
      <div className="editorial-grid" />

      <header className="editorial-masthead-top">
        <div className="masthead-cluster masthead-cluster--left">
          <span className="hd-logo">
            <span className="hd-logo-mark">HD</span>
            <span className="hd-logo-rule" />
          </span>
          <span className="masthead-cn">曜曜慧道</span>
          <span className="masthead-en-meta">YAOYAO&nbsp;HUIDAO</span>
        </div>
        <div className="masthead-cluster masthead-cluster--right">
          <span>二〇二六</span>
          <span className="masthead-rule" />
          <span>春&nbsp;卷</span>
          <span className="masthead-rule" />
          <span>第&nbsp;〇&nbsp;四&nbsp;期</span>
        </div>
      </header>

      <div className="editorial-watermark editorial-watermark--cn">
        {Array.from("曜曜慧道科技").map((ch, i) => (
          <span key={i} className="editorial-watermark-char" style={{ animationDelay: `${i * 80}ms` }}>
            {ch}
          </span>
        ))}
      </div>

      <div className="editorial-watermark editorial-watermark--en">
        <span>T</span><span>H</span><span>E</span>
        <span className="editorial-watermark-spacer" />
        <span>G</span><span>U</span><span>I</span><span>D</span><span>E</span>
      </div>

      <div className="editorial-pull-quote">
        <span className="editorial-pull-quote-mark">「</span>
        <span className="editorial-pull-quote-body">导&nbsp;赏</span>
        <span className="editorial-pull-quote-mark">」</span>
      </div>

      <footer className="editorial-masthead-bottom">
        <span className="masthead-mono">№&nbsp;04</span>
        <span className="masthead-rule" />
        <span className="masthead-cn-sub">成都&nbsp;·&nbsp;数字讲解员&nbsp;·&nbsp;A&nbsp;CONVERSATIONAL&nbsp;EDITORIAL</span>
        <span className="masthead-rule" />
        <span className="editorial-stamp">
          <span className="editorial-stamp-char">耀</span>
        </span>
      </footer>
    </div>
  );
}
