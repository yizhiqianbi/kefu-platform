"""Compare the auto grader with the manual grades of round 1 (eval/answers_*.json) for the 木序 tenant."""
import asyncio
import json
import runpy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import auth  # noqa: E402
import db  # noqa: E402
import grading  # noqa: E402
import settings  # noqa: E402

EVAL = Path(__file__).parent.parent / "eval"
MANUAL = settings.DATA_DIR / "manual_grades.json"
if not MANUAL.exists():
    json.dump(runpy.run_path(str(EVAL / "write_report.py"))["grades"], open(MANUAL, "w"), ensure_ascii=False, indent=1)
manual = json.load(open(MANUAL))


def manual_verdict(tag, code):
    v = manual[tag].get(code, ("答对", ""))[0]
    return "保守" if v.startswith("保守") else v


async def main(slug="muxu"):
    db.init()
    tenant = auth.tenant_by_slug(slug)
    tests = {t["code"]: t for t in db.q("SELECT * FROM tests WHERE tenant_id=:t", t=tenant["id"])}
    truth = await grading.build_truth(tenant, fresh=True)
    sem = asyncio.Semaphore(8)

    async def one(tag, o):
        async with sem:
            v, reason = await grading.judge(tenant, truth, tests[o["id"]], o["answer"])
            return tag, o["id"], manual_verdict(tag, o["id"]), v, reason

    jobs = [one(t, o) for t in "AB" for o in json.load(open(EVAL / f"answers_{t}.json"))]
    res = await asyncio.gather(*jobs)
    agree = sum(1 for r in res if r[2] == r[3])
    print(f"agreement {agree}/{len(res)}")
    for r in res:
        if r[2] != r[3]:
            print(f"  {r[0]} {r[1]} manual={r[2]} auto={r[3]} | {r[4]}")
    json.dump(res, open(settings.DATA_DIR / "calibration.json", "w"), ensure_ascii=False, indent=1)


asyncio.run(main())
