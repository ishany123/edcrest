(() => {
    // DOM references
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const $ = (id) => document.getElementById(id);

    const startBtn = $('startBtn');
    const pauseBtn = $('pauseBtn');
    const resetBtn = $('resetBtn');
    const tooltip = $('tooltip');

    // HUD elements
    const hudXEl = $('hudX');
    const hudYEl = $('hudY');


    // Hi-DPI support: match the backing store to CSS size * devicePixelRatio
    function fitCanvas() {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const rect = canvas.getBoundingClientRect();
        // Size the bitmap buffer; keep a minimum so very small containers still work
        canvas.width = Math.max(300, Math.floor(rect.width * dpr));
        canvas.height = Math.max(300, Math.floor(rect.height * dpr));
        // Draw in CSS pixel coordinates (so it can think in CSS pixels everywhere)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); 
    }
    new ResizeObserver(fitCanvas).observe(canvas);
    window.addEventListener('resize', fitCanvas, { passive: true });
    fitCanvas();

    // --- Simulation state (UI side)
    let worker = null; // Web Worker instance (physics thread)
    let running = false; // true when the worker is advancing
    let paused = false; // UI pause state
    let points = []; // trajectory samples [{x,y,t,v}] for drawing
    let current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 }; // most recent state from worker
    let transforms = null;   // cached physics→pixel mapping

    // Controls
    startBtn.addEventListener('click', () => {
        if (worker) worker.terminate();
        worker = new Worker('worker.js');

        // Worker → UI messages
        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'tick') {
                // Append any new polyline points
                if (msg.points && msg.points.length) {
                    for (const p of msg.points) points.push(p);
                }
                // Latest state (also used for tooltip/HUD)
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

        // reset UI state
        points = [];
        current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 };
        running = true;
        paused = false;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        pauseBtn.textContent = 'Pause';
        hideTooltip();
        updateHUD(0, 0);
        draw(); // draw frame with axes/ticks before points arrive

        // Kick off physics
        worker.postMessage({ type: 'start' });
    });

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
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        draw(); // redraw axes/ticks with empty trajectory
    });

    // Only allow clicking the projectile when paused or finished
    canvas.addEventListener('click', (e) => {
        if (running && !paused) return;
        if (!points.length) return;

        // Mouse in canvas CSS pixels
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Hit test against the projectile (12 px radius)
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

    // ========== Drawing ==========
    function draw(final = false) {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        ctx.clearRect(0, 0, W, H);

        const { sx, sy, pad } = getTransforms();

        // Grid and axes frame
        grid(ctx, W, H, pad);

        // Numbered tick marks + unit labels (x and y)
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

            // Last point = current projectile position
            const last = points[points.length - 1];
            dot(ctx, sx(last.x), sy(last.y), 5, '#5ec2ff');

            // Keep tooltip anchored to the projectile when visible
            if (!tooltip.classList.contains('hidden')) {
                positionTooltip(sx(current.x), sy(current.y));
            }

            // Dashed measurement guides (ground distance + height at current x)
            drawMeasurements();
        }

        // Scale bar (meters) in the bottom margin
        drawScaleBar();
        // Update HUD
        updateHUD(current.x, current.y);
    }

    // Compute physics→pixel transforms. Cache by canvas size and point count.
    function getTransforms() {
        if (transforms &&
            transforms.W === canvas.clientWidth &&
            transforms.H === canvas.clientHeight &&
            transforms.N === points.length) {
            return transforms;
        }
        const W = canvas.clientWidth, H = canvas.clientHeight;

        // Padded inner plotting area so ticks/labels don’t clip
        const pad = { top: 16, right: 16, bottom: 44, left: 56 };

        const innerW = Math.max(1, W - pad.left - pad.right);
        const innerH = Math.max(1, H - pad.top - pad.bottom);

        // Extents in meters (fallbacks so early frames still look sane)
        const maxX = Math.max(10, ...points.map(p => p.x));
        const maxY = Math.max(5, ...points.map(p => p.y));

        // Linear mapping (independent scales for x and y)
        const sx = (x) => pad.left + (x / Math.max(1, maxX)) * innerW;
        const sy = (y) => H - pad.bottom - (y / Math.max(1, maxY)) * innerH;

        transforms = { sx, sy, pad, maxX, maxY, W, H, innerW, innerH, N: points.length };
        return transforms;
    }

    // Draw grid lines and axes aligned to the padded plot area
    function grid(c, W, H, pad) {
        const left = pad.left, right = W - pad.right;
        const top = pad.top, bottom = H - pad.bottom;

        c.save();
        // Background grid (visual aid only; not tied to meters)
        c.strokeStyle = '#1c274f'; c.lineWidth = 1;
        c.beginPath();
        for (let x = left; x <= right; x += 40) { c.moveTo(x, top); c.lineTo(x, bottom); }
        for (let y = top; y <= bottom; y += 40) { c.moveTo(left, y); c.lineTo(right, y); }
        c.stroke();

        // Axes
        c.strokeStyle = '#2a355f';
        c.beginPath();
        c.moveTo(left, bottom); c.lineTo(right, bottom); // x-axis
        c.moveTo(left, bottom); c.lineTo(left, top);     // y-axis
        c.stroke();
        c.restore();
    }

    // Tick marks + numeric labels + axis unit labels
    function drawAxisTicks() {
        const { sx, sy, pad, maxX, maxY, W, H } = getTransforms();
        const bottom = H - pad.bottom, left = pad.left;

        // X ticks
        {
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
        }

        // Y ticks
        {
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
            // Unit label (rotated)
            ctx.save();
            ctx.translate(left - 32, pad.top + 14);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText('y (m)', 0, 0);
            ctx.restore();
            ctx.restore();
        }
    }

    // Draw dashed guides (origin->current x on ground, and vertical up to current y)
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

    // Scale bar in meters (uses the same sx mapping)
    function drawScaleBar() {
        const { sx, pad, maxX, H } = getTransforms();
        const step = niceStep(maxX, 6); // choose a “nice” metric length: 1, 2, 5 × 10^k
        const px = sx(step) - sx(0); // convert that many meters to pixels

        const y = H - pad.bottom + 22;  // place inside the bottom margin
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

    // Utility: choose friendly tick step sizes (1/2/5 × 10^k)
    function niceStep(maxValue, targetTicks = 5) {
        const raw = Math.max(1e-6, maxValue / targetTicks);
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / pow;
        return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow;
    }

    // Determine decimal places for tick labels based on step
    function tickDecimals(step) {
        const e = Math.max(0, -Math.floor(Math.log10(step)));
        return Math.min(6, e);
    }

    // Draw a filled circle
    function dot(c, x, y, r, color) { c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }

    // HUD updaterv
    function updateHUD(x, y) {
        hudXEl.textContent = `${(x || 0).toFixed(2)} m`;
        hudYEl.textContent = `${(y || 0).toFixed(2)} m`;
    }

    // Tooltip shown when clicking the projectile (paused/finished)
    function showTooltip(px, py) {
        const m = 0.145; // (kg) 
        const g = 9.81;  // (m/s^2)
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

    // Keep tooltip inside the stage viewport
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
