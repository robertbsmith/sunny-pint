"""Shadow casting on a DSM raster using a sweep-line horizon algorithm."""

import numpy as np


def compute_shadow_mask(
    dsm: np.ndarray,
    sun_azimuth_deg: float,
    sun_altitude_deg: float,
    resolution: float,
    min_height: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute shadow mask and building mask.

    Returns (shadow, buildings) where both are bool arrays.
    Shadow on building pixels is cleared so the overlay only shows
    on ground-level areas.
    """
    if sun_altitude_deg <= 0:
        buildings = np.zeros(dsm.shape, dtype=bool)
        return np.ones(dsm.shape, dtype=bool), buildings

    ground = _local_min(dsm, radius=11)
    above_ground = dsm - ground
    buildings = above_ground >= max(min_height, 2.5)

    # If min_height filtering requested, flatten short objects.
    if min_height > 0:
        dsm = np.where(above_ground < min_height, ground, dsm)

    rows, cols = dsm.shape
    tan_alt = np.tan(np.radians(sun_altitude_deg))

    az = np.radians(sun_azimuth_deg)
    shadow_dc = -np.sin(az)
    shadow_dr = np.cos(az)

    if abs(shadow_dr) >= abs(shadow_dc):
        primary_step = 1 if shadow_dr >= 0 else -1
        secondary_per_step = shadow_dc / abs(shadow_dr)
        shadow = _sweep_rows(dsm, primary_step, secondary_per_step,
                             tan_alt, resolution)
    else:
        primary_step = 1 if shadow_dc >= 0 else -1
        secondary_per_step = shadow_dr / abs(shadow_dc)
        shadow = _sweep_cols(dsm, primary_step, secondary_per_step,
                             tan_alt, resolution)

    # Clear shadow on building footprints — you can't sit on a roof.
    shadow[buildings] = False
    return shadow, buildings


def _sweep_rows(dsm, row_step, col_offset_per_row, tan_alt, resolution):
    rows, cols = dsm.shape
    shadow = np.zeros((rows, cols), dtype=bool)
    dist_per_step = resolution * np.sqrt(1.0 + col_offset_per_row**2)

    if row_step > 0:
        row_order = range(rows)
    else:
        row_order = range(rows - 1, -1, -1)

    horizon_tan = np.full(cols, -np.inf, dtype=np.float64)

    for i, r in enumerate(row_order):
        if i == 0:
            continue

        horizon_tan = _interp_shift(horizon_tan, col_offset_per_row)
        elev = dsm[r]
        horizon_projected = horizon_tan - dist_per_step * tan_alt
        shadow[r] = elev < horizon_projected
        horizon_tan = np.maximum(horizon_projected, elev)

    return shadow


def _sweep_cols(dsm, col_step, row_offset_per_col, tan_alt, resolution):
    rows, cols = dsm.shape
    shadow = np.zeros((rows, cols), dtype=bool)
    dist_per_step = resolution * np.sqrt(1.0 + row_offset_per_col**2)

    if col_step > 0:
        col_order = range(cols)
    else:
        col_order = range(cols - 1, -1, -1)

    horizon_tan = np.full(rows, -np.inf, dtype=np.float64)

    for i, c in enumerate(col_order):
        if i == 0:
            continue

        horizon_tan = _interp_shift(horizon_tan, row_offset_per_col)
        elev = dsm[:, c]
        horizon_projected = horizon_tan - dist_per_step * tan_alt
        shadow[:, c] = elev < horizon_projected
        horizon_tan = np.maximum(horizon_projected, elev)

    return shadow


def _interp_shift(arr, offset):
    """Shift a 1D array by a fractional offset using linear interpolation."""
    n = len(arr)
    if offset == 0:
        return arr.copy()

    frac = offset - int(offset)
    shift_int = int(offset)

    if shift_int > 0:
        shifted = np.full(n, -np.inf)
        shifted[shift_int:] = arr[:n - shift_int]
    elif shift_int < 0:
        shifted = np.full(n, -np.inf)
        shifted[:n + shift_int] = arr[-shift_int:]
    else:
        shifted = arr.copy()

    if frac == 0:
        return shifted

    if frac > 0:
        left = shifted
        right = np.full(n, -np.inf)
        right[1:] = shifted[:n - 1]
    else:
        frac = -frac
        left = shifted
        right = np.full(n, -np.inf)
        right[:n - 1] = shifted[1:]

    return left * (1 - frac) + right * frac


def _local_min(arr: np.ndarray, radius: int = 11) -> np.ndarray:
    """Fast local minimum using separable sliding window."""
    h, w = arr.shape
    out = arr.copy()
    padded = np.pad(out, ((0, 0), (radius, radius)), mode="edge")
    for i in range(1, 2 * radius + 1):
        np.minimum(out, padded[:, i:i + w], out=out)
    padded = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
    for i in range(1, 2 * radius + 1):
        np.minimum(out, padded[i:i + h, :], out=out)
    return out
