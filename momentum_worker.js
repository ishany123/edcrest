/*
  Worker thread: simulates a two-body collision in 2‑D space using
  constant velocity motion until a collision occurs, then resolves the
  velocities using conservation of momentum and kinetic energy (perfectly
  elastic collision).  This worker uses the same wall‑clock pacing logic
  as the projectile simulation so that the simulation advances in
  proportion to real time, scaled by a user adjustable SPEED.

  The simulation handles arbitrary masses, initial speeds and launch
  angles for each body.  Positions and velocities are integrated with a
  fixed time step `dt` and the worker accumulates wall time to decide
  when to perform discrete simulation steps.  When the separation
  between the two bodies is less than or equal to the sum of their
  radii, the collision response is computed using the standard 2‑D
  elastic collision formula:

      v1' = v1 − (2·m2/(m1+m2)) * [((v1 − v2)·(x1 − x2)) / |x1 − x2|²] * (x1 − x2)
      v2' = v2 − (2·m1/(m1+m2)) * [((v2 − v1)·(x2 − x1)) / |x2 − x1|²] * (x2 − x1)

  Both pre‑collision and post‑collision momentum vectors are computed and
  returned to the UI so it can display the change in momentum for each
  body and verify conservation of momentum.
*/

// Wall‑clock pacing (scaled real‑time).  The SPEED factor determines
// how many simulated seconds elapse per real second.  E.g. SPEED=1
// means real time, SPEED=0.25 means the sim runs 4× slower.
let SPEED = 0.25;

// Limit the number of integration steps per tick to avoid long UI
// freezes if the main thread is delayed.  A value of 10 is used,
// matching the projectile POC worker.
const MAX_STEPS = 10;

// Default parameters for the collision simulation.  These values are
// overridden when the main thread posts a `start` message with
// user‑specified parameters.
const defaults = {
    m1: 1.0,      // kg
    m2: 1.0,      // kg
    r1: 0.25,      // m (radius of body 1)
    r2: 0.25,      // m (radius of body 2)
    v1: 5.0,      // m/s (speed magnitude of body 1)
    angle1: 0.0,  // degrees (direction of body 1)
    v2: 5.0,      // m/s (speed magnitude of body 2)
    angle2: 180.0,// degrees (direction of body 2)
    x1: -5.0,     // initial x position of body 1
    y1: 0.0,      // initial y position of body 1
    x2: 5.0,      // initial x position of body 2
    y2: 0.0,      // initial y position of body 2
    dt: 0.005,    // s (simulation time step)
    maxT: 10.0    // s (maximum simulation time)
    // Note: bounds are defined separately below
};

// Boundaries for the simulation domain.  Bodies will bounce when
// reaching these edges.  The X range is symmetric around the origin
// (±10 m) and the Y range is ±5 m.  These values can be adjusted to
// change the size of the simulated box without affecting the UI.
const BOUNDS = {
    xMin: -10.0,
    xMax: 10.0,
    yMin: -5.0,
    yMax: 5.0
};

// Worker state variables.  These are reinitialised on every `start`
// message.
let params = { ...defaults };
let running = false;
let state = null; // { x1, y1, vx1, vy1, x2, y2, vx2, vy2, t }
// The `inContact` flag is true while the two bodies are overlapping (i.e.
// distance <= r1 + r2).  It prevents resolving a collision on every
// integration step while the bodies remain in contact.  When the bodies
// separate, `inContact` resets to false so a subsequent collision will
// be handled correctly.
let inContact = false;
// Momentum snapshots before and after the most recent collision.  These
// are used to report the last collision to the UI.
let momentumPre = null;  // { p1: {px, py}, p2: {px, py}, total: {px, py} }
let momentumPost = null; // same structure as momentumPre
let loopTimer = null;
let lastReal = 0;  // ms timestamp of last loop iteration
let acc = 0;       // accumulated simulation seconds

// Listen for messages from the main thread.  The UI uses this
// interface to start, pause/resume the simulation and adjust the
// simulation speed.
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
            lastReal = performance.now();
            loop();
        } else if (msg.type === 'setSpeed') {
            if (Number.isFinite(+msg.speed) && +msg.speed > 0) SPEED = +msg.speed;
        }
    } catch (err) {
        postMessage({ type: 'error', message: String(err?.message || err) });
    }
};

