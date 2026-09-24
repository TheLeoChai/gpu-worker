"""GPU occupancy check with retries for job preflights (LEO-179).

A single `nvidia-smi --query-compute-apps` probe can report a transient
process (a previous job's teardown, a desktop app touching CUDA) and refuse a
job on an idle GPU. This probes several times and only reports busy when every
probe saw a compute process; every probe's process list is kept so a refusal
receipt shows exactly what was seen.

Library use (stdlib only):
    sys.path.insert(0, os.environ["GPU_WORKER_TOOLS"])
    from gpu_idle_check import wait_for_idle_gpu
    result = wait_for_idle_gpu()        # {"idle": bool, "probes": [...]}
    if not result["idle"]:
        raise ValueError("GPU compute process already active: " + json.dumps(result["probes"]))

CLI:  python gpu_idle_check.py [--probes 3] [--interval 5]
      prints the result as JSON; exit 0 = idle, 1 = busy, 2 = nvidia-smi error.
"""
import argparse
import datetime
import json
import subprocess
import sys
import time

QUERY = ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]


def probe_compute_apps(run=subprocess.run):
    out = run(QUERY, capture_output=True, text=True, timeout=30, check=True).stdout
    apps = []
    for line in out.splitlines():
        if not line.strip():
            continue
        fields = [f.strip() for f in line.split(",")]
        pid, name, mem = (fields + ["", "", ""])[:3]
        apps.append({"pid": pid, "process_name": name, "used_memory_mib": mem, "raw": line.strip()})
    return apps


def wait_for_idle_gpu(probes=3, interval=5.0, run=subprocess.run, sleep=time.sleep):
    """Idle as soon as one probe sees no compute apps; busy only if all probes do."""
    seen = []
    for i in range(max(1, probes)):
        if i:
            sleep(interval)
        apps = probe_compute_apps(run)
        seen.append({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "compute_apps": apps})
        if not apps:
            return {"idle": True, "probes": seen}
    return {"idle": False, "probes": seen}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--probes", type=int, default=3)
    p.add_argument("--interval", type=float, default=5.0, help="seconds between probes")
    a = p.parse_args(argv)
    try:
        result = wait_for_idle_gpu(a.probes, a.interval)
    except (OSError, subprocess.SubprocessError) as e:
        print(json.dumps({"idle": None, "error": "%s: %s" % (type(e).__name__, e)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["idle"] else 1


if __name__ == "__main__":
    sys.exit(main())
