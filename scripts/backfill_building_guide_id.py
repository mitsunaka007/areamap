"""既存 MigrationShop に、半径 30m 以内で最も近い BuildingGuide を割り当てる（C-2 移行）。

すでに building_guide_id が入っている店舗はスキップ。
使い方:  python scripts/backfill_building_guide_id.py [--dry-run]
"""
import os
import sys
import math

os.environ.setdefault("DATABASE_URL", os.environ.get("DATABASE_URL", ""))

from app import app, db          # noqa: E402
from models import MigrationShop, BuildingGuide  # noqa: E402

RADIUS_M = 30.0


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    dry = "--dry-run" in sys.argv
    with app.app_context():
        guides = BuildingGuide.query.filter(BuildingGuide.is_active.is_(True)).all()
        shops = MigrationShop.query.filter(MigrationShop.building_guide_id.is_(None)).all()
        assigned = 0
        for s in shops:
            best = None
            best_d = RADIUS_M
            for g in guides:
                d = haversine_m(float(s.lat), float(s.lng), float(g.lat), float(g.lng))
                if d <= best_d:
                    best_d, best = d, g
            if best is not None:
                print(f"shop {s.id} ({s.shopname}) -> guide {best.id} ({best_d:.1f} m)")
                if not dry:
                    s.building_guide_id = best.id
                assigned += 1
        if not dry:
            db.session.commit()
        print(f"{'[dry-run] ' if dry else ''}assigned {assigned} / {len(shops)} shops")


if __name__ == "__main__":
    main()