// Update the global parameters object based on incoming values.  Only
// known numeric keys are allowed; unknown keys are ignored.  Values
// outside reasonable ranges are clamped.
function applyParams(p = {}) {
    const next = { ...params };
    if (Number.isFinite(+p.m1) && +p.m1 > 0) next.m1 = +p.m1;
    if (Number.isFinite(+p.m2) && +p.m2 > 0) next.m2 = +p.m2;
    if (Number.isFinite(+p.r1) && +p.r1 > 0) next.r1 = +p.r1;
    if (Number.isFinite(+p.r2) && +p.r2 > 0) next.r2 = +p.r2;
    if (Number.isFinite(+p.v1) && +p.v1 >= 0) next.v1 = +p.v1;
    if (Number.isFinite(+p.angle1)) next.angle1 = +p.angle1;
    if (Number.isFinite(+p.v2) && +p.v2 >= 0) next.v2 = +p.v2;
    if (Number.isFinite(+p.angle2)) next.angle2 = +p.angle2;
    if (Number.isFinite(+p.x1)) next.x1 = +p.x1;
    if (Number.isFinite(+p.y1)) next.y1 = +p.y1;
    if (Number.isFinite(+p.x2)) next.x2 = +p.x2;
    if (Number.isFinite(+p.y2)) next.y2 = +p.y2;
    if (Number.isFinite(+p.dt) && +p.dt > 0) next.dt = +p.dt;
    if (Number.isFinite(+p.maxT) && +p.maxT > 0) next.maxT = +p.maxT;
    params = next;
}

// Initialise state and prime the first message.  This method is called
// whenever the UI sends a `start` message to the worker.
function start() {
    const th1 = (params.angle1 * Math.PI) / 180;
    const th2 = (params.angle2 * Math.PI) / 180;
    state = {
        x1: params.x1,
        y1: params.y1,
        vx1: params.v1 * Math.cos(th1),
        vy1: params.v1 * Math.sin(th1),
        x2: params.x2,
        y2: params.y2,
        vx2: params.v2 * Math.cos(th2),
        vy2: params.v2 * Math.sin(th2),
        t: 0
    };
    // Reset contact flag so that collisions can be detected
    inContact = false;
    momentumPre = null;
    momentumPost = null;
    running = true;
    acc = 0;
    lastReal = performance.now();

    // Send the initial state to seed the UI.  Each body contributes a
    // single point and the state includes velocity information.  We
    // duplicate the logic used in the projectile worker for consistency.
    postMessage({
        type: 'tick',
        points1: [{ x: state.x1, y: state.y1, t: state.t }],
        points2: [{ x: state.x2, y: state.y2, t: state.t }],
        state: {
            x1: state.x1, y1: state.y1, vx1: state.vx1, vy1: state.vy1,
            x2: state.x2, y2: state.y2, vx2: state.vx2, vy2: state.vy2,
            t: state.t,
            // Indicate no collision has occurred yet
            collided: false,
            momentumPre: momentumPre,
            momentumPost: momentumPost
        }
    });

    clearTimer();
    loop();
}

// Compute the momentum for each body and the total system momentum.  The
// returned object contains the x and y components for each body as well
// as the total.
function computeMomentum(s) {
    const p1 = { px: params.m1 * s.vx1, py: params.m1 * s.vy1 };
    const p2 = { px: params.m2 * s.vx2, py: params.m2 * s.vy2 };
    return {
        p1,
        p2,
        total: { px: p1.px + p2.px, py: p1.py + p2.py }
    };
}

