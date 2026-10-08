/* In-page scripted landing pilot used by end-to-end tests (runs inside the browser). */
// eslint-disable-next-line no-unused-vars
window.__autoLand = function autoLand(code, end, maxSeconds) {
  const g = window.__game;
  const rw = g.runwayEnd(code, end);
  const D = Math.PI / 180;
  let flare = false;
  for (let t = 0; t < maxSeconds; t += 0.05) {
    const s = g.telemetry();
    if (!s || g.state() !== 'flying') break;
    const along = -((s.x - rw.x) * rw.dx + (s.z - rw.z) * rw.dz);
    const lat = (s.x - rw.x) * rw.dz - (s.z - rw.z) * rw.dx;
    const latVel = s.vx * rw.dz - s.vz * rw.dx;
    if (s.wheels > 0 && s.groundTime > 0.3) {
      const trackErr = Math.atan2(s.vx * rw.dz - s.vz * rw.dx, -(s.vx * rw.dx + s.vz * rw.dz) * -1);
      const yaw = Math.max(-1, Math.min(1, lat * 0.03 + trackErr * 2 - s.r * 0.8));
      g.simulate(0.05, { throttle: 0, pitch: 0, roll: 0, yaw, brake: Math.min(0.8, s.groundTime / 2) });
      continue;
    }
    const V = Math.max(s.airspeed, 1);
    if (s.agl < Math.max(4, s.approach * 0.14)) flare = true;
    let gammaDes;
    if (flare) gammaDes = -(0.25 * s.agl + 0.35) / V;
    else {
      const pathAlt = rw.elevation + Math.tan(3 * D) * Math.max(0, along + 300);
      gammaDes = -3 * D + Math.max(-0.06, Math.min(0.06, (pathAlt - s.altitude) * 0.004));
    }
    const pitch = Math.max(-1, Math.min(1, (2 * (gammaDes - s.gamma) - 0.3 * s.q) / s.fbw.pitchRate));
    const bankDes = Math.max(-0.3, Math.min(0.3, lat * 0.004 + latVel * 0.06));
    const roll = Math.max(-1, Math.min(1, ((bankDes - s.bank * D) * 2.5) / s.fbw.rollRate));
    const throttle = flare ? 0 : Math.max(0, Math.min(1, 0.35 + (s.approach - s.ias) * 0.08));
    g.simulate(0.05, { throttle, pitch, roll, yaw: 0 });
  }
  return { state: g.state(), mission: g.mission(), tel: g.telemetry() };
};
