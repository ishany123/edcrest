/*
  Web Worker: Projectile motion with quadratic air resistance, RK4 integrator.
  F_drag = 0.5 * rho * Cd * A * |v_rel| * v_rel,  v_rel = (vx - wind, vy)
  a_x = -(k/m) * |v_rel| * v_rel_x
  a_y = -g     -(k/m) * |v_rel| * v_rel_y
  where k = 0.5 * rho * Cd * A
*/
const SPEED = 0.25
const MAX_STEPS = 10;

// Default parameters (edit as needed or extend to accept from main)
const params = {
    v0: 30,           // m/s
    angleDeg: 45,     // degrees
    m: 0.145,         // kg (baseball-ish)
    cd: 0.47,         // drag coefficient
    A: 0.0042,        // m^2 (cross-sectional area)
    rho: 1.225,       // kg/m^3 (air density at sea level)
    g: 9.81,          // m/s^2
    wind: 0,          // m/s (tailwind +x)
    dt: 0.01,         // s
    maxT: 20          // s
};

let running = false;
let state = null; // {x,y,vx,vy,t}
let loopTimer = null;

let lastReal = 0;     // ms timestamp of last frame
let acc = 0;          // accumulated (scaled) seconds to integrate

self.onmessage = (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'start') {
            start();
        } else if (msg.type === 'pause') {
            running = false;
            clearTimer();
        } else if (msg.type === 'resume') {
            if (!state) return;
            running = true;
            lastReal = performance.now();
            loop();
        }
    } catch (err) {
        postMessage({ type: 'error', message: String(err?.message || err) });
    }
};

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
    clearTimer();
    loop();
}

function accel(vx, vy) {
    const k = 0.5 * params.cd * params.A * params.rho;
    const vrelx = vx - params.wind;
    const vrely = vy;
    const v = Math.hypot(vrelx, vrely);
    const ax = -(k / params.m) * v * vrelx;
    const ay = -params.g - (k / params.m) * v * vrely;
    return { ax, ay };
}

// RK4 step
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

    s.x += (dt / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x);
    s.y += (dt / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y);
    s.vx += (dt / 6) * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx);
    s.vy += (dt / 6) * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy);
    s.t += dt;
}

function loop() {
    if (!running) return;

    const now = performance.now();
    acc += ((now - lastReal) / 1000) * SPEED;
    lastReal = now;

    const batch = [];
    let steps = 0;

    while (acc >= params.dt && steps < MAX_STEPS) {
        stepRK4();
        acc -= params.dt;
        steps++;

        if (state.y < 0 || state.t >= params.maxT) {
            running = false;
            break;
        }

        batch.push({ x: state.x, y: state.y, t: state.t, v: Math.hypot(state.vx, state.vy) });
    }


    if (batch.length) {
        postMessage({
            type: 'tick',
            points: batch,
            state: { x: state.x, y: state.y, t: state.t, vx: state.vx, vy: state.vy, v: Math.hypot(state.vx, state.vy) }
        });
    }

    if (!running) {
        postMessage({ type: 'done' });
        return;
    }
    
    loopTimer = setTimeout(tickLoop, 16);
}

function clearTimer() { if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; } }
