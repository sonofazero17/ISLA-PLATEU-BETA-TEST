"""Runs every browser check in this folder and reports a summary.
Needs Python Playwright:  pip install playwright  &&  playwright install chromium
Run:  python3 tests/browser/run.py      (screenshots go to $SHOTS_DIR, default: <temp>/isla-shots)"""
import os, re, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
failed = []
for name in sorted(f for f in os.listdir(here) if f.endswith("_ui.py")):
    t0 = time.time()
    r = subprocess.run([sys.executable, os.path.join(here, name)], capture_output=True, text=True, timeout=600)
    out = r.stdout + r.stderr
    bad = r.returncode != 0 or "Traceback" in out or re.search(r"^FAIL ", out, re.M) or re.search(r"issues: [1-9]", out)
    last = [l for l in out.splitlines() if re.search(r"passed, \d+ failed|issues: \d+", l)]
    print(("FAIL " if bad else "ok   ") + name.ljust(18) + (last[-1] if last else "") + f"  ({time.time() - t0:.0f}s)")
    if bad:
        failed.append(name); print("\n".join("     " + l for l in out.splitlines() if l.startswith("FAIL") or "Error" in l or "ISSUE" in l)[:2000])
print("\n%d of %d browser checks failed" % (len(failed), len(os.listdir(here)) and len([f for f in os.listdir(here) if f.endswith('_ui.py')])))
sys.exit(1 if failed else 0)
