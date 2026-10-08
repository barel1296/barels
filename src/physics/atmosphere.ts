/** International Standard Atmosphere (troposphere + lower stratosphere). */

export const RHO0 = 1.225;
const T0 = 288.15;
const LAPSE = 0.0065;

export function temperature(alt: number): number {
  return Math.max(216.65, T0 - LAPSE * Math.max(alt, 0));
}

export function density(alt: number): number {
  const h = Math.max(alt, 0);
  if (h <= 11000) return RHO0 * Math.pow(1 - (LAPSE * h) / T0, 4.2559);
  const rho11 = RHO0 * Math.pow(1 - (LAPSE * 11000) / T0, 4.2559);
  return rho11 * Math.exp(-(h - 11000) / 6341.6);
}

export function speedOfSound(alt: number): number {
  return Math.sqrt(1.4 * 287.05 * temperature(alt));
}
