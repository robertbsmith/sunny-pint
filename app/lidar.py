"""Load and query EA LiDAR DSM GeoTIFF tiles."""

from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import reproject, calculate_default_transform, Resampling
from rasterio.windows import from_bounds
from rasterio.transform import from_origin
from pyproj import Transformer


def _reproject_rgba_to_wgs84(img_rgba, src_transform, src_shape):
    """Reproject an RGBA image from OSGB to WGS84.

    Returns (reprojected_rgba, [[south, west], [north, east]]).
    """
    rows, cols = src_shape
    left = src_transform.c
    top = src_transform.f
    right = left + cols * abs(src_transform.a)
    bottom = top - rows * abs(src_transform.e)

    dst_transform, dst_width, dst_height = calculate_default_transform(
        "EPSG:27700", "EPSG:4326", cols, rows,
        left=left, bottom=bottom, right=right, top=top,
    )

    dst = np.zeros((dst_height, dst_width, 4), dtype=np.uint8)
    for band in range(4):
        reproject(
            source=img_rgba[:, :, band],
            destination=dst[:, :, band],
            src_transform=src_transform,
            src_crs="EPSG:27700",
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            resampling=Resampling.nearest,
        )

    west = dst_transform.c
    north = dst_transform.f
    east = west + dst_width * abs(dst_transform.a)
    south = north + dst_height * dst_transform.e  # e is negative

    return dst, [[south, west], [north, east]]


def _to_wgs_polys(geom, to_wgs):
    """Convert a shapely geometry (OSGB) to list of WGS84 [[lat,lng],...] rings."""
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        parts = [geom]
    elif geom.geom_type == "MultiPolygon":
        parts = list(geom.geoms)
    else:
        return []

    result = []
    for p in parts:
        if p.is_empty or p.exterior is None:
            continue
        coords = []
        for e, n in p.exterior.coords:
            lng, lat = to_wgs.transform(e, n)
            coords.append([lat, lng])
        result.append(coords)
    return result


def _reconstruct_dsm(dsm, osm_mask, osm_polys, tfm, min_height):
    """Rebuild DSM using OSM building shapes with LiDAR-sampled heights.

    Returns (clean_dsm, ground).
    """
    from .shadow import _local_min

    ground = _local_min(dsm, radius=11)

    if not osm_mask.any():
        return dsm, ground

    clean = _rebuild_with_per_building_heights(dsm, ground, osm_mask,
                                                osm_polys, tfm)
    return clean, ground


def _rebuild_with_per_building_heights(aligned_dsm, ground, osm_mask,
                                        osm_polys, tfm):
    """Rebuild DSM: ground everywhere, each building polygon filled at its
    90th-percentile LiDAR height."""
    from rasterio.features import rasterize

    rows, cols = aligned_dsm.shape
    clean = ground.copy()

    if not osm_polys:
        return clean

    # Rasterize with unique IDs per building.
    shapes = [(p, i + 1) for i, p in enumerate(osm_polys)]
    labels = rasterize(
        shapes, out_shape=(rows, cols), transform=tfm,
        fill=0, dtype=np.int32,
    )

    # For each building, compute roof height from aligned LiDAR.
    for bid in range(1, len(osm_polys) + 1):
        mask = labels == bid
        if not mask.any():
            continue

        heights = aligned_dsm[mask]
        local_ground = np.median(ground[mask])

        # Only consider pixels well above ground (ignore misaligned edges
        # where LiDAR reads ground inside the building polygon).
        above = heights[heights > local_ground + 2.0]

        if len(above) > 0:
            roof_h = float(np.percentile(above, 90))
        else:
            # All pixels are near ground — building too small or
            # totally misaligned. Use max as fallback.
            roof_h = float(heights.max())

        # Only set if it's meaningfully above ground.
        if roof_h > local_ground + 2.0:
            clean[mask] = roof_h

    return clean


