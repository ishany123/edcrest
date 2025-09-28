(() => {
    /*
      UI controller for the momentum/collision simulation.  This module
      encapsulates all DOM queries, worker communication and drawing
      routines for the two‑body collision simulation.  It closely
      follows the structure of the projectile simulation UI but has
      additional logic for drawing two bodies, displaying momentum
      information and handling a collision event.
    */

    // Shortcuts for querying DOM elements.  All elements used by the
    // momentum simulation have IDs prefixed with `mom_` to avoid
    // collisions with other simulations on the page.
    const $ = (id) => document.getElementById(id);
    const canvas = $('mom_canvas');
    const ctx = canvas.getContext('2d');
    const stageEl = document.querySelector('#momentumSim .stage');

    // Control buttons
    const startBtn = $('mom_startBtn');
    const pauseBtn = $('mom_pauseBtn');
    const resetBtn = $('mom_resetBtn');
    const applyBtn = $('mom_applyBtn');

    // Input fields
    const m1El = $('mom_m1');
    const m2El = $('mom_m2');
    const r1El = $('mom_r1');
    const r2El = $('mom_r2');
    const v1El = $('mom_v1');
    const angle1El = $('mom_angle1');
    const v2El = $('mom_v2');
    const angle2El = $('mom_angle2');
    const x1El = $('mom_x1');
    const y1El = $('mom_y1');
    const x2El = $('mom_x2');
    const y2El = $('mom_y2');
    const speedEl = $('mom_speed');

    // HUD elements for positions
    const hud1XEl = $('mom_hud1X');
    const hud1YEl = $('mom_hud1Y');
    const hud2XEl = $('mom_hud2X');
    const hud2YEl = $('mom_hud2Y');

    // Elements to display momentum information
    const pInfoEl = $('mom_momentumInfo');

    // Simulation state
    let worker = null;
    let running = false;
    let paused = false;
    let points1 = [];
    let points2 = [];
    let current = {
        x1: 0, y1: 0, vx1: 0, vy1: 0,
        x2: 0, y2: 0, vx2: 0, vy2: 0,
        t: 0,
        collided: false,
        momentumPre: null,
        momentumPost: null
    };
    let transforms = null;

    // Bounds used in both the worker and UI to define the simulation box.  These
    // values should mirror the BOUNDS defined in momentum_worker.js.  Using
    // constant bounds here ensures the grid and labels remain consistent
    // regardless of particle positions.
    const BOUNDS = { xMin: -10, xMax: 10, yMin: -5, yMax: 5 };

    // Store the radii currently used in the simulation so that we can
    // render body sizes proportionally in pixels.  These values are
    // updated whenever the simulation is (re)started with new inputs.
    let simParams = { r1: 0.25, r2: 0.25 };

    // Hi‑DPI canvas fitting
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
    // Dynamically fit the canvas when the container resizes.  Some
    // browsers may not support ResizeObserver on file:// pages, so
    // feature‑test and fall back to window resize events.
    if (typeof ResizeObserver !== 'undefined' && stageEl) {
        const ro = new ResizeObserver(() => { fitCanvas(); });
        ro.observe(stageEl);
    }
    window.addEventListener('resize', fitCanvas, { passive: true });
    if (document.readyState === 'complete') fitCanvas();
    else window.addEventListener('load', fitCanvas, { once: true });
    requestAnimationFrame(fitCanvas);

    // Numeric helpers
    function num(el, fallback) {
        const n = parseFloat(el.value);
        return Number.isFinite(n) ? n : fallback;
    }
    function readParams() {
        return {
            m1: Math.max(1e-3, num(m1El, 1)),
            m2: Math.max(1e-3, num(m2El, 1)),
            // Default radii fallback to 0.25 m if the input is empty
            r1: Math.max(1e-3, num(r1El, 0.25)),
            r2: Math.max(1e-3, num(r2El, 0.25)),
            v1: Math.max(0, num(v1El, 5)),
            angle1: num(angle1El, 0),
            v2: Math.max(0, num(v2El, 5)),
            angle2: num(angle2El, 180),
            x1: num(x1El, -5),
            y1: num(y1El, 0),
            x2: num(x2El, 5),
            y2: num(y2El, 0)
        };
    }
    function readSpeed() {
        const s = parseFloat(speedEl.value);
        return Number.isFinite(s) && s > 0 ? s : 0.25;
    }

    // Start or restart the simulation
    function startWithInputs() {
        if (worker) worker.terminate();
        worker = new Worker('momentum_worker.js');
        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'tick') {
                if (msg.points1 && msg.points1.length) {
                    for (const p of msg.points1) points1.push(p);
                }
                if (msg.points2 && msg.points2.length) {
                    for (const p of msg.points2) points2.push(p);
                }
                if (msg.state) current = msg.state;
                draw();
            } else if (msg.type === 'done') {
                running = false;
                paused = false;
                startBtn.disabled = false;
                pauseBtn.disabled = true;
                draw();
            } else if (msg.type === 'error') {
                alert('Worker error: ' + msg.message);
            }
        };
        points1 = [];
        points2 = [];
        current = {
            x1: 0, y1: 0, vx1: 0, vy1: 0,
            x2: 0, y2: 0, vx2: 0, vy2: 0,
            t: 0,
            collided: false,
            momentumPre: null,
            momentumPost: null
        };
        running = true;
        paused = false;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        pauseBtn.textContent = 'Pause';
        updateHUD(0, 0, 0, 0);
        pInfoEl.innerHTML = '';
        draw();
        // Capture parameters so we know the radii for rendering.
        const p = readParams();
        simParams = { r1: p.r1, r2: p.r2 };
        worker.postMessage({ type: 'start', params: p, speed: readSpeed() });
    }
    // Control button handlers
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
            worker.postMessage({ type: 'resume' });
        }
    });
    resetBtn.addEventListener('click', () => {
        if (worker) worker.terminate();
        running = false;
        paused = false;
        points1 = [];
        points2 = [];
        current = {
            x1: 0, y1: 0, vx1: 0, vy1: 0,
            x2: 0, y2: 0, vx2: 0, vy2: 0,
            t: 0,
            collided: false,
            momentumPre: null,
            momentumPost: null
        };
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        pauseBtn.textContent = 'Pause';
        updateHUD(0, 0, 0, 0);
        pInfoEl.innerHTML = '';
        draw();
    });
    applyBtn.addEventListener('click', startWithInputs);
    speedEl.addEventListener('change', () => {
        if (worker) worker.postMessage({ type: 'setSpeed', speed: readSpeed() });
    });

    // Drawing routines
    function draw() {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        ctx.clearRect(0, 0, W, H);
        const { sx, sy, pad } = getTransforms();
        grid(ctx, W, H, pad);
        drawAxisTicks();
        // Trajectories are no longer drawn for the collision simulation.
        // Draw bodies at current positions.  Radii are scaled from the
        // simulation's world units to pixels so that bodies visually
        // touch when they physically collide.  A minimum pixel radius
        // ensures bodies remain visible at very small radii.
        // Compute the on‑screen radii by averaging the scaling in both
        // directions.  Using only the x‑axis scaling can make circles
        // appear smaller than they physically are when the canvas aspect
        // ratio is not square (e.g. ±10 m in x vs ±5 m in y).  By
        // averaging the x and y scaled radii we maintain a roughly
        // circular shape and ensure the visual collision occurs at
        // exactly the same time as the physical collision in the
        // simulation.
        const r1PxX = Math.abs(sx(current.x1 + simParams.r1) - sx(current.x1));
        const r1PxY = Math.abs(sy(current.y1 + simParams.r1) - sy(current.y1));
        const r1Px = Math.max(4, (r1PxX + r1PxY) * 0.5);
        const r2PxX = Math.abs(sx(current.x2 + simParams.r2) - sx(current.x2));
        const r2PxY = Math.abs(sy(current.y2 + simParams.r2) - sy(current.y2));
        const r2Px = Math.max(4, (r2PxX + r2PxY) * 0.5);
        dot(ctx, sx(current.x1), sy(current.y1), r1Px, '#6fff9f');
        dot(ctx, sx(current.x2), sy(current.y2), r2Px, '#5ec2ff');
        // Draw velocity vectors (arrows) to visualize direction of motion.  Each
        // arrow has a fixed world length (1 m) scaled by the current speed.
        {
            const v1mag = Math.hypot(current.vx1, current.vy1);
            if (v1mag > 1e-8) {
                const scale = 1 / v1mag; // 1 m arrow
                const xEnd = current.x1 + current.vx1 * scale;
                const yEnd = current.y1 + current.vy1 * scale;
                drawArrow(ctx, sx, sy, current.x1, current.y1, xEnd, yEnd, '#6fff9f');
            }
            const v2mag = Math.hypot(current.vx2, current.vy2);
            if (v2mag > 1e-8) {
                const scale2 = 1 / v2mag;
                const xEnd2 = current.x2 + current.vx2 * scale2;
                const yEnd2 = current.y2 + current.vy2 * scale2;
                drawArrow(ctx, sx, sy, current.x2, current.y2, xEnd2, yEnd2, '#5ec2ff');
            }
        }
        // Update HUD with current positions
        updateHUD(current.x1, current.y1, current.x2, current.y2);
        // Display momentum information if available
        updateMomentumInfo();
        // Draw scale bar
        drawScaleBar();
    }
    // Compute transforms based on both sets of points so that the
    // viewport dynamically scales to include all motion.  The x and y
    // ranges are taken over both bodies combined.
    function getTransforms() {
        if (transforms &&
            transforms.W === canvas.clientWidth &&
            transforms.H === canvas.clientHeight &&
            transforms.N1 === points1.length &&
            transforms.N2 === points2.length) {
            return transforms;
        }
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const pad = { top: 16, right: 16, bottom: 44, left: 56 };
        const innerW = Math.max(1, W - pad.left - pad.right);
        const innerH = Math.max(1, H - pad.top - pad.bottom);
        // Use fixed bounds for extents so the viewport remains consistent.
        const maxX = Math.max(Math.abs(BOUNDS.xMin), Math.abs(BOUNDS.xMax));
        const maxY = Math.max(Math.abs(BOUNDS.yMin), Math.abs(BOUNDS.yMax));
        // Map coordinate preserving sign: allow negative positions by centring around origin
        const sx = (x) => pad.left + ((x + maxX) / (2 * maxX)) * innerW;
        const sy = (y) => H - pad.bottom - ((y + maxY) / (2 * maxY)) * innerH;
        transforms = { sx, sy, pad, maxX, maxY, W, H, innerW, innerH, N1: points1.length, N2: points2.length };
        return transforms;
    }
    // Draw grid and axes
    function grid(c, W, H, pad) {
        const left = pad.left, right = W - pad.right;
        const top = pad.top, bottom = H - pad.bottom;
        c.save();
        // Draw background grid lines aligned to world coordinate ticks rather
        // than fixed pixel spacing.  This ensures that the grid lines
        // coincide with the axis tick labels and avoids the visual
        // misalignment seen with a constant 40 px spacing.
        const { sx, sy, maxX, maxY } = getTransforms();
        const stepX = niceStep(maxX, 8);
        const stepY = niceStep(maxY, 8);
        c.strokeStyle = '#1c274f';
        c.lineWidth = 1;
        c.beginPath();
        // vertical grid lines for each multiple of stepX across ±maxX
        for (let x = -maxX; x <= maxX + 1e-9; x += stepX) {
            const px = sx(x);
            c.moveTo(px, top);
            c.lineTo(px, bottom);
        }
        // horizontal grid lines for each multiple of stepY across ±maxY
        for (let y = -maxY; y <= maxY + 1e-9; y += stepY) {
            const py = sy(y);
            c.moveTo(left, py);
            c.lineTo(right, py);
        }
        c.stroke();
        // draw the axes on top of the grid
        c.strokeStyle = '#2a355f';
        c.beginPath();
        // x-axis through the origin (y=0)
        const y0 = sy(0);
        c.moveTo(left, y0);
        c.lineTo(right, y0);
        // y-axis through the origin (x=0)
        const x0 = sx(0);
        c.moveTo(x0, bottom);
        c.lineTo(x0, top);
        c.stroke();
        c.restore();
    }
    // Axis tick marks and labels
    function drawAxisTicks() {
        const { sx, sy, pad, maxX, maxY, W, H } = getTransforms();
        const bottom = H - pad.bottom, left = pad.left;
        const right = W - pad.right;
        // X axis ticks along positive and negative directions
        const stepX = niceStep(maxX, 8);
        const decX = tickDecimals(stepX);
        ctx.save();
        // Use a slightly brighter colour for y-axis tick marks and labels
        ctx.strokeStyle = '#2f3f71';
        ctx.fillStyle = '#aab3cc';
        ctx.lineWidth = 1;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let x = -maxX; x <= maxX + 1e-9; x += stepX) {
            const X = sx(x);
            ctx.beginPath(); ctx.moveTo(X, bottom); ctx.lineTo(X, bottom + 6); ctx.stroke();
            ctx.fillText(x.toFixed(decX), X, bottom + 8);
        }
        ctx.fillText('x (m)', right - 28, bottom + 28);
        ctx.restore();
        // Y axis ticks
        const stepY = niceStep(maxY, 8);
        const decY = tickDecimals(stepY);
        ctx.save();
        // X-axis tick styling matches the y-axis styling for consistency
        ctx.strokeStyle = '#2f3f71';
        ctx.fillStyle = '#aab3cc';
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let y = -maxY; y <= maxY + 1e-9; y += stepY) {
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
    // Draw a scale bar indicating distance in meters
    function drawScaleBar() {
        const { sx, pad, maxX, H } = getTransforms();
        const step = niceStep(maxX, 6);
        // px distance for positive step (0->step) but relative to symmetric mapping
        const pxStart = sx(-maxX);
        const pxEnd = sx(-maxX + step);
        const px = pxEnd - pxStart;
        const y = H - pad.bottom + 22;
        const x = pad.left;
        ctx.save();
        ctx.lineWidth = 3;
        // Use semi-transparent primary colour for the scale bar line
        ctx.strokeStyle = '#6a98ff88';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
        ctx.font = '12px system-ui, sans-serif';
        // Match the axis label colour for the scale text
        ctx.fillStyle = '#aab3cc';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(`${step} m`, x + px / 2, y + 4);
        ctx.restore();
    }
    // Utility functions reused from the projectile module
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
    // Draw an arrow from (sx(x), sy(y)) toward (sx(x2), sy(y2)).  The arrowhead size
    // is proportional to the line width.  Coordinates are in world space.
    function drawArrow(ctx, sxFunc, syFunc, x1, y1, x2, y2, color) {
        const sx1 = sxFunc(x1), sy1 = syFunc(y1);
        const sx2 = sxFunc(x2), sy2 = syFunc(y2);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        // draw main line
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.stroke();
        // compute arrowhead
        const angle = Math.atan2(sy2 - sy1, sx2 - sx1);
        const size = 8;
        ctx.beginPath();
        ctx.moveTo(sx2, sy2);
        ctx.lineTo(sx2 - size * Math.cos(angle - Math.PI / 6), sy2 - size * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(sx2 - size * Math.cos(angle + Math.PI / 6), sy2 - size * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
    function updateHUD(x1, y1, x2, y2) {
        hud1XEl.textContent = `${(x1 || 0).toFixed(2)} m`;
        hud1YEl.textContent = `${(y1 || 0).toFixed(2)} m`;
        hud2XEl.textContent = `${(x2 || 0).toFixed(2)} m`;
        hud2YEl.textContent = `${(y2 || 0).toFixed(2)} m`;
    }
    // Display momentum pre/post collision if available
    function updateMomentumInfo() {
        const pre = current.momentumPre;
        const post = current.momentumPost;
        if (!current.collided) {
            pInfoEl.innerHTML = '';
            return;
        }
        function fmt(p) {
            return `(${p.px.toFixed(2)}, ${p.py.toFixed(2)})`;
        }
        pInfoEl.innerHTML = `
            <div class="row"><strong>Momentum before collision:</strong></div>
            <div class="row"><span class="k">p₁</span><span>${fmt(pre.p1)}</span></div>
            <div class="row"><span class="k">p₂</span><span>${fmt(pre.p2)}</span></div>
            <div class="row"><span class="k">Σp</span><span>${fmt(pre.total)}</span></div>
            <div class="row" style="margin-top:6px;"><strong>Momentum after collision:</strong></div>
            <div class="row"><span class="k">p₁</span><span>${fmt(post.p1)}</span></div>
            <div class="row"><span class="k">p₂</span><span>${fmt(post.p2)}</span></div>
            <div class="row"><span class="k">Σp</span><span>${fmt(post.total)}</span></div>
        `;
    }
})();