// Resolve the collision between the two bodies.  This updates the
// velocities on `state` and sets the `collided`, `momentumPre` and
// `momentumPost` flags/values accordingly.
function resolveCollision() {
    // Only resolve when not already in contact; otherwise this would
    // repeatedly invert velocities on subsequent integration steps.
    if (inContact) return;
    // Capture momentum before resolving
    momentumPre = computeMomentum(state);
    const m1 = params.m1;
    const m2 = params.m2;
    const x1 = state.x1;
    const y1 = state.y1;
    const x2 = state.x2;
    const y2 = state.y2;
    // Relative position vectors
    const dx12 = x1 - x2;
    const dy12 = y1 - y2;
    const dist2 = dx12 * dx12 + dy12 * dy12 || 1e-12;
    // Velocities before collision
    const v1x = state.vx1, v1y = state.vy1;
    const v2x = state.vx2, v2y = state.vy2;
    // Velocity differences
    const dv1x = v1x - v2x;
    const dv1y = v1y - v2y;
    // Dot product of relative velocity and relative position
    const dot1 = dv1x * dx12 + dv1y * dy12;
    // Compute impulse factor for body 1
    const factor1 = (2 * m2 / (m1 + m2)) * (dot1 / dist2);
    // Update velocities for body 1
    const vx1New = v1x - factor1 * dx12;
    const vy1New = v1y - factor1 * dy12;
    // For body 2, swap roles
    const dx21 = -dx12;
    const dy21 = -dy12;
    const dv2x = v2x - v1x;
    const dv2y = v2y - v1y;
    const dot2 = dv2x * dx21 + dv2y * dy21;
    const factor2 = (2 * m1 / (m1 + m2)) * (dot2 / dist2);
    const vx2New = v2x - factor2 * dx21;
    const vy2New = v2y - factor2 * dy21;
    state.vx1 = vx1New;
    state.vy1 = vy1New;
    state.vx2 = vx2New;
    state.vy2 = vy2New;
    // Mark that a collision has been resolved for this contact.  The
    // `inContact` flag will be cleared when the bodies separate.
    inContact = true;
    // Capture momentum after resolving
    momentumPost = computeMomentum(state);
}

