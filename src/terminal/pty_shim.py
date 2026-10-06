#!/usr/bin/env python3
"""
terminal/pty_shim.py — zero-dependency PTY bridge.

Runs:  python3 pty_shim.py <cmd> [argv...]

pty.openpty() gives us a master/slave pair; the child gets the slave for
stdin/stdout/stderr (so isatty() is true). We shuttle bytes between our own
stdin/stdout pipes and the master fd — the host process writes to our stdin
to feed the terminal, reads our stdout for terminal output. Ctrl-C etc.
pass through naturally as bytes to the master.
"""

import os
import pty
import select
import subprocess
import sys


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: pty_shim.py <cmd> [argv...]\n")
        return 2

    master, slave = pty.openpty()
    try:
        # Reasonable default size — hosts that care can ioctl later
        import fcntl
        import struct
        import termios
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    except Exception:
        pass

    proc = subprocess.Popen(
        sys.argv[1:],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    os.set_blocking(stdin_fd, False)
    os.set_blocking(master, False)

    try:
        while True:
            if proc.poll() is not None:
                # drain any final output
                try:
                    rest = os.read(master, 65536)
                    if rest:
                        os.write(stdout_fd, rest)
                except OSError:
                    pass
                return proc.returncode or 0

            r, _, _ = select.select([master, stdin_fd], [], [], 0.1)
            for fd in r:
                if fd == master:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        data = b""
                    if not data:
                        continue
                    try:
                        os.write(stdout_fd, data)
                    except OSError:
                        return proc.wait()
                else:
                    try:
                        data = os.read(stdin_fd, 65536)
                    except OSError:
                        data = b""
                    if data:
                        try:
                            os.write(master, data)
                        except OSError:
                            pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
