# Fix Windows GBK encoding crash when spawned without terminal
import sys
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

"""
Device launcher — starts audio_service + vision_service in parallel.
Spawned by Rust host as the 'runtime_module'.
"""

import subprocess
import os
import signal
import time

def main():
    config_arg = ""
    for i, arg in enumerate(sys.argv):
        if arg == "--config" and i + 1 < len(sys.argv):
            config_arg = sys.argv[i + 1]

    python = sys.executable
    cwd = os.getcwd()
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}

    procs = []

    # Log files for child processes
    audio_log = open(os.path.join(cwd, "wakefusion_audio.log"), "w", encoding="utf-8")
    vision_log = open(os.path.join(cwd, "wakefusion_vision.log"), "w", encoding="utf-8")

    # Start audio_service
    audio_cmd = [python, "-m", "wakefusion.services.audio_service"]
    if config_arg:
        audio_cmd += ["--config", config_arg]
    print(f"[launcher] Starting audio_service: {' '.join(audio_cmd)}")
    procs.append(subprocess.Popen(audio_cmd, cwd=cwd, env=env,
                                   stdout=audio_log, stderr=audio_log,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))

    # Start vision_service (uses its own argparse, not --config)
    vision_cmd = [python, "-m", "wakefusion.services.vision_service"]
    print(f"[launcher] Starting vision_service: {' '.join(vision_cmd)}")
    procs.append(subprocess.Popen(vision_cmd, cwd=cwd, env=env,
                                   stdout=vision_log, stderr=vision_log,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)))

    print(f"[launcher] Started {len(procs)} services")
    for p in procs:
        print(f"  PID {p.pid}")

    # Wait for any to exit, then kill all
    try:
        while True:
            for p in procs:
                ret = p.poll()
                if ret is not None:
                    print(f"[launcher] Process PID {p.pid} exited with code {ret}")
                    # Kill the other
                    for other in procs:
                        if other.pid != p.pid and other.poll() is None:
                            other.terminate()
                    return
            time.sleep(1)
    except KeyboardInterrupt:
        print("[launcher] Shutting down...")
        for p in procs:
            if p.poll() is None:
                p.terminate()


if __name__ == "__main__":
    main()
