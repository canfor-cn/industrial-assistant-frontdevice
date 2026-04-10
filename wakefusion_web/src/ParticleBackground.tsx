/**
 * WebGPU particle field background.
 * Renders a full-screen procedural particle animation via a fragment shader.
 * Falls back to Canvas2D if WebGPU is unavailable.
 *
 * Props:
 *   dimmed — when true, particles fade out (media overlay mode)
 */

import { useEffect, useRef, useState } from "react";

// ── WGSL shader: procedural particle field ──────────────────────────
const SHADER_CODE = /* wgsl */ `
struct Uniforms {
  time: f32,
  aspect: f32,
  opacity: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  // full-screen triangle
  var p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  var out: VSOut;
  out.pos = vec4f(p[i], 0, 1);
  out.uv = p[i] * 0.5 + 0.5;
  return out;
}

// ---- hash helpers ----
fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn hash22(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = u.time;

  // coordinate system: aspect-corrected, centered
  var st = uv;
  st.x = st.x * u.aspect;

  // ---- dark base with subtle gradient ----
  let grad = mix(
    vec3f(1.0, 1.0, 1.0),      // white top
    vec3f(0.96, 0.97, 0.98),   // light gray bottom
    uv.y
  );

  // subtle radial vignette
  let center = vec2f(0.5 * u.aspect, 0.5);
  let vignette = 1.0 - smoothstep(0.3, 1.2, length(st - center) / (u.aspect * 0.5));

  var col = grad - vec3f(0.005, 0.008, 0.012) * vignette;

  // ---- particle layers ----
  let ACCENT = vec3f(0.55, 0.62, 0.68);      // soft slate
  let ACCENT2 = vec3f(0.45, 0.55, 0.72);     // muted blue
  let ACCENT3 = vec3f(0.50, 0.65, 0.60);     // sage green

  // Layer 1: large slow particles (background depth)
  for (var i = 0u; i < 40u; i = i + 1u) {
    let seed = hash22(vec2f(f32(i) * 1.17, f32(i) * 2.31));
    var pp = vec2f(seed.x * u.aspect, seed.y);
    // slow drift
    pp.x = pp.x + sin(t * 0.08 + seed.y * 6.28) * 0.06;
    pp.y = pp.y + cos(t * 0.06 + seed.x * 6.28) * 0.04;
    // wrap
    pp = fract(pp / vec2f(u.aspect, 1.0)) * vec2f(u.aspect, 1.0);

    let d = length(st - pp);
    let size = 0.002 + seed.x * 0.003;
    let brightness = smoothstep(size * 3.0, size * 0.3, d) * (0.15 + seed.y * 0.1);
    let glow = smoothstep(size * 12.0, size * 1.0, d) * 0.03;
    let c = mix(ACCENT, ACCENT2, seed.x);
    col = col - c * (brightness + glow);
  }

  // Layer 2: medium particles (mid depth)
  for (var i = 0u; i < 60u; i = i + 1u) {
    let seed = hash22(vec2f(f32(i) * 3.71 + 100.0, f32(i) * 1.93 + 50.0));
    var pp = vec2f(seed.x * u.aspect, seed.y);
    pp.x = pp.x + sin(t * 0.15 + seed.y * 6.28) * 0.03;
    pp.y = pp.y + cos(t * 0.12 + seed.x * 6.28) * 0.025;
    pp.y = fract(pp.y + t * 0.008 * (0.5 + seed.x));
    pp.x = fract(pp.x / u.aspect) * u.aspect;

    let d = length(st - pp);
    let size = 0.001 + seed.y * 0.0015;
    let brightness = smoothstep(size * 2.5, size * 0.2, d) * (0.25 + seed.x * 0.15);
    let glow = smoothstep(size * 8.0, size * 0.8, d) * 0.02;
    let c = mix(ACCENT3, ACCENT, seed.y);
    col = col - c * (brightness + glow);
  }

  // Layer 3: tiny sparkle particles (foreground)
  for (var i = 0u; i < 30u; i = i + 1u) {
    let seed = hash22(vec2f(f32(i) * 7.13 + 200.0, f32(i) * 4.57 + 300.0));
    var pp = vec2f(seed.x * u.aspect, seed.y);
    pp.x = pp.x + sin(t * 0.25 + seed.y * 12.56) * 0.015;
    pp.y = fract(pp.y + t * 0.015 * (0.3 + seed.y));
    pp.x = fract(pp.x / u.aspect) * u.aspect;

    // twinkle
    let twinkle = 0.5 + 0.5 * sin(t * (1.5 + seed.x * 2.0) + seed.y * 6.28);

    let d = length(st - pp);
    let size = 0.0006 + seed.x * 0.0008;
    let brightness = smoothstep(size * 2.0, 0.0, d) * twinkle * 0.5;
    col = col - vec3f(0.15, 0.18, 0.22) * brightness;
  }

  // ---- subtle connection lines between nearby large particles ----
  for (var i = 0u; i < 20u; i = i + 1u) {
    let seed_a = hash22(vec2f(f32(i) * 1.17, f32(i) * 2.31));
    var pa = vec2f(seed_a.x * u.aspect, seed_a.y);
    pa.x = pa.x + sin(t * 0.08 + seed_a.y * 6.28) * 0.06;
    pa.y = pa.y + cos(t * 0.06 + seed_a.x * 6.28) * 0.04;
    pa = fract(pa / vec2f(u.aspect, 1.0)) * vec2f(u.aspect, 1.0);

    let j = (i + 1u) % 40u;
    let seed_b = hash22(vec2f(f32(j) * 1.17, f32(j) * 2.31));
    var pb = vec2f(seed_b.x * u.aspect, seed_b.y);
    pb.x = pb.x + sin(t * 0.08 + seed_b.y * 6.28) * 0.06;
    pb.y = pb.y + cos(t * 0.06 + seed_b.x * 6.28) * 0.04;
    pb = fract(pb / vec2f(u.aspect, 1.0)) * vec2f(u.aspect, 1.0);

    let dist = length(pa - pb);
    if dist < 0.25 {
      // distance from point to line segment
      let ab = pb - pa;
      let ap = st - pa;
      let h = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
      let d = length(ap - ab * h);
      let line_alpha = smoothstep(0.002, 0.0003, d) * (1.0 - dist / 0.25) * 0.06;
      col = col - ACCENT * line_alpha;
    }
  }

  // apply global opacity (for dimming) — lerp toward white when dimmed
  let final_col = mix(vec3f(1.0, 1.0, 1.0), col, u.opacity);
  return vec4f(final_col, 1.0);
}
`;

