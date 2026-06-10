"""Statistical detectors (docs/09 §9.1). Deterministic, versioned, no LLM.

These run cheaply over semantic-layer series; only material, surviving
signals ever wake an agent.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass

DETECTOR_VERSION = "v1"


@dataclass
class AnomalySignal:
    detector: str
    index: int  # index in the series where the anomaly fires
    direction: str  # up | down
    magnitude: float  # relative change vs baseline
    score: float  # z-score or cusum statistic


def robust_zscore(
    series: list[float],
    min_baseline: int = 14,
    threshold: float = 3.0,
) -> list[AnomalySignal]:
    """Median/MAD z-score on the latest points vs the trailing baseline.

    MAD-based, so single past outliers do not inflate the tolerance band.
    """
    signals: list[AnomalySignal] = []
    for i in range(min_baseline, len(series)):
        baseline = series[max(0, i - 28) : i]
        med = statistics.median(baseline)
        mad = statistics.median([abs(x - med) for x in baseline])
        # MAD=0 means the bulk of the baseline is flat; a stdev fallback would
        # let a single historical outlier blind the detector. Use a tight
        # tolerance band around the median instead.
        sigma = 1.4826 * mad if mad > 0 else max(0.05 * abs(med), 1e-9)
        z = (series[i] - med) / sigma
        if abs(z) >= threshold:
            signals.append(
                AnomalySignal(
                    detector="zscore",
                    index=i,
                    direction="up" if z > 0 else "down",
                    magnitude=(series[i] - med) / med if med != 0 else 0.0,
                    score=round(z, 2),
                )
            )
    return signals


def cusum(
    series: list[float],
    k_sigma: float = 0.5,
    h_sigma: float = 4.0,
    min_baseline: int = 14,
) -> list[AnomalySignal]:
    """Tabular CUSUM for slow drifts a daily z-score never catches."""
    if len(series) <= min_baseline:
        return []
    baseline = series[:min_baseline]
    mu = statistics.mean(baseline)
    sigma = statistics.pstdev(baseline) or 1e-9
    k = k_sigma * sigma
    h = h_sigma * sigma
    s_hi = 0.0
    s_lo = 0.0
    signals: list[AnomalySignal] = []
    for i in range(min_baseline, len(series)):
        x = series[i]
        s_hi = max(0.0, s_hi + (x - mu - k))
        s_lo = max(0.0, s_lo + (mu - x - k))
        if s_hi > h or s_lo > h:
            direction = "up" if s_hi > h else "down"
            signals.append(
                AnomalySignal(
                    detector="cusum",
                    index=i,
                    direction=direction,
                    magnitude=(x - mu) / mu if mu != 0 else 0.0,
                    score=round(max(s_hi, s_lo) / sigma, 2),
                )
            )
            s_hi = 0.0
            s_lo = 0.0
    return signals


@dataclass
class FatigueFit:
    peak_index: int
    decay_pct_per_day: float
    total_decline_pct: float
    is_fatigued: bool


def fit_fatigue_curve(
    series: list[float],
    min_points: int = 7,
    fatigue_decline_pct: float = 25.0,
    min_decay_per_day_pct: float = 2.0,
) -> FatigueFit:
    """Detects sustained post-peak decay in a creative performance series
    (IPM/CTR by day). Linear fit on the post-peak segment, relative to peak."""
    if len(series) < min_points or max(series, default=0) <= 0:
        return FatigueFit(0, 0.0, 0.0, False)
    peak_index = series.index(max(series))
    post = series[peak_index:]
    if len(post) < 4:
        return FatigueFit(peak_index, 0.0, 0.0, False)
    n = len(post)
    xs = list(range(n))
    mean_x = sum(xs) / n
    mean_y = sum(post) / n
    denom = sum((x - mean_x) ** 2 for x in xs) or 1e-9
    slope = sum((xs[i] - mean_x) * (post[i] - mean_y) for i in range(n)) / denom
    peak = post[0]
    decay_pct_per_day = -slope / peak * 100 if peak > 0 else 0.0
    total_decline_pct = (peak - post[-1]) / peak * 100 if peak > 0 else 0.0
    is_fatigued = (
        total_decline_pct >= fatigue_decline_pct
        and decay_pct_per_day >= min_decay_per_day_pct
    )
    return FatigueFit(
        peak_index=peak_index,
        decay_pct_per_day=round(decay_pct_per_day, 2),
        total_decline_pct=round(total_decline_pct, 2),
        is_fatigued=is_fatigued,
    )
