(() => {
    // This module instantiates a projectile motion simulation within a
    // specific section of the lesson page.  It is largely based on
    // the original `main.js` POC but scopes all DOM queries to a
    // namespaced set of element IDs so that multiple simulations can
    // coexist on the same page without interfering with one another.

    // Look up elements by their IDs.  All IDs for the projectile
    // simulation begin with the prefix `proj_`.
    const canvas = document.getElementById('proj_canvas');
    const ctx = canvas.getContext('2d');
    const $ = (id) => document.getElementById(id);

    const startBtn = $('proj_startBtn');
    const pauseBtn = $('proj_pauseBtn');
    const resetBtn = $('proj_resetBtn');

    // Inputs
    const v0El = $('proj_v0');
    const angleEl = $('proj_angle');
    const cdEl = $('proj_cd');
    const windEl = $('proj_wind');
    const speedEl = $('proj_speed');
    const applyBtn = $('proj_applyBtn');

    // HUD elements
    const hudXEl = $('proj_hudX');
    const hudYEl = $('proj_hudY');
    const tooltip = $('proj_tooltip');

    // Reference to the simulation container for ResizeObserver
    const stageEl = document.querySelector('#projectileSim .stage');

    // Hi‑DPI support: match the backing store to CSS size * dpr
    function fitCanvas() {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.floor(rect.width);
        const cssH = Math.floor(rect.height);
        if (cssW <= 0 || cssH <= 0) {
            requestAnimationFrame(fitCanvas);
            return;
        }
        const bw = Math.max(300, Math.floor(cssW * dpr));
        const bh = Math.max(300, Math.floor(cssH * dpr));
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        draw();
    }
    // Set up resize handling.  Guard against browsers/environments that
    // lack ResizeObserver by falling back to a window resize listener.
    if (typeof ResizeObserver !== 'undefined' && stageEl) {
        const ro = new ResizeObserver(() => { fitCanvas(); });
        ro.observe(stageEl);
    }
    window.addEventListener('resize', fitCanvas, { passive: true });
    if (document.readyState === 'complete')
        fitCanvas();
    else
        window.addEventListener('load', fitCanvas, { once: true });
    requestAnimationFrame(fitCanvas);

    // Simulation state (UI side)
    let worker = null;
    let running = false;
    let paused = false;
    let points = [];
    let current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 };
    let transforms = null;

    // Helpers: read numeric inputs with fallback
    function num(el, fallback) {
        const n = parseFloat(el.value);
        return Number.isFinite(n) ? n : fallback;
    }
    function readParams() {
        return {
            v0: Math.max(0, num(v0El, 30)),
            angleDeg: Math.min(90, Math.max(0, num(angleEl, 45))),
            cd: Math.max(0, num(cdEl, 0.47)),
            wind: num(windEl, 0)
        };
    }
    function readSpeed() {
        const s = parseFloat(speedEl.value);
        return Number.isFinite(s) && s > 0 ? s : 0.25;
    }
    // Start/restart simulation
    function startWithInputs() {
        if (worker) worker.terminate();
        worker = new Worker('proj_worker.js');
        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'tick') {
                if (msg.points && msg.points.length) {
                    for (const p of msg.points) points.push(p);
                }
                if (msg.state) current = msg.state;
                draw();
            } else if (msg.type === 'done') {
                running = false;
                paused = false;
                startBtn.disabled = false;
                pauseBtn.disabled = true;
                draw(true);
            } else if (msg.type === 'error') {
                alert('Worker error: ' + msg.message);
            }
        };
        points = [];
        current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 };
        running = true;
        paused = false;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        pauseBtn.textContent = 'Pause';
        hideTooltip();
        updateHUD(0, 0);
        draw();
        worker.postMessage({ type: 'start', params: readParams(), speed: readSpeed() });
    }
    // Controls
    startBtn.addEventListener('click', startWithInputs);
    pauseBtn.addEventListener('click', () => {
        if (!running) return;
        if (!paused) {
            paused = true;
            pauseBtn.textContent = 'Resume';
            worker.postMessage({ type: 'pause' });
        } else {
            paused = false;
            pauseBtn.textContent = 'Pause';
            hideTooltip();
            worker.postMessage({ type: 'resume' });
        }
    });
    resetBtn.addEventListener('click', () => {
        if (worker) worker.terminate();
        running = false;
        paused = false;
        points = [];
        current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 };
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        pauseBtn.textContent = 'Pause';
        hideTooltip();
        updateHUD(0, 0);
        draw();
    });
    applyBtn.addEventListener('click', startWithInputs);
    speedEl.addEventListener('change', () => {
        if (worker) worker.postMessage({ type: 'setSpeed', speed: readSpeed() });
    });
    // Click to show tooltip when paused or finished
    canvas.addEventListener('click', (e) => {
        if (running && !paused) return;
        if (!points.length) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const { sx, sy } = getTransforms();
        const px = sx(current.x);
        const py = sy(current.y);
        const dist = Math.hypot(mx - px, my - py);
        if (dist <= 12) {
            showTooltip(px, py);
        } else {
            hideTooltip();
        }
    });
    // Drawing functions
    function draw() {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        ctx.clearRect(0, 0, W, H);
        const { sx, sy, pad } = getTransforms();
        // Grid and axes frame
        grid(ctx, W, H, pad);
        // Numbered ticks and labels
        drawAxisTicks();
        // Trajectory
        if (points.length > 1) {
            ctx.save();
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#6fff9f';
            ctx.beginPath();
            ctx.moveTo(sx(points[0].x), sy(points[0].y));
            for (const p of points) ctx.lineTo(sx(p.x), sy(p.y));
            ctx.stroke();
            ctx.restore();
            const last = points[points.length - 1];
            dot(ctx, sx(last.x), sy(last.y), 5, '#5ec2ff');
            if (!tooltip.classList.contains('hidden')) {
                positionTooltip(sx(current.x), sy(current.y));
            }
            drawMeasurements();
        }
        drawScaleBar();
        updateHUD(current.x, current.y);
    }
    function getTransforms() {
        if (transforms &&
            transforms.W === canvas.clientWidth &&
            transforms.H === canvas.clientHeight &&
            transforms.N === points.length) {
            return transforms;
        }
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const pad = { top: 16, right: 16, bottom: 44, left: 56 };
        const innerW = Math.max(1, W - pad.left - pad.right);
        const innerH = Math.max(1, H - pad.top - pad.bottom);
        const maxX = Math.max(10, ...points.map(p => p.x));
        const maxY = Math.max(5, ...points.map(p => p.y));
        const sx = (x) => pad.left + (x / Math.max(1, maxX)) * innerW;
        const sy = (y) => H - pad.bottom - (y / Math.max(1, maxY)) * innerH;
        transforms = { sx, sy, pad, maxX, maxY, W, H, innerW, innerH, N: points.length };
        return transforms;
    }
    function grid(c, W, H, pad) {
        const left = pad.left, right = W - pad.right;
        const top = pad.top, bottom = H - pad.bottom;
        c.save();
        // Draw background grid lines aligned to world coordinate ticks
        const { sx, sy, maxX, maxY } = getTransforms();
        const stepX = niceStep(maxX, 8);
        const stepY = niceStep(maxY, 8);
        c.strokeStyle = '#1c274f';
        c.lineWidth = 1;
        c.beginPath();
        // vertical grid lines for multiples of stepX from 0 to maxX
        for (let x = 0; x <= maxX + 1e-9; x += stepX) {
            const px = sx(x);
            c.moveTo(px, top);
            c.lineTo(px, bottom);
        }
        // horizontal grid lines for multiples of stepY from 0 to maxY
        for (let y = 0; y <= maxY + 1e-9; y += stepY) {
            const py = sy(y);
            c.moveTo(left, py);
            c.lineTo(right, py);
        }
        c.stroke();
        // Draw border lines for the axes (bottom and left)
        c.strokeStyle = '#2a355f';
        c.beginPath();
        c.moveTo(left, bottom);
        c.lineTo(right, bottom);
        c.moveTo(left, bottom);
        c.lineTo(left, top);
        c.stroke();
        c.restore();
    }
    function drawAxisTicks() {
        const { sx, sy, pad, maxX, maxY, W, H } = getTransforms();
        const bottom = H - pad.bottom, left = pad.left;
        // X axis ticks
        const stepX = niceStep(maxX, 8);
        const decX = tickDecimals(stepX);
        ctx.save();
        ctx.strokeStyle = '#2a355f';
        ctx.fillStyle = '#9aa3b2';
        ctx.lineWidth = 1;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let x = 0; x <= maxX + 1e-9; x += stepX) {
            const X = sx(x);
            ctx.beginPath(); ctx.moveTo(X, bottom); ctx.lineTo(X, bottom + 6); ctx.stroke();
            ctx.fillText(x.toFixed(decX), X, bottom + 8);
        }
        ctx.fillText('x (m)', W - pad.right - 28, bottom + 28);
        ctx.restore();
        // Y axis ticks
        const stepY = niceStep(maxY, 8);
        const decY = tickDecimals(stepY);
        ctx.save();
        ctx.strokeStyle = '#2a355f';
        ctx.fillStyle = '#9aa3b2';
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let y = 0; y <= maxY + 1e-9; y += stepY) {
            const Y = sy(y);
            ctx.beginPath(); ctx.moveTo(left - 6, Y); ctx.lineTo(left, Y); ctx.stroke();
            ctx.fillText(y.toFixed(decY), left - 8, Y);
        }
        ctx.save();
        ctx.translate(left - 32, pad.top + 14);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('y (m)', 0, 0);
        ctx.restore();
        ctx.restore();
    }
    function drawMeasurements() {
        const { sx, sy } = getTransforms();
        const x0 = sx(0), y0 = sy(0);
        const xC = sx(current.x), yC = sy(current.y);
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#6a98ff88';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xC, y0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(xC, y0); ctx.lineTo(xC, yC); ctx.stroke();
        ctx.restore();
    }
    function drawScaleBar() {
        const { sx, pad, maxX, H } = getTransforms();
        const step = niceStep(maxX, 6);
        const px = sx(step) - sx(0);
        const y = H - pad.bottom + 22;
        const x = pad.left;
        ctx.save();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#6a98ff88';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillStyle = '#9aa3b2';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`${step} m`, x + px / 2, y + 4);
        ctx.restore();
    }
    function niceStep(maxValue, targetTicks = 5) {
        const raw = Math.max(1e-6, maxValue / targetTicks);
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / pow;
        return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow;
    }
    function tickDecimals(step) {
        const e = Math.max(0, -Math.floor(Math.log10(step)));
        return Math.min(6, e);
    }
    function dot(c, x, y, r, color) { c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }
    function updateHUD(x, y) {
        hudXEl.textContent = `${(x || 0).toFixed(2)} m`;
        hudYEl.textContent = `${(y || 0).toFixed(2)} m`;
    }
    function showTooltip(px, py) {
        const m = 0.145; // same default mass used in the worker
        const g = 9.81;
        const KE = 0.5 * m * current.v * current.v;
        const PE = m * g * Math.max(0, current.y);
        tooltip.innerHTML = `
            <div class="title">Projectile</div>
            <div class="row"><span class="k">t</span><span>${current.t.toFixed(2)} s</span></div>
            <div class="row"><span class="k">x</span><span>${current.x.toFixed(2)} m</span></div>
            <div class="row"><span class="k">y</span><span>${current.y.toFixed(2)} m</span></div>
            <div class="row"><span class="k">v</span><span>${current.v.toFixed(2)} m/s</span></div>
            <div class="row"><span class="k">vₓ</span><span>${current.vx.toFixed(2)} m/s</span></div>
            <div class="row"><span class="k">vᵧ</span><span>${current.vy.toFixed(2)} m/s</span></div>
            <div class="row"><span class="k">KE</span><span>${KE.toFixed(2)} J</span></div>
            <div class="row"><span class="k">PE</span><span>${PE.toFixed(2)} J</span></div>
        `;
        tooltip.classList.remove('hidden');
        positionTooltip(px, py);
    }
    function positionTooltip(px, py) {
        const stageRect = canvas.getBoundingClientRect();
        const ttRect = tooltip.getBoundingClientRect();
        let left = px + 14; let top = py + 14;
        if (left + ttRect.width > stageRect.width - 8) left = px - ttRect.width - 14;
        if (top + ttRect.height > stageRect.height - 8) top = py - ttRect.height - 14;
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
    }
    function hideTooltip() { tooltip.classList.add('hidden'); }
})();