/*
  Worker thread: integrates projectile motion with quadratic drag using RK4.
  - Runs at a *paced* 0.25× speed via a fixed-step accumulator (stable timing).
  F_drag = 0.5 * rho * Cd * A * |v_rel| * v_rel,  v_rel = (vx - wind, vy)
  a_x = -(k/m) * |v_rel| * v_rel_x
  a_y = -g     -(k/m) * |v_rel| * v_rel_y
  where k = 0.5 * rho * Cd * A
*/

// Wall-clock pacing (0.25× real-time)
let SPEED = 0.25
// Safety cap: prevent any single loop from doing too many physics steps
const MAX_STEPS = 10;

// Default parameters
const defaults = {
    v0: 30,           // m/s
    angleDeg: 45,     // degrees
    m: 0.145,         // kg (baseball-ish)
    cd: 0.47,         // drag coefficient
    A: 0.0042,        // m^2 (cross-sectional area)
    rho: 1.225,       // kg/m^3 (air density at sea level)
    g: 9.81,          // m/s^2
    wind: 0,          // m/s (tailwind +x)
    dt: 0.005,         // s
    maxT: 20          // s
};

// Worker-local state
let params = { ...defaults }; // set to default parameters
let running = false; // loop is active
let state = null; // {x,y,vx,vy,t}
let loopTimer = null; // setTimeout handle
let lastReal = 0;     // ms timestamp of last loop
let acc = 0;          // accumulated (scaled) seconds to integrate

// Message interface
self.onmessage = (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'start') {
            applyParams(msg.params);
            if (Number.isFinite(+msg.speed) && msg.speed > 0) SPEED = +msg.speed;
            start();
        } else if (msg.type === 'pause') {
            running = false;
            clearTimer();
        } else if (msg.type === 'resume') {
            if (!state) return;
            running = true;
            lastReal = performance.now(); // reset wall-clock origin
            loop();
        } else if (msg.type === 'setSpeed') {
            if (Number.isFinite(+msg.speed) && +msg.speed > 0) SPEED = +msg.speed;
        }
    } catch (err) {
        postMessage({ type: 'error', message: String(err?.message || err) });
    }
};

function applyParams(p = {}) {
    // sanitize incoming; only allow known keys
    const next = { ...params };
    if (Number.isFinite(+p.v0) && +p.v0 >= 0) next.v0 = +p.v0;
    if (Number.isFinite(+p.angleDeg)) next.angleDeg = Math.min(90, Math.max(0, +p.angleDeg));
    if (Number.isFinite(+p.cd) && +p.cd >= 0) next.cd = +p.cd;
    if (Number.isFinite(+p.wind)) next.wind = +p.wind;
    params = next;
}

// Initialize state, post the initial point, and start paced loop
function start() {
    const th = (params.angleDeg * Math.PI) / 180;
    state = {
        x: 0,
        y: 0,
        vx: params.v0 * Math.cos(th),
        vy: params.v0 * Math.sin(th),
        t: 0
    };
    running = true;
    acc = 0;
    lastReal = performance.now();

    // Seed UI with the exact initial state (so the line starts at the origin)
    const vmag0 = Math.hypot(state.vx, state.vy);
    postMessage({
        type: 'tick',
        points: [{ x: state.x, y: state.y, t: state.t, v: vmag0 }],
        state: { x: state.x, y: state.y, t: state.t, vx: state.vx, vy: state.vy, v: vmag0 }
    });

    clearTimer();
    loop();
}

// Compute acceleration components with quadratic drag
function accel(vx, vy) {
    // Drag factor
    const k = 0.5 * params.cd * params.A * params.rho;
    // Relative velocity (account for wind in +x)
    const vrelx = vx - params.wind;
    const vrely = vy;
    const v = Math.hypot(vrelx, vrely);
    // Ax, Ay (drag opposite the relative velocity; gravity in -y)
    const ax = -(k / params.m) * v * vrelx;
    const ay = -params.g - (k / params.m) * v * vrely;
    return { ax, ay };
}