// ── Canvas2D fallback ───────────────────────────────────────────────
function useFallbackCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  dimmed: boolean,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const particles: { x: number; y: number; vx: number; vy: number; r: number; a: number }[] = [];
    for (let i = 0; i < 80; i++) {
      particles.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.0003,
        vy: (Math.random() - 0.5) * 0.0002 + 0.00005,
        r: 1 + Math.random() * 2,
        a: 0.2 + Math.random() * 0.4,
      });
    }

    const resize = () => {
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      const opacity = dimmed ? 0.06 : 1;

      ctx.fillStyle = `rgba(255,255,255,${opacity})`;
      ctx.fillRect(0, 0, w, h);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x += 1;
        if (p.x > 1) p.x -= 1;
        if (p.y < 0) p.y += 1;
        if (p.y > 1) p.y -= 1;

        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.r * devicePixelRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(120,145,160,${p.a * opacity})`;
        ctx.fill();
      }

      // connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < Math.min(i + 5, particles.length); j++) {
          const dx = (particles[i].x - particles[j].x) * w;
          const dy = (particles[i].y - particles[j].y) * h;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120 * devicePixelRatio) {
            const alpha = (1 - dist / (120 * devicePixelRatio)) * 0.08 * opacity;
            ctx.strokeStyle = `rgba(120,145,160,${alpha})`;
            ctx.lineWidth = 0.5 * devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(particles[i].x * w, particles[i].y * h);
            ctx.lineTo(particles[j].x * w, particles[j].y * h);
            ctx.stroke();
          }
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef, dimmed, enabled]);
}

// ── WebGPU renderer ─────────────────────────────────────────────────
async function initWebGPU(canvas: HTMLCanvasElement) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;

  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });

  const module = device.createShaderModule({ code: SHADER_CODE });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });

  return { device, ctx, pipeline, bindGroup, uniformBuf, format };
}

// ── Component ───────────────────────────────────────────────────────
export function ParticleBackground({ dimmed = false }: { dimmed?: boolean }) {
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"detecting" | "webgpu" | "canvas2d">("detecting");

  // target opacity for smooth transition
  const opacityRef = useRef(1);
  const targetOpacityRef = useRef(1);

  useEffect(() => {
    targetOpacityRef.current = dimmed ? 0.06 : 1;
  }, [dimmed]);

  // Try WebGPU
  useEffect(() => {
    const canvas = gpuCanvasRef.current;
    if (!canvas) return;

    let destroyed = false;
    let raf = 0;

    (async () => {
      const gpu = await initWebGPU(canvas);
      if (destroyed) {
        gpu?.device.destroy();
        return;
      }
      if (!gpu) {
        setMode("canvas2d");
        return;
      }
      setMode("webgpu");

      const startTime = performance.now() / 1000;
      const uniformData = new Float32Array(4);

      const resize = () => {
        const dpr = devicePixelRatio;
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
        gpu.ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
      };
      resize();
      window.addEventListener("resize", resize);

      const frame = () => {
        if (destroyed) return;

        // smooth opacity lerp
        opacityRef.current += (targetOpacityRef.current - opacityRef.current) * 0.04;

        uniformData[0] = performance.now() / 1000 - startTime;
        uniformData[1] = canvas.width / canvas.height;
        uniformData[2] = opacityRef.current;
        uniformData[3] = 0;
        gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, uniformData);

        const encoder = gpu.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: gpu.ctx.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 1, g: 1, b: 1, a: 1 },
          }],
        });
        pass.setPipeline(gpu.pipeline);
        pass.setBindGroup(0, gpu.bindGroup);
        pass.draw(3);
        pass.end();
        gpu.device.queue.submit([encoder.finish()]);

        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      // cleanup stored for destroy
      (canvas as any).__gpuCleanup = () => {
        window.removeEventListener("resize", resize);
        gpu.device.destroy();
      };
    })();

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      (canvas as any).__gpuCleanup?.();
    };
  }, []);

  // Canvas2D fallback — only runs when WebGPU unavailable
  useFallbackCanvas(fallbackCanvasRef, dimmed, mode === "canvas2d");

  const style: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    zIndex: -1,
    display: "block",
  };

  return (
    <>
      <canvas
        ref={gpuCanvasRef}
        style={{ ...style, display: mode === "canvas2d" ? "none" : "block" }}
      />
      {mode === "canvas2d" && (
        <canvas ref={fallbackCanvasRef} style={style} />
      )}
    </>
  );
}
