(() => {
  "use strict";

  function createAtmosphericEngine(atmoCanvas, castCanvas, stageElement) {
    const atmoCtx = atmoCanvas.getContext("2d");
    const castCtx = castCanvas.getContext("2d");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    let width = 0;
    let height = 0;
    let rafId;
    let lastTime = -Infinity;
    let elapsed = 12.4;

    const particles = Array.from({ length: 42 }, (_, i) => ({
      seed: i * 1.371,
      x: ((i * 53 + 17) % 100) / 100,
      y: ((i * 31 + 11) % 100) / 100,
      size: 0.65 + (i % 7) * 0.22,
      speed: 0.025 + (i % 5) * 0.009,
      drift: 0.4 + (i % 4) * 0.25,
      near: i < 5
    }));

    const raindrops = Array.from({ length: 24 }, (_, i) => ({
      seed: i * 2.13,
      paneX: 0.06 + ((i * 37) % 46) / 100,
      paneY: 0.08 + ((i * 23) % 48) / 100,
      radius: 1.6 + (i % 4) * 0.65,
      cycleSpeed: 0.11 + (i % 5) * 0.025
    }));

    const dustMotes = Array.from({ length: 34 }, (_, i) => ({
      x: ((i * 41 + 9) % 100) / 100,
      y: ((i * 67 + 3) % 100) / 100,
      r: 0.8 + (i % 4) * 0.55,
      phase: i * 0.85
    }));

    function windGust(t) {
      const slow = Math.sin(t * 0.42) * 0.6 + Math.sin(t * 0.19 + 1.2) * 0.4;
      const flutter = Math.sin(t * 1.65) * 0.18;
      return slow + flutter;
    }

    function drawPetalPath(ctx, rx, ry) {
      ctx.beginPath();
      ctx.moveTo(0, -ry);
      ctx.bezierCurveTo(rx * 1.15, -ry * 0.65, rx * 1.05, ry * 0.75, 0, ry);
      ctx.bezierCurveTo(-rx * 1.05, ry * 0.75, -rx * 1.15, -ry * 0.65, -rx * 0.18, -ry * 0.92);
      ctx.lineTo(0, -ry * 0.68);
      ctx.closePath();
    }

    function drawMapleLeafPath(ctx, r) {
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.2);
      ctx.lineTo(r * 0.35, -r * 0.45);
      ctx.lineTo(r * 1.1, -r * 0.55);
      ctx.lineTo(r * 0.55, r * 0.05);
      ctx.lineTo(r * 0.85, r * 0.65);
      ctx.lineTo(0, r * 0.38);
      ctx.lineTo(-r * 0.85, r * 0.65);
      ctx.lineTo(-r * 0.55, r * 0.05);
      ctx.lineTo(-r * 1.1, -r * 0.55);
      ctx.lineTo(-r * 0.35, -r * 0.45);
      ctx.closePath();
    }

    function paintGodRays(ctx, t, state) {
      const { godRayAlpha, phase } = state;
      if (godRayAlpha <= 0.02) return;

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const isDusk = phase === "dusk";
      const isDawn = phase === "dawn";
      const baseRGB = isDusk ? "255, 178, 102" : isDawn ? "255, 212, 224" : "255, 244, 214";

      const shafts = [
        { ox: 0.16, oy: -0.04, tx: 0.64, ty: 0.96, w1: 0.07, w2: 0.22, p: 0.0 },
        { ox: 0.28, oy: 0.02, tx: 0.78, ty: 0.98, w1: 0.05, w2: 0.17, p: 1.7 },
        { ox: 0.08, oy: -0.02, tx: 0.48, ty: 0.88, w1: 0.06, w2: 0.19, p: 3.1 },
        { ox: 0.41, oy: 0.06, tx: 0.92, ty: 1.02, w1: 0.04, w2: 0.15, p: 4.5 }
      ];

      for (const s of shafts) {
        const breathe = 0.78 + 0.22 * Math.sin(t * 0.38 + s.p);
        const alpha = godRayAlpha * 0.24 * breathe;
        const sway = Math.sin(t * 0.25 + s.p) * 0.015;

        const x0 = (s.ox + sway) * width;
        const y0 = s.oy * height;
        const x1 = (s.tx + sway * 1.8) * width;
        const y1 = s.ty * height;

        const grad = ctx.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, `rgba(${baseRGB}, ${(alpha * 1.25).toFixed(3)})`);
        grad.addColorStop(0.48, `rgba(${baseRGB}, ${(alpha * 0.75).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${baseRGB}, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(x0 - s.w1 * width * 0.5, y0);
        ctx.lineTo(x0 + s.w1 * width * 0.5, y0);
        ctx.lineTo(x1 + s.w2 * width * 0.5, y1);
        ctx.lineTo(x1 - s.w2 * width * 0.5, y1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    function paintRainOnWindow(ctx, t, state) {
      if (state.weather !== "rain") return;
      const dark = state.night;
      const unit = Math.max(1, width / 1280);

      ctx.save();
      // Distant slanted rain streaks across window & room air
      ctx.lineWidth = 1.1 * unit;
      for (let i = 0; i < 38; i++) {
        const speed = 0.85 + (i % 5) * 0.14;
        const progress = (t * speed + i * 0.29) % 1;
        const rx = (((i * 61 + 13) % 94) / 100) * width - progress * width * 0.09;
        const ry = progress * height * 0.92;
        const len = (24 + (i % 4) * 9) * unit;

        const streakGrad = ctx.createLinearGradient(rx, ry, rx - len * 0.22, ry + len);
        streakGrad.addColorStop(0, "rgba(200, 222, 242, 0)");
        streakGrad.addColorStop(0.5, dark ? "rgba(165, 198, 235, 0.22)" : "rgba(120, 152, 182, 0.24)");
        streakGrad.addColorStop(1, "rgba(200, 222, 242, 0)");

        ctx.strokeStyle = streakGrad;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - len * 0.22, ry + len);
        ctx.stroke();
      }

      // Refractive glass water droplets sliding down
      for (const drop of raindrops) {
        const cycle = (t * drop.cycleSpeed + drop.seed) % 1;
        const slide = Math.max(0, (cycle - 0.35) / 0.65);
        const easeSlide = slide * slide * (3 - 2 * slide);
        const wiggle = Math.sin(t * 2.2 + drop.seed * 4) * 3.5 * unit * slide;

        const dx = drop.paneX * width + wiggle - easeSlide * 14 * unit;
        const dy = (drop.paneY + easeSlide * 0.28) * height;
        const r = drop.radius * unit;
        const ry = r * (1.15 + slide * 0.85);
        const alpha = Math.min(1, cycle * 5, (1 - cycle) * 6);

        // Capillary water trail above sliding droplet
        if (slide > 0.08) {
          const trailLen = easeSlide * 44 * unit;
          const trailGrad = ctx.createLinearGradient(dx, dy - ry - trailLen, dx, dy - ry);
          trailGrad.addColorStop(0, "rgba(225, 240, 255, 0)");
          trailGrad.addColorStop(1, dark ? `rgba(180, 210, 245, ${(0.22 * alpha).toFixed(3)})` : `rgba(255, 255, 255, ${(0.34 * alpha).toFixed(3)})`);
          ctx.strokeStyle = trailGrad;
          ctx.lineWidth = r * 0.65;
          ctx.beginPath();
          ctx.moveTo(dx + 2 * unit, dy - ry - trailLen);
          ctx.quadraticCurveTo(dx - 1.5 * unit, dy - ry - trailLen * 0.45, dx, dy - ry);
          ctx.stroke();
        }

        // Droplet body shadow & refraction
        ctx.fillStyle = dark
          ? `rgba(28, 42, 68, ${(0.36 * alpha).toFixed(3)})`
          : `rgba(145, 172, 196, ${(0.24 * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(dx, dy + 1.2 * unit, r * 1.05, ry * 1.05, -0.1, 0, Math.PI * 2);
        ctx.fill();

        // Droplet inner highlight
        const dGrad = ctx.createRadialGradient(dx - r * 0.3, dy - ry * 0.3, r * 0.1, dx, dy, ry);
        dGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.78 * alpha).toFixed(3)})`);
        dGrad.addColorStop(0.55, dark ? `rgba(176, 208, 245, ${(0.28 * alpha).toFixed(3)})` : `rgba(235, 246, 255, ${(0.36 * alpha).toFixed(3)})`);
        dGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = dGrad;
        ctx.beginPath();
        ctx.ellipse(dx, dy, r, ry, -0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function paintSeasonalParticles(atmo, cast, t, state) {
      const { season, weather, night } = state;
      const unit = Math.max(1, width / 1280);
      const isSnow = weather === "snow" || season === "winter";
      const mode = isSnow ? "snow" : season === "spring" ? "petal" : season === "autumn" ? "leaf" : "firefly";

      for (const p of particles) {
        const targetCtx = p.near ? cast : atmo;
        const speedMul = p.near ? 1.35 : 1.0;
        const phase = (t * p.speed * speedMul + p.seed) % 1;
        const fade = Math.min(1, phase * 7, (1 - phase) * 7);

        if (mode === "firefly") {
          // Summer dust motes by day, glowing fireflies at dusk/night
          const fx = ((p.x + Math.sin(t * 0.35 + p.seed * 3) * 0.08 + 1) % 1) * width;
          const fy = ((p.y - phase * 0.28 + 1) % 1) * height;
          const pulse = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * 1.9 + p.seed * 5), 2);
          const radius = (p.near ? 5.5 : 2.4) * p.size * unit;

          targetCtx.save();
          targetCtx.globalCompositeOperation = "screen";
          const glow = targetCtx.createRadialGradient(fx, fy, 0, fx, fy, radius * 3.2);
          if (night || state.phase === "dusk") {
            glow.addColorStop(0, `rgba(235, 255, 168, ${(0.78 * pulse * fade).toFixed(3)})`);
            glow.addColorStop(0.4, `rgba(162, 238, 124, ${(0.32 * pulse * fade).toFixed(3)})`);
            glow.addColorStop(1, "rgba(162, 238, 124, 0)");
          } else {
            glow.addColorStop(0, `rgba(255, 248, 220, ${(0.52 * pulse * fade).toFixed(3)})`);
            glow.addColorStop(1, "rgba(255, 248, 220, 0)");
          }
          targetCtx.fillStyle = glow;
          targetCtx.beginPath();
          targetCtx.arc(fx, fy, radius * 3.2, 0, Math.PI * 2);
          targetCtx.fill();
          targetCtx.restore();
          continue;
        }

        // Drift from upper-left window tree canopy toward lower-right room & paper
        const gustOffset = Math.sin(t * 0.6 + p.seed * 2) * 0.045 * p.drift;
        const px = ((-0.04 + phase * 0.78 + (p.x - 0.5) * 0.65 + gustOffset + 2) % 1.1 - 0.05) * width;
        const py = (phase * 1.06 - 0.03) * height + Math.cos(t * 0.9 + p.seed) * 12 * unit;

        targetCtx.save();
        targetCtx.translate(px, py);
        const scale = (p.near ? 2.1 : 1.0) * p.size * unit;
        const tumble = Math.cos(t * 1.4 + p.seed * 4);
        targetCtx.rotate(t * 0.65 * p.drift + p.seed * 3);

        if (mode === "snow") {
          const r = 3.2 * scale;
          const snowGrad = targetCtx.createRadialGradient(0, 0, 0, 0, 0, r);
          const alpha = (p.near ? 0.55 : 0.72) * fade;
          snowGrad.addColorStop(0, night ? `rgba(218, 234, 255, ${alpha.toFixed(3)})` : `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
          snowGrad.addColorStop(0.6, night ? `rgba(195, 218, 248, ${(alpha * 0.45).toFixed(3)})` : `rgba(245, 250, 255, ${(alpha * 0.5).toFixed(3)})`);
          snowGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
          targetCtx.fillStyle = snowGrad;
          targetCtx.beginPath();
          targetCtx.arc(0, 0, r, 0, Math.PI * 2);
          targetCtx.fill();
        } else if (mode === "petal") {
          targetCtx.scale(1, Math.max(0.28, Math.abs(tumble)));
          const alpha = (p.near ? 0.48 : 0.78) * fade;
          const pGrad = targetCtx.createLinearGradient(-4 * scale, -5 * scale, 4 * scale, 5 * scale);
          if (night) {
            pGrad.addColorStop(0, `rgba(232, 186, 208, ${alpha.toFixed(3)})`);
            pGrad.addColorStop(1, `rgba(182, 134, 168, ${(alpha * 0.82).toFixed(3)})`);
          } else {
            pGrad.addColorStop(0, `rgba(255, 236, 242, ${alpha.toFixed(3)})`);
            pGrad.addColorStop(1, `rgba(244, 172, 190, ${(alpha * 0.88).toFixed(3)})`);
          }
          targetCtx.fillStyle = pGrad;
          drawPetalPath(targetCtx, 4.4 * scale, 6.2 * scale);
          targetCtx.fill();
        } else if (mode === "leaf") {
          targetCtx.scale(1, Math.max(0.32, Math.abs(tumble)));
          const alpha = (p.near ? 0.46 : 0.76) * fade;
          targetCtx.fillStyle = night
            ? `rgba(168, 92, 64, ${alpha.toFixed(3)})`
            : (p.seed % 2 > 1 ? `rgba(218, 106, 58, ${alpha.toFixed(3)})` : `rgba(228, 156, 62, ${alpha.toFixed(3)})`);
          drawMapleLeafPath(targetCtx, 5.2 * scale);
          targetCtx.fill();
        }
        targetCtx.restore();
      }
    }

    function paintCupSteam(ctx, t) {
      const unit = Math.max(1, width / 1280);
      const baseX = width * 0.115;
      const baseY = height * 0.82;

      ctx.save();
      for (let i = 0; i < 4; i++) {
        const cycle = (t * 0.22 + i * 0.25) % 1;
        const alpha = Math.sin(cycle * Math.PI) * 0.22;
        const sx = baseX + Math.sin(t * 0.9 + i * 1.7 + cycle * 4) * 14 * unit;
        const sy = baseY - cycle * 95 * unit;
        const r = (14 + cycle * 28) * unit;

        const sGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        sGrad.addColorStop(0, `rgba(255, 250, 244, ${alpha.toFixed(3)})`);
        sGrad.addColorStop(1, "rgba(255, 250, 244, 0)");
        ctx.fillStyle = sGrad;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function paintGlobalLightAndGoboCast(ctx, t, state) {
      const { goboAlpha, lamp, night, phase } = state;
      const gust = windGust(t);
      const unit = Math.max(1, width / 1280);

      // 1. Dappled sunlight & swaying tree-bough shadows cast across room & open paper mediums
      if (goboAlpha > 0.04) {
        ctx.save();
        // Warm sun-dapple caustics across room & right-side paper mediums
        ctx.globalCompositeOperation = "soft-light";
        for (let i = 0; i < 9; i++) {
          const cx = width * (0.38 + (i % 3) * 0.22) + Math.sin(t * 0.55 + i * 1.3) * 22 * unit + gust * 14 * unit;
          const cy = height * (0.18 + Math.floor(i / 3) * 0.26) + Math.cos(t * 0.48 + i) * 15 * unit;
          const rx = (68 + (i % 4) * 24) * unit;
          const ry = (42 + (i % 3) * 18) * unit;

          const spot = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
          const tint = phase === "dusk" ? "255, 190, 118" : "255, 248, 226";
          spot.addColorStop(0, `rgba(${tint}, ${(goboAlpha * 0.52).toFixed(3)})`);
          spot.addColorStop(1, `rgba(${tint}, 0)`);
          ctx.fillStyle = spot;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0.35 + gust * 0.08, 0, Math.PI * 2);
          ctx.fill();
        }

        // Soft swaying foliage shadow silhouettes cast on top of paper & stage
        ctx.globalCompositeOperation = "multiply";
        const shadowAlpha = goboAlpha * (night ? 0.16 : 0.14);
        const clusters = [
          { x: 0.22, y: 0.18, r: 105, s: 0.9 },
          { x: 0.56, y: 0.24, r: 110, s: 1.2 },
          { x: 0.78, y: 0.32, r: 95, s: 0.8 },
          { x: 0.64, y: 0.68, r: 100, s: 1.1 },
          { x: 0.88, y: 0.52, r: 90, s: 0.9 }
        ];
        for (const [idx, c] of clusters.entries()) {
          const sx = c.x * width + gust * 18 * c.s * unit + Math.sin(t * 0.8 + idx) * 8 * unit;
          const sy = c.y * height + Math.cos(t * 0.65 + idx) * 6 * unit;
          const sr = c.r * unit;
          const shGrad = ctx.createRadialGradient(sx, sy, sr * 0.1, sx, sy, sr);
          shGrad.addColorStop(0, `rgba(48, 42, 62, ${shadowAlpha.toFixed(3)})`);
          shGrad.addColorStop(0.65, `rgba(48, 42, 62, ${(shadowAlpha * 0.45).toFixed(3)})`);
          shGrad.addColorStop(1, "rgba(48, 42, 62, 0)");
          ctx.fillStyle = shGrad;
          ctx.beginPath();
          ctx.ellipse(sx, sy, sr * 1.25, sr * 0.72, 0.38 + gust * 0.05, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // 2. Warm Brass Desk Lamp radial light pool & illuminated floating dust motes
      if (lamp) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        const breathe = 0.94 + 0.06 * Math.sin(t * 2.1);
        const lx = width * 0.14;
        const ly = height * 0.64;
        const lr = Math.max(width, height) * 0.62;

        const lampPool = ctx.createRadialGradient(lx, ly, lr * 0.02, lx, ly, lr);
        const poolStrength = (night ? 0.34 : 0.18) * breathe;
        lampPool.addColorStop(0, `rgba(255, 198, 118, ${poolStrength.toFixed(3)})`);
        lampPool.addColorStop(0.38, `rgba(255, 166, 84, ${(poolStrength * 0.48).toFixed(3)})`);
        lampPool.addColorStop(1, "rgba(255, 150, 70, 0)");

        ctx.fillStyle = lampPool;
        ctx.fillRect(0, 0, width, height);

        // Warm dust motes drifting through the lamp & window light
        for (const m of dustMotes) {
          const mx = ((m.x + Math.sin(t * 0.18 + m.phase) * 0.03 + 1) % 1) * width;
          const my = ((m.y - (t * 0.008 + m.phase * 0.1) % 1 + 1) % 1) * height;
          const twinkle = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(t * 1.3 + m.phase * 3), 2);
          const mr = m.r * unit * 1.4;
          ctx.fillStyle = `rgba(255, 226, 172, ${(0.28 * twinkle).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(mx, my, mr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    function readStageState() {
      const ds = stageElement.dataset;
      return {
        season: ds.season || "autumn",
        weather: ds.weather || "clear",
        phase: ds.phase || "day",
        night: ds.night === "true",
        lamp: ds.lamp === "true",
        godRayAlpha: Number(stageElement.style.getPropertyValue("--god-ray-alpha")) || 0.5,
        goboAlpha: Number(stageElement.style.getPropertyValue("--gobo-alpha")) || 0.35
      };
    }

    function renderFrame(t) {
      if (!width || !height) return;
      atmoCtx.clearRect(0, 0, width, height);
      castCtx.clearRect(0, 0, width, height);

      const state = readStageState();
      paintGodRays(atmoCtx, t, state);
      paintRainOnWindow(atmoCtx, t, state);
      paintCupSteam(atmoCtx, t);
      paintSeasonalParticles(atmoCtx, castCtx, t, state);
      paintGlobalLightAndGoboCast(castCtx, t, state);

      const gust = reducedMotion.matches ? 0 : windGust(t);
      stageElement.style.setProperty("--wind-sway", gust.toFixed(3));
    }

    function loop(nowMs) {
      if (nowMs - lastTime >= 1000 / 30) {
        if (Number.isFinite(lastTime)) {
          elapsed += Math.min(0.08, (nowMs - lastTime) / 1000);
        }
        lastTime = nowMs;
        renderFrame(elapsed);
      }
      rafId = requestAnimationFrame(loop);
    }

    function refresh() {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = undefined;
      lastTime = -Infinity;
      if (!document.hidden) {
        if (reducedMotion.matches) renderFrame(elapsed);
        else rafId = requestAnimationFrame(loop);
      }
    }

    new ResizeObserver(() => {
      const rect = stageElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
        width = atmoCanvas.width = castCanvas.width = Math.max(1, Math.round(rect.width * dpr));
        height = atmoCanvas.height = castCanvas.height = Math.max(1, Math.round(rect.height * dpr));
        renderFrame(elapsed);
      }
    }).observe(stageElement);

    document.addEventListener("visibilitychange", refresh);
    reducedMotion.addEventListener("change", refresh);

    return {
      refresh,
      redraw: () => renderFrame(elapsed)
    };
  }

  globalThis.createAtmosphericEngine = createAtmosphericEngine;
})();
