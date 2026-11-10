"""Bounded, automated PTY driver. Never opens a GUI terminal or generates OS key events."""
import base64
import errno
import json
import os
import pty
import select
import subprocess
import sys
import termios
import time

node, child, root, scenario = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
process = subprocess.Popen([node, child, root, scenario], stdin=slave, stdout=slave, stderr=slave,
                           env=os.environ.copy(), close_fds=True)
output = bytearray()
try:
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            output.extend(chunk)
        elif process.poll() is not None:
            break
    if process.poll() is None:
        raise RuntimeError("automated TUI subprocess exceeded 6 seconds")
    after = termios.tcgetattr(slave)
    mask = termios.ISIG | termios.ICANON | termios.ECHO
    print(json.dumps({
        "code": process.returncode,
        "outputBase64": base64.b64encode(output).decode(),
        "rawRestored": (before[3] & mask) == (after[3] & mask),
        "lflagBefore": before[3], "lflagAfter": after[3],
    }))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    os.close(slave)