// Main simulation loop.  Mirrors the logic of the projectile POC
// simulation: accumulate real time scaled by SPEED, integrate a fixed
// number of dt steps, emit batches of points and reschedule.
function loop() {
    if (!running) return;
    const now = performance.now();
    acc += ((now - lastReal) / 1000) * SPEED;
    lastReal = now;
    const batch1 = [];
    const batch2 = [];
    let steps = 0;
    // Integrate as many dt steps as are owed by accumulated time but cap
    // the number of steps per frame to avoid long frame stalls.
    while (acc >= params.dt && steps < MAX_STEPS) {
        // previous positions (for collision interpolation if needed)
        const prev = { ...state };

        // advance positions
        state.x1 += state.vx1 * params.dt;
        state.y1 += state.vy1 * params.dt;
        state.x2 += state.vx2 * params.dt;
        state.y2 += state.vy2 * params.dt;


        // We defer bounding and time advancement until after collision
        // detection/resolution so that collision tests are performed on
        // unbounded positions.  Bounding is applied after handling
        // collisions (see below).

        // Check for collision: distance <= sum of radii.  Only resolve
        // when the bodies are not already in contact; when they
        // separate, the `inContact` flag is cleared below.
        const dx = state.x1 - state.x2;
        const dy = state.y1 - state.y2;
        const dist = Math.hypot(dx, dy);
        if (!inContact && dist <= params.r1 + params.r2) {
            // interpolate to find the approximate collision point between prev and current
            // positions.  Using linear interpolation on the separation distance to
            // approximate the exact moment of contact.
            const prevDx = prev.x1 - prev.x2;
            const prevDy = prev.y1 - prev.y2;
            const prevDist = Math.hypot(prevDx, prevDy);
            const denom = (prevDist - dist) || 1e-12;
            const alpha = (prevDist - (params.r1 + params.r2)) / denom;
            // Interpolated positions at the moment of contact
            const x1Hit = prev.x1 + alpha * (state.x1 - prev.x1);
            const y1Hit = prev.y1 + alpha * (state.y1 - prev.y1);
            const x2Hit = prev.x2 + alpha * (state.x2 - prev.x2);
            const y2Hit = prev.y2 + alpha * (state.y2 - prev.y2);
            // Advance state to the exact collision point before resolving
            state.x1 = x1Hit;
            state.y1 = y1Hit;
            state.x2 = x2Hit;
            state.y2 = y2Hit;
            // Fire off a batch up to this point
            batch1.push({ x: state.x1, y: state.y1, t: state.t });
            batch2.push({ x: state.x2, y: state.y2, t: state.t });
            // resolve the collision
            resolveCollision();
            // continue with the remainder of the dt step.  To avoid the
            // possibility of an immediate re‑collision, advance a tiny
            // epsilon time.
            const eps = 1e-6;
            state.x1 += state.vx1 * eps;
            state.y1 += state.vy1 * eps;
            state.x2 += state.vx2 * eps;
            state.y2 += state.vy2 * eps;
            // continue to next iteration to integrate the rest of the frame
        }
        // After potential collision resolution, apply bounding: bodies bounce
        // off the defined box edges.  Bounding is applied here so that
        // collision detection above uses unbounded positions.  When a body
        // intersects a wall, it is moved back inside and its velocity
        // component perpendicular to the wall is flipped.
        // Horizontal bounds for body 1
        if (state.x1 - params.r1 < BOUNDS.xMin) {
            state.x1 = BOUNDS.xMin + params.r1;
            state.vx1 = Math.abs(state.vx1);
        } else if (state.x1 + params.r1 > BOUNDS.xMax) {
            state.x1 = BOUNDS.xMax - params.r1;
            state.vx1 = -Math.abs(state.vx1);
        }
        // Vertical bounds for body 1
        if (state.y1 - params.r1 < BOUNDS.yMin) {
            state.y1 = BOUNDS.yMin + params.r1;
            state.vy1 = Math.abs(state.vy1);
        } else if (state.y1 + params.r1 > BOUNDS.yMax) {
            state.y1 = BOUNDS.yMax - params.r1;
            state.vy1 = -Math.abs(state.vy1);
        }
        // Horizontal bounds for body 2
        if (state.x2 - params.r2 < BOUNDS.xMin) {
            state.x2 = BOUNDS.xMin + params.r2;
            state.vx2 = Math.abs(state.vx2);
        } else if (state.x2 + params.r2 > BOUNDS.xMax) {
            state.x2 = BOUNDS.xMax - params.r2;
            state.vx2 = -Math.abs(state.vx2);
        }
        // Vertical bounds for body 2
        if (state.y2 - params.r2 < BOUNDS.yMin) {
            state.y2 = BOUNDS.yMin + params.r2;
            state.vy2 = Math.abs(state.vy2);
        } else if (state.y2 + params.r2 > BOUNDS.yMax) {
            state.y2 = BOUNDS.yMax - params.r2;
            state.vy2 = -Math.abs(state.vy2);
        }
        // Advance the simulation time and decrement the accumulator
        state.t += params.dt;
        acc -= params.dt;
        steps++;
        // Append new positions after each dt step
        batch1.push({ x: state.x1, y: state.y1, t: state.t });
        batch2.push({ x: state.x2, y: state.y2, t: state.t });
        // Reset contact flag when the bodies have separated beyond the collision distance.
        // Recompute separation after bounding
        const dxAfter = state.x1 - state.x2;
        const dyAfter = state.y1 - state.y2;
        const distAfter = Math.hypot(dxAfter, dyAfter);
        if (inContact && distAfter > params.r1 + params.r2) {
            inContact = false;
        }
        // Stop the simulation if maximum simulated time exceeded
        if (state.t >= params.maxT) {
            running = false;
            break;
        }
    }
    // If there are any samples, send them to the UI
        if (batch1.length || batch2.length) {
        postMessage({
            type: 'tick',
            points1: batch1,
            points2: batch2,
            state: {
                x1: state.x1, y1: state.y1, vx1: state.vx1, vy1: state.vy1,
                x2: state.x2, y2: state.y2, vx2: state.vx2, vy2: state.vy2,
                t: state.t,
                // Mark collided true if momentum snapshots exist
                collided: momentumPre !== null && momentumPost !== null,
                momentumPre: momentumPre,
                momentumPost: momentumPost
            }
        });
    }
    // If the simulation has finished, send a `done` message and stop.
    if (!running) {
        postMessage({ type: 'done' });
        return;
    }
    // Schedule the next frame.  The 16 ms delay approximates 60 Hz.
    loopTimer = setTimeout(loop, 16);
}

// Cancel any pending timeouts
function clearTimer() {
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
}