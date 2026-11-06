(() => {
  "use strict";

  function createWindowEffects(canvas, room, anchors, currentLayer) {
    const ctx = canvas.getContext("2d");
    const branch = document.createElement("canvas");
    const branchCtx = branch.getContext("2d");
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const [windowX, windowY, windowWidth, windowHeight] = anchors.window;
    let width = 0;
    let height = 0;
    let frame;
    let last = -Infinity;
    let elapsed = 0;

    function scalePane([x, y, w, h]) {
      return [(x - windowX) / windowWidth * width, (y - windowY) / windowHeight * height,
        w / windowWidth * width, h / windowHeight * height];
    }

    function sample(image, x, y, w, h, target, dx, dy, dw, dh) {
      if (!image?.naturalWidth || w <= 0 || h <= 0) return;
      const sx = (windowX + x / width * windowWidth) / 100 * image.naturalWidth;
      const sy = (windowY + y / height * windowHeight) / 100 * image.naturalHeight;
      const sw = w / width * windowWidth / 100 * image.naturalWidth;
      const sh = h / height * windowHeight / 100 * image.naturalHeight;
      target.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    function gust(seconds) {
      const breath = Math.max(0, Math.sin(seconds * .33 - .6));
      return breath * breath * Math.sin(seconds * 1.13);
    }

    function paintBranch(source, alternate, mix, pane, seconds) {
      const [x, y, w, h] = pane;
      const bandW = Math.floor(w * .94);
      const bandH = Math.floor(h * .48);
      if (bandW < 8 || bandH < 8) return;
      if (branch.width !== bandW || branch.height !== bandH) {
        branch.width = bandW;
        branch.height = bandH;
      }
      branchCtx.clearRect(0, 0, bandW, bandH);
      const origin = x + w * .03;
      for (let row = 0; row < bandH; row += 3) {
        const stripHeight = Math.min(3, bandH - row);
        const offset = gust(seconds - row / bandH * .55) * width * .007
          * Math.sin(Math.PI * row / bandH);
        sample(source, origin + offset, y + row, bandW, stripHeight, branchCtx, 0, row, bandW, stripHeight);
        if (mix > 0) {
          branchCtx.globalAlpha = mix;
          sample(alternate, origin + offset, y + row, bandW, stripHeight, branchCtx, 0, row, bandW, stripHeight);
          branchCtx.globalAlpha = 1;
        }
      }
      branchCtx.globalCompositeOperation = "destination-in";
      for (const [ax, ay, bx, by] of [[0, 0, bandW, 0], [0, 0, 0, bandH]]) {
        const mask = branchCtx.createLinearGradient(ax, ay, bx, by);
        mask.addColorStop(0, "transparent");
        mask.addColorStop(.14, "black");
        mask.addColorStop(.72, "black");
        mask.addColorStop(1, "transparent");
        branchCtx.fillStyle = mask;
        branchCtx.fillRect(0, 0, bandW, bandH);
      }
      branchCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(branch, origin, y);
    }

    function paintReflection(x, y, w, h, lit, night) {
      const reflection = ctx.createLinearGradient(x + w * .9, y, x + w * .15, y + h * .42);
      reflection.addColorStop(0, night && lit ? "rgba(255,186,123,.11)" : "rgba(222,237,246,.052)");
      reflection.addColorStop(.54, "rgba(203,220,231,.008)");
      reflection.addColorStop(1, "rgba(197,217,235,0)");
      ctx.fillStyle = reflection;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = night ? "rgba(192,217,237,.12)" : "rgba(255,249,225,.15)";
      ctx.fillRect(x + w - Math.max(.65, width * .002), y, Math.max(.55, width * .0017), h);
    }

    function paintRain(pane, source, seconds, dark) {
      const [x, y, w, h] = pane;
      const unit = width / 420;
      for (let i = 0; i < 15; i++) {
        const phase = (seconds * (.13 + i % 4 * .02) + i * .47) % 1;
        const left = x + w * (.05 + ((i * 37) % 87) / 100);
        const top = y + phase * h * .68;
        ctx.strokeStyle = dark ? "rgba(150,177,207,.10)" : "rgba(85,113,130,.12)";
        ctx.lineWidth = Math.max(.5, unit * .55);
        ctx.beginPath();
        ctx.moveTo(left, top);
        ctx.lineTo(left - unit * 2, top + unit * (4 + i % 3 * 2));
        ctx.stroke();
      }
      for (let i = 0; i < 9; i++) {
        const cycle = (seconds / (7.5 + i % 4 * 1.6) + i * .68) % 1;
        const slide = Math.max(0, (cycle - .56) / .44);
        const left = x + w * (.12 + ((i * 29) % 71) / 100) + slide * unit * 1.8;
        const top = y + h * (.09 + ((i * 17) % 32) / 100 + slide ** 2 * .26);
        const radius = (1.45 + i % 4 * .54) * unit;
        const stretch = radius * (1.15 + slide * 1.15);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(left, top, radius, stretch, -.16, 0, Math.PI * 2);
        ctx.clip();
        sample(source, left - radius * 1.75, top - stretch * 1.5, radius * 3.5, stretch * 3,
          ctx, left - radius, top - stretch, radius * 2, stretch * 2);
        ctx.fillStyle = dark ? "rgba(159,188,218,.18)" : "rgba(220,236,241,.28)";
        ctx.fillRect(left - radius, top - stretch, radius * 2, stretch * 2);
        ctx.restore();
        ctx.beginPath();
        ctx.ellipse(left - radius * .3, top - stretch * .18, radius * .73, stretch * .72, -.16, 3.45, 5.3);
        ctx.strokeStyle = "rgba(245,249,252,.53)";
        ctx.lineWidth = Math.max(.5, unit * .65);
        ctx.stroke();
        if (slide > .14) {
          ctx.beginPath();
          ctx.moveTo(left - unit * 1.2, top - stretch - slide * 24 * unit);
          ctx.quadraticCurveTo(left + unit, top - stretch - slide * 12 * unit, left, top - stretch);
          ctx.strokeStyle = "rgba(200,219,230,.27)";
          ctx.stroke();
        }
      }
    }

    function paintFlakes(pane, seconds, weather, dark) {
      const [x, y, w, h] = pane;
      const snow = weather === "snow";
      const count = snow ? 37 : 6;
      const unit = width / 420;
      for (let i = 0; i < count; i++) {
        const near = i % 3 === 0;
        const speed = near ? .095 : .037 + i % 4 * .008;
        const phase = (seconds * speed + i * .317) % 1;
        const horizontal = ((i * 43) % 97) / 100 + Math.sin(seconds * .7 + i * 2) * (near ? .045 : .022);
        const left = x + w * horizontal;
        const top = y + h * phase * .73;
        const radius = unit * (near ? 1.38 + i % 4 * .24 : .55 + i % 5 * .115);
        ctx.fillStyle = snow ? (dark ? "#c7daec" : "#fbfbf2") : (weather === "leaf" ? "#a87b4f" : "#ecc2bc");
        ctx.globalAlpha = Math.min(1, phase * 8, (1 - phase) * 8) * (near ? .64 : .36);
        ctx.beginPath();
        ctx.ellipse(left, top, radius, radius * (snow ? .68 : 1.45), seconds + i, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function render(seconds) {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const layer = currentLayer();
      const source = layer.querySelector(".plate-base");
      const alternate = layer.querySelector(".plate-next");
      const mix = Number(layer.style.getPropertyValue("--phase-mix")) || 0;
      const { season, weather, phase, lamp } = room.dataset;
      const dark = phase === "night";
      for (const [index, bounds] of anchors.panes.entries()) {
        const pane = scalePane(bounds);
        const [x, y, w, h] = pane;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        if (!motion.matches && index === 0 && weather !== "snow") paintBranch(source, alternate, mix, pane, seconds);
        paintReflection(...pane, lamp === "true", dark);
        // Near flowers and the sill sit in front of the glass.
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w, y + h * .70);
        ctx.lineTo(x, y + h * (index === 0 ? .87 : .66));
        ctx.closePath();
        ctx.clip();
        if (weather === "rain") paintRain(pane, source, seconds, dark);
        else if (!motion.matches && (weather === "snow" || season === "spring" || season === "autumn")) {
          paintFlakes(pane, seconds, weather === "snow" ? weather : season === "autumn" ? "leaf" : "petal", dark);
        }
        ctx.restore();
      }
      const movement = weather === "clear" && !dark && !motion.matches ? gust(seconds - .28) : 0;
      room.style.setProperty("--leaf-motion", movement.toFixed(3));
    }

    function tick(timestamp) {
      if (timestamp - last >= 1000 / 28) {
        if (Number.isFinite(last)) elapsed += Math.min(.08, (timestamp - last) / 1000);
        last = timestamp;
        render(elapsed);
      }
      frame = requestAnimationFrame(tick);
    }

    function refresh() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      last = -Infinity;
      if (!document.hidden && !room.closest("[hidden]")) {
        if (motion.matches) render(elapsed);
        else frame = requestAnimationFrame(tick);
      }
    }

    new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const ratio = Math.min(devicePixelRatio, 1.2, 460 / rect.width);
        width = canvas.width = Math.max(1, Math.round(rect.width * ratio));
        height = canvas.height = Math.max(1, Math.round(rect.height * ratio));
        render(elapsed);
      }
    }).observe(canvas);
    document.addEventListener("visibilitychange", refresh);
    motion.addEventListener("change", refresh);
    return { refresh, redraw: () => render(elapsed) };
  }

  globalThis.createWindowEffects = createWindowEffects;
})();