// One RK4 integration step on the global `state` with time step dt
function stepRK4() {
    const dt = params.dt;
    const s = state;

    const a1 = accel(s.vx, s.vy);
    const k1 = { x: s.vx, y: s.vy, vx: a1.ax, vy: a1.ay };

    const a2 = accel(s.vx + 0.5 * dt * k1.vx, s.vy + 0.5 * dt * k1.vy);
    const k2 = { x: s.vx + 0.5 * dt * k1.vx, y: s.vy + 0.5 * dt * k1.vy, vx: a2.ax, vy: a2.ay };

    const a3 = accel(s.vx + 0.5 * dt * k2.vx, s.vy + 0.5 * dt * k2.vy);
    const k3 = { x: s.vx + 0.5 * dt * k2.vx, y: s.vy + 0.5 * dt * k2.vy, vx: a3.ax, vy: a3.ay };

    const a4 = accel(s.vx + dt * k3.vx, s.vy + dt * k3.vy);
    const k4 = { x: s.vx + dt * k3.vx, y: s.vy + dt * k3.vy, vx: a4.ax, vy: a4.ay };

    // Weighted blend of slopes
    s.x += (dt / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x);
    s.y += (dt / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y);
    s.vx += (dt / 6) * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx);
    s.vy += (dt / 6) * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy);
    s.t += dt;
}

// Main paced loop: accumulate wall-clock time × SPEED, then integrate fixed dt steps
function loop() {
    if (!running) return;

    // 1) How much real time passed since the last frame? Convert to sim time at SPEED.
    const now = performance.now();
    acc += ((now - lastReal) / 1000) * SPEED;
    lastReal = now;

    // 2) Integrate enough dt-steps to "catch up" (bounded by MAX_STEPS)
    const batch = [];
    let steps = 0;

    while (acc >= params.dt && steps < MAX_STEPS) {
        // Keep previous sample to detect ground crossing
        const prev = { ...state };

        stepRK4();
        acc -= params.dt;
        steps++;

        // Ground-crossing detection: if we stepped from y≥0 to y<0, interpolate the hit
        if (prev.y >= 0 && state.y < 0) {
            // Linear interpolation factor alpha where y(alpha) = 0
            const denom = (prev.y - state.y) || 1e-12;
            const alpha = prev.y / denom; // in (0,1)

            // Interpolated landing state at y=0
            const xHit = prev.x + alpha * (state.x - prev.x);
            const tHit = prev.t + alpha * (state.t - prev.t);
            const vxHit = prev.vx + alpha * (state.vx - prev.vx);
            const vyHit = prev.vy + alpha * (state.vy - prev.vy);
            const vHit = Math.hypot(vxHit, vyHit);

            // First flush any normal points we already accumulated this tick
            if (batch.length) {
                postMessage({
                    type: 'tick',
                    points: batch,
                    state: { x: state.x, y: state.y, t: state.t, vx: state.vx, vy: state.vy, v: Math.hypot(state.vx, state.vy) }
                });
            }

            // Then send the exact landing point on the ground (y=0)
            postMessage({
                type: 'tick',
                points: [{ x: xHit, y: 0, t: tHit, v: vHit }],
                state: { x: xHit, y: 0, t: tHit, vx: vxHit, vy: vyHit, v: vHit }
            });

            // Stop the simulation
            running = false;
            postMessage({ type: 'done' });
            return;
        }

        // Normal sample
        batch.push({ x: state.x, y: state.y, t: state.t, v: Math.hypot(state.vx, state.vy) });

        // Safety cutoff on time
        if (state.t >= params.maxT) { running = false; break; }
    }

    // 3) Send the batch (if any)
    if (batch.length) {
        postMessage({
            type: 'tick',
            points: batch,
            state: { x: state.x, y: state.y, t: state.t, vx: state.vx, vy: state.vy, v: Math.hypot(state.vx, state.vy) }
        });
    }

    // 4) If still running, schedule the next paced iteration (~60 Hz UI)
    if (!running) {
        postMessage({ type: 'done' });
        return;
    }

    loopTimer = setTimeout(loop, 16);
}

// Clear any pending timer
function clearTimer() { if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; } }
