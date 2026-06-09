from gros_workers.detection.detectors import cusum, fit_fatigue_curve, robust_zscore


def test_zscore_fires_on_planted_spike() -> None:
    series = [100.0] * 20 + [100.0, 240.0]
    signals = robust_zscore(series)
    assert any(s.direction == "up" and s.index == 21 for s in signals)


def test_zscore_fires_on_planted_cliff() -> None:
    series = [100.0, 102.0, 99.0, 101.0, 100.0] * 4 + [38.0]
    signals = robust_zscore(series)
    assert any(s.direction == "down" and s.index == len(series) - 1 for s in signals)


def test_zscore_stays_silent_on_noisy_but_stable_series() -> None:
    # weekday-ish wobble around 100, no real change
    series = [100 + (i % 7) - 3 + (0.5 if i % 2 else -0.5) for i in range(40)]
    assert robust_zscore(series) == []


def test_zscore_is_robust_to_a_single_past_outlier() -> None:
    # one historical spike must not blind the detector to a real new cliff
    series = [100.0] * 10 + [300.0] + [100.0] * 10 + [40.0]
    signals = robust_zscore(series)
    assert any(s.direction == "down" and s.index == len(series) - 1 for s in signals)


def test_cusum_catches_slow_drift_that_zscore_misses() -> None:
    # 1% daily erosion: never a daily outlier, ruinous over a month
    series = [100.0 * (0.99**i) for i in range(45)]
    assert robust_zscore(series, threshold=3.5) == []
    drift = cusum(series)
    assert any(s.direction == "down" for s in drift)


def test_cusum_silent_on_stable_series() -> None:
    series = [100.0, 101.0, 99.5, 100.5, 100.0] * 8
    assert cusum(series) == []


def test_fatigue_curve_detects_post_peak_decay() -> None:
    series = [4.0, 4.4, 4.7, 4.9, 5.0] + [5.0 - 0.11 * i for i in range(1, 24)]
    fit = fit_fatigue_curve(series)
    assert fit.is_fatigued
    assert fit.peak_index == 4
    assert fit.total_decline_pct > 25
    assert fit.decay_pct_per_day >= 2


def test_fatigue_curve_silent_on_stable_creative() -> None:
    series = [4.0, 4.1, 3.9, 4.0, 4.05, 3.95, 4.0, 4.1, 4.0, 3.9, 4.0, 4.05]
    fit = fit_fatigue_curve(series)
    assert not fit.is_fatigued


def test_fatigue_curve_handles_short_series() -> None:
    assert not fit_fatigue_curve([4.0, 3.0]).is_fatigued
