(() => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const $ = (id) => document.getElementById(id);

    const startBtn = $('startBtn');
    const pauseBtn = $('pauseBtn');
    const resetBtn = $('resetBtn');
    const tooltip = $('tooltip');

    // Hi-DPI / resize
    function fitCanvas() {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(300, Math.floor(rect.width * dpr));
        canvas.height = Math.max(300, Math.floor(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw using CSS pixels
    }
    new ResizeObserver(fitCanvas).observe(canvas);
    window.addEventListener('resize', fitCanvas, { passive: true });
    fitCanvas();

    // Sim state
    let worker = null;
    let running = false;
    let paused = false;
    let points = [];              // [{x,y,t,v}]
    let current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 }; // latest state from worker
    let transforms = null;        // { sx, sy, pad, maxX, maxY }

    // Controls
    startBtn.addEventListener('click', () => {
        if (worker) worker.terminate();
        worker = new Worker('worker.js'); 
        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'tick') {
                points.push(...msg.points);
                current = msg.state;
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
        running = true;
        paused = false;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        pauseBtn.textContent = 'Pause';
        hideTooltip();
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
        running = false; paused = false; points = []; current = { x: 0, y: 0, t: 0, vx: 0, vy: 0, v: 0 };
        startBtn.disabled = false; pauseBtn.disabled = true; pauseBtn.textContent = 'Pause';
        hideTooltip();
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    });

    // Click to inspect (only when paused or finished)
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

    function draw(final = false) {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        ctx.clearRect(0, 0, W, H);

        const { sx, sy, pad } = getTransforms();

        // Grid
        grid(ctx, W, H, pad);

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

            // Projectile dot
            const last = points[points.length - 1];
            dot(ctx, sx(last.x), sy(last.y), 5, '#5ec2ff');

            // Keep tooltip near the projectile if visible
            if (!tooltip.classList.contains('hidden')) {
                positionTooltip(sx(current.x), sy(current.y));
            }
        }

        // Axes labels
        ctx.fillStyle = '#9aa3b2'; ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('x (m)', W - pad - 36, H - 6);
        ctx.save();
        ctx.translate(10, 26); ctx.rotate(-Math.PI / 2); ctx.fillText('y (m)', 0, 0); ctx.restore();
    }

    function getTransforms() {
        if (transforms && transforms.W === canvas.clientWidth && transforms.H === canvas.clientHeight && transforms.N === points.length) {
            return transforms;
        }
        const W = canvas.clientWidth, H = canvas.clientHeight, pad = 24;
        const maxX = Math.max(10, ...points.map(p => p.x));
        const maxY = Math.max(5, ...points.map(p => p.y));
        const sx = (x) => pad + (x / Math.max(1, maxX)) * (W - 2 * pad);
        const sy = (y) => H - pad - (y / Math.max(1, maxY)) * (H - 2 * pad);
        transforms = { sx, sy, pad, maxX, maxY, W, H, N: points.length };
        return transforms;
    }

    function grid(c, W, H, pad) {
        c.save();
        c.strokeStyle = '#1c274f'; c.lineWidth = 1;
        c.beginPath();
        for (let x = pad; x <= W - pad; x += 40) { c.moveTo(x, pad); c.lineTo(x, H - pad); }
        for (let y = pad; y <= H - pad; y += 40) { c.moveTo(pad, y); c.lineTo(W - pad, y); }
        c.stroke();
        // Axes
        c.strokeStyle = '#2a355f';
        c.beginPath();
        c.moveTo(pad, H - pad); c.lineTo(W - pad, H - pad);
        c.moveTo(pad, H - pad); c.lineTo(pad, pad);
        c.stroke();
        c.restore();
    }

    function dot(c, x, y, r, color) { c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }

    function showTooltip(px, py) {
        // Calculate energies from current state
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