class LidarManager:
    """Index of local LiDAR GeoTIFFs with on-demand windowed reads."""

    def __init__(self, data_dir: str = "data"):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.to_osgb = Transformer.from_crs(
            "EPSG:4326", "EPSG:27700", always_xy=True
        )
        self.to_wgs = Transformer.from_crs(
            "EPSG:27700", "EPSG:4326", always_xy=True
        )
        self.tiles: list[tuple[Path, rasterio.coords.BoundingBox]] = []
        self._index_tiles()

    def _index_tiles(self):
        """Scan data directory and record each raster's OSGB bounds."""
        for pattern in ("**/*.tif", "**/*.asc"):
            for path in sorted(self.data_dir.glob(pattern)):
                try:
                    with rasterio.open(path) as ds:
                        self.tiles.append((path, ds.bounds))
                except Exception as exc:
                    print(f"skip {path}: {exc}")

    @property
    def has_data(self) -> bool:
        return len(self.tiles) > 0

    def _find_tiles(self, w: float, s: float, e: float, n: float) -> list[Path]:
        """Return tile paths overlapping an OSGB bounding box."""
        return [
            p
            for p, b in self.tiles
            if b.right > w and b.left < e and b.top > s and b.bottom < n
        ]

    def _read_area(self, w, s, e, n):
        """Read DSM for an OSGB bbox. Returns (array, Affine) or (None, None)."""
        import math
        from rasterio.transform import from_origin

        paths = self._find_tiles(w, s, e, n)
        if not paths:
            return None, None

        # Snap to 1 m grid (EA tiles sit on integer-metre boundaries).
        w = math.floor(w)
        s = math.floor(s)
        e = math.ceil(e)
        n = math.ceil(n)

        cols = int(e - w)
        rows = int(n - s)
        out = np.zeros((rows, cols), dtype=np.float32)
        tfm = from_origin(w, n, 1.0, 1.0)  # top-left, 1 m pixels

        for path in paths:
            ds = rasterio.open(path)
            tb = ds.bounds

            # Overlap in OSGB.
            ol = max(w, tb.left)
            ob = max(s, tb.bottom)
            or_ = min(e, tb.right)
            ot = min(n, tb.top)
            if ol >= or_ or ob >= ot:
                ds.close()
                continue

            win = from_bounds(ol, ob, or_, ot, ds.transform)
            tile = ds.read(1, window=win)
            ds.close()

            # Clean nodata.
            tile = np.where(np.isnan(tile) | (tile < -100), 0, tile)

            # Correct position in the output array.
            c0 = int(ol - w)
            r0 = int(n - ot)
            th, tw = tile.shape
            out[r0:r0 + th, c0:c0 + tw] = np.maximum(
                out[r0:r0 + th, c0:c0 + tw], tile
            )

        return out, tfm

    def query(self, north, south, east, west, sun_az, sun_alt, seats,
              min_height=0.0):
        """Compute shadows for a WGS-84 bbox and list of seats.

        Returns a dict with shadow_image (base64 PNG), image_bounds,
        per-seat sun/shade status, and has_lidar flag.  Returns None if
        no LiDAR data covers the area.
        """
        import base64
        from io import BytesIO
        from PIL import Image
        from .shadow import compute_shadow_mask

        # Convert bbox to OSGB with 200 m buffer for distant shadow sources.
        ow, os_ = self.to_osgb.transform(west, south)
        oe, on = self.to_osgb.transform(east, north)
        buf = 200
        dsm, tfm = self._read_area(ow - buf, os_ - buf, oe + buf, on + buf)
        if dsm is None:
            return None

        resolution = abs(tfm.a)

        # Fetch real OSM building outlines.
        from .buildings import get_buildings
        buildings, osgb_polys, building_polys = get_buildings(
            south, west, north, east, tfm, dsm.shape
        )

        have_osm_buildings = buildings.any()

        if have_osm_buildings:
            clean_dsm, ground = _reconstruct_dsm(
                dsm, buildings, osgb_polys, tfm, min_height
            )
        else:
            from .shadow import _local_min
            ground = _local_min(dsm, radius=11)
            buildings = (dsm - ground) >= max(min_height, 3.0)
            clean_dsm = dsm

        shadow, _ = compute_shadow_mask(
            clean_dsm, sun_az, sun_alt, resolution, min_height=min_height
        )

        # Clear shadow on building footprints.
        shadow[buildings] = False

        # Clip to the un-buffered garden area for the overlay image.
        inv = ~tfm
        c0, r0 = (int(v) for v in inv * (ow, on))
        c1, r1 = (int(v) for v in inv * (oe, os_))
        r0 = max(r0, 0)
        c0 = max(c0, 0)
        r1 = min(r1, shadow.shape[0])
        c1 = min(c1, shadow.shape[1])
        clipped = shadow[r0:r1, c0:c1]
        clipped_bld = buildings[r0:r1, c0:c1]

        # Sun percentage (excluding building pixels from the count).
        ground_mask = ~clipped_bld
        ground_px = int(ground_mask.sum())
        shaded_ground = int((clipped & ground_mask).sum())
        sun_pct = float(round(100 * (1 - shaded_ground / ground_px), 1)) if ground_px else 0.0

        # Smooth vectorization: Gaussian blur + marching squares.
        # The blur creates a gradient at shadow edges; marching squares
        # interpolates at sub-pixel positions through the gradient,
        # producing inherently smooth boundaries.
        from scipy.ndimage import gaussian_filter
        from skimage.measure import find_contours
        from shapely.geometry import Polygon as ShapelyPolygon
        from shapely.ops import unary_union

        ground_shadow = (clipped & ~clipped_bld).astype(np.float64)
        smoothed = gaussian_filter(ground_shadow, sigma=2.0)

        # Marching squares at the 0.5 iso-contour.
        contours = find_contours(smoothed, level=0.5)

        # Convert pixel coords to OSGB.
        origin_e = tfm.c + c0 * resolution
        origin_n = tfm.f - r0 * resolution
        shadow_osgb = []
        for contour in contours:
            if len(contour) < 4:
                continue
            coords = [(origin_e + col * resolution,
                        origin_n - row * resolution)
                       for row, col in contour]
            poly = ShapelyPolygon(coords)
            if poly.is_valid and not poly.is_empty and poly.area > 2:
                shadow_osgb.append(poly)

        shadow_polys_wgs = []
        if shadow_osgb:
            shadow_union = unary_union(shadow_osgb)
            # Subtract buildings for crisp building-adjacent edges.
            if osgb_polys:
                bld_union = unary_union(osgb_polys)
                shadow_union = shadow_union.difference(bld_union)
            shadow_polys_wgs = _to_wgs_polys(shadow_union, self.to_wgs)

        return {
            "shadow_polys": shadow_polys_wgs,
            "buildings": building_polys,
            "sun_pct": sun_pct,
            "has_lidar": True,
        }

    def debug_layers(self, north, south, east, west, min_height=6.0):
        """Return debug visualization images for the DSM pipeline."""
        import base64
        from io import BytesIO
        from PIL import Image
        from .shadow import _local_min
        from .buildings import get_buildings

        ow, os_ = self.to_osgb.transform(west, south)
        oe, on = self.to_osgb.transform(east, north)
        buf = 50
        dsm, tfm = self._read_area(ow - buf, os_ - buf, oe + buf, on + buf)
        if dsm is None:
            return None

        buildings, osgb_polys, _ = get_buildings(south, west, north, east, tfm, dsm.shape)
        clean_dsm, ground = _reconstruct_dsm(
            dsm, buildings, osgb_polys, tfm, min_height
        )

        def _height_to_png_b64(arr):
            vmin, vmax = float(arr.min()), float(arr.max())
            if vmax <= vmin:
                vmax = vmin + 1
            norm = np.clip((arr - vmin) / (vmax - vmin), 0, 1)
            r = (np.clip(norm * 2, 0, 1) * 255).astype(np.uint8)
            g = (np.clip(2 - norm * 2, 0, 1) * 255).astype(np.uint8)
            b = np.zeros_like(r)
            a = np.full_like(r, 180)
            rgba = np.stack([r, g, b, a], axis=-1)
            rgba_wgs, bnds = _reproject_rgba_to_wgs84(rgba, tfm, arr.shape)
            pil = Image.fromarray(rgba_wgs, "RGBA")
            bio = BytesIO()
            pil.save(bio, format="PNG")
            return base64.b64encode(bio.getvalue()).decode(), bnds

        layers = {}
        bounds = None
        for name, arr in [("raw_dsm", dsm), ("clean_dsm", clean_dsm),
                          ("ground", ground)]:
            b64, bnds = _height_to_png_b64(arr)
            layers[name] = b64
            if bounds is None:
                bounds = bnds

        return {
            "bounds": bounds,
            "layers": layers,
        }

    def elevation_image(self, north, south, east, west):
        """Return a coloured elevation image for the given WGS-84 bbox."""
        import base64
        from io import BytesIO
        from PIL import Image

        ow, os_ = self.to_osgb.transform(west, south)
        oe, on = self.to_osgb.transform(east, north)
        dsm, tfm = self._read_area(ow, os_, oe, on)
        if dsm is None:
            return None

        # Normalise heights to 0-255 for visualisation.
        vmin, vmax = float(dsm[dsm > 0].min()) if (dsm > 0).any() else 0, float(dsm.max())
        if vmax <= vmin:
            return None
        norm = np.clip((dsm - vmin) / (vmax - vmin), 0, 1)

        # Colour ramp: low (green) → mid (yellow) → high (red/brown).
        r = np.clip(norm * 2, 0, 1)
        g = np.clip(2 - norm * 2, 0, 1)
        b = np.zeros_like(norm)
        alpha = np.where(dsm > 0, 0.55, 0.0)

        img = np.stack([
            (r * 255).astype(np.uint8),
            (g * 255).astype(np.uint8),
            (b * 255).astype(np.uint8),
            (alpha * 255).astype(np.uint8),
        ], axis=-1)

        pil = Image.fromarray(img, "RGBA")
        bio = BytesIO()
        pil.save(bio, format="PNG")

        img_w, img_s = self.to_wgs.transform(ow, os_)
        img_e, img_n = self.to_wgs.transform(oe, on)

        return {
            "image": base64.b64encode(bio.getvalue()).decode(),
            "bounds": [[img_s, img_w], [img_n, img_e]],
            "elevation_range": [round(vmin, 1), round(vmax, 1)],
        }
