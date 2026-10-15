#!/usr/bin/env python3
"""Small real-terminal driver for the CLI PTY checks.

The driver deliberately uses only the Python standard library.  It runs the compiled CLI behind
an actual pseudo-terminal, changes the terminal window size through TIOCSWINSZ, and records the
slave's termios state before and after the child so the Node tests can check restoration.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import traceback
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote


class ScenarioError(RuntimeError):
    """A bounded PTY assertion failed."""


last_transcript = ""


def termios_shape(attrs: list[Any]) -> list[Any]:
    """Convert tcgetattr's platform-specific bytes into JSON-safe values."""

    shape: list[Any] = []
    for value in attrs:
        if isinstance(value, bytes):
            shape.append(list(value))
        elif isinstance(value, list):
            shape.append([list(item) if isinstance(item, bytes) else item for item in value])
        else:
            shape.append(value)
    return shape


def status_code(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 255


class Session:
    """Run one command with stdin/stdout/stderr attached to one disposable PTY."""

    def __init__(self, command: list[str], cwd: Path, env: dict[str, str], cols: int = 80, rows: int = 24):
        self.command = command
        self.cwd = cwd
        self.env = env
        self.master: int | None = None
        self.pid: int | None = None
        self.output = bytearray()
        self.eof = False
        self.returncode: int | None = None
        self.termios_before: list[Any] | None = None
        self.termios_after: list[Any] | None = None
        fd, self.sidecar = tempfile.mkstemp(prefix="tonedial-pty-termios-")
        os.close(fd)

        pid, master = os.forkpty()
        if pid == 0:
            try:
                os.chdir(cwd)
                child_args = [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--child",
                    self.sidecar,
                    str(cwd),
                    *command,
                ]
                os.execvpe(sys.executable, child_args, env)
            except BaseException:
                os._exit(127)
        self.pid = pid
        self.master = master
        try:
            self.resize(cols, rows)
        except BaseException:
            self.close()
            raise

    def resize(self, cols: int, rows: int) -> None:
        if self.master is None:
            raise ScenarioError("PTY is closed")
        import fcntl

        try:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError as exc:
            raise ScenarioError(f"cannot resize PTY to {cols}x{rows}: {exc}") from exc

    def _read_available(self, timeout: float) -> None:
        if self.master is None or self.eof:
            return
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return
        try:
            chunk = os.read(self.master, 16384)
        except OSError:
            self.eof = True
            return
        if chunk:
            self.output.extend(chunk)
        else:
            self.eof = True

    def is_running(self) -> bool:
        if self.pid is None or self.returncode is not None:
            return False
        waited, status = os.waitpid(self.pid, os.WNOHANG)
        if waited == self.pid:
            self.returncode = status_code(status)
            self._read_available(0)
            return False
        return True

    def mark(self) -> int:
        return len(self.output)

    def wait_for(self, needles: Iterable[bytes], timeout: float = 5.0, since: int = 0) -> bytes:
        wanted = tuple(needles)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any(needle in self.output[since:] for needle in wanted):
                return bytes(self.output)
            if not self.is_running():
                break
            self._read_available(min(0.05, max(0.0, deadline - time.monotonic())))
        if any(needle in self.output[since:] for needle in wanted):
            return bytes(self.output)
        labels = ", ".join(repr(needle.decode("utf-8", "replace")) for needle in wanted)
        raise ScenarioError(f"timed out waiting for {labels}; output tail={self.output[-1200:].decode('utf-8', 'replace')!r}")

    def wait_until_running(self, timeout: float = 1.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.is_running():
                return False
            self._read_available(min(0.05, max(0.0, deadline - time.monotonic())))
        return self.is_running()

    def send(self, data: bytes) -> None:
        if self.master is None:
            raise ScenarioError("PTY is closed")
        view = memoryview(data)
        while view:
            try:
                written = os.write(self.master, view)
            except OSError as exc:
                raise ScenarioError(f"cannot write to PTY: {exc}") from exc
            view = view[written:]

    def wait(self, timeout: float = 5.0) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._read_available(min(0.05, max(0.0, deadline - time.monotonic())))
            if not self.is_running():
                break
        if self.returncode is None:
            raise ScenarioError(f"child did not exit within {timeout:.1f}s; output tail={self.output[-1200:].decode('utf-8', 'replace')!r}")
        # The PTY can still contain the final cursor-restore bytes after waitpid reports exit.
        for _ in range(4):
            self._read_available(0.01)
        self._load_termios()
        return self.returncode

    def _load_termios(self) -> None:
        try:
            with open(self.sidecar, "r", encoding="utf-8") as handle:
                record = json.load(handle)
            self.termios_before = record.get("before")
            self.termios_after = record.get("after")
        except (FileNotFoundError, json.JSONDecodeError):
            self.termios_before = None
            self.termios_after = None

    def close(self) -> None:
        global last_transcript
        self._read_available(0)
        last_transcript = self.output[-20000:].decode("utf-8", "replace")
        if self.pid is not None and self.returncode is None:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                _, status = os.waitpid(self.pid, 0)
                self.returncode = status_code(status)
            except ChildProcessError:
                pass
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
            self.master = None
        try:
            os.unlink(self.sidecar)
        except FileNotFoundError:
            pass

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()


def child_main(sidecar: str, cwd: str, command: list[str]) -> int:
    """Keep a Python parent around so the PTY slave can be inspected after Node exits."""

    before = termios_shape(termios.tcgetattr(0))
    child = subprocess.Popen(command, cwd=cwd, env=os.environ.copy())
    code = child.wait()
    after = termios_shape(termios.tcgetattr(0))
    with open(sidecar, "w", encoding="utf-8") as handle:
        json.dump({"before": before, "after": after}, handle)
    return 128 + (-code) if code < 0 else code


def base_env(scratch: Path, language: str) -> dict[str, str]:
    temp_dir = scratch / "tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    return {
        "HOME": str(scratch / "home"),
        "XDG_CONFIG_HOME": str(scratch / "xdg"),
        "XDG_CACHE_HOME": str(scratch / "cache"),
        "TONEDIAL_HOME": str(scratch / "state"),
        "TONEDIAL_AGENT_HOME": str(scratch / "agents"),
        "TONEDIAL_INSTALL_SHAPE": "npm",
        "PATH": "/usr/bin:/bin",
        "LANG": "ko_KR.UTF-8" if language == "ko" else "en_US.UTF-8",
        "LC_CTYPE": "C.UTF-8",
        "TMPDIR": str(temp_dir),
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "NODE_NO_WARNINGS": "1",
        "PYTHONIOENCODING": "utf-8",
    }


def snapshot(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not root.exists():
        return result
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            result[relative] = f"link:{os.readlink(path)}"
        elif path.is_file():
            result[relative] = f"file:{path.read_bytes().hex()}"
        elif path.is_dir():
            result[relative] = "directory"
    return result


def initialize(root: Path, scratch: Path, language: str, node: str, binary: Path) -> None:
    global last_transcript
    project = scratch / "project"
    project.mkdir(parents=True, exist_ok=True)
    env = base_env(scratch, language)
    try:
        result = subprocess.run(
            [node, str(binary), "init", "--lang", language, "--tools", "none", "--here", "--auto", "--json"],
            cwd=project,
            env=env,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        last_transcript = f"initialize stdout:\n{stdout[-12000:]}\ninitialize stderr:\n{stderr[-12000:]}"
        raise ScenarioError("state initialization timed out") from exc
    except Exception as exc:
        raise ScenarioError(f"state initialization could not start: {exc}") from exc

    def fail(message: str) -> None:
        global last_transcript
        last_transcript = (
            "initialize stdout:\n"
            + result.stdout[-12000:]
            + "\ninitialize stderr:\n"
            + result.stderr[-12000:]
        )
        raise ScenarioError(message)

    if result.returncode != 0:
        fail(f"state initialization failed with exit {result.returncode}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        fail(f"state initialization returned invalid JSON: {exc}")
    if payload.get("ok") is not True or payload.get("language") != language:
        fail(f"state initialization returned an unexpected receipt: {payload!r}")


def run_session(scratch: Path, language: str, node: str, binary: Path, args: list[str]) -> Session:
    project = scratch / "project"
    env = base_env(scratch, language)
    return Session([node, str(binary), *args], project, env)


def title(language: str) -> bytes:
    return "내 취향의 말투".encode() if language == "ko" else b"shape your agent's voice"


def help_title(language: str) -> bytes:
    return "다이얼 키".encode() if language == "ko" else b"Dial keys"


def too_small(language: str) -> bytes:
    return "터미널이 너무 작습니다".encode() if language == "ko" else b"Terminal too small"


def saved(language: str) -> bytes:
    return "설정 저장됨".encode() if language == "ko" else b"Settings saved"


def init_done(language: str) -> bytes:
    return "초기 설정 완료".encode() if language == "ko" else b"Setup complete"


def init_declined(language: str) -> bytes:
    return "취소됨".encode() if language == "ko" else b"cancelled"


def require_termios(session: Session, scenario: str) -> None:
    if session.termios_before is None or session.termios_after is None:
        raise ScenarioError(f"{scenario}: PTY wrapper did not record termios")
    if session.termios_before != session.termios_after:
        raise ScenarioError(f"{scenario}: termios changed across exit before={session.termios_before!r} after={session.termios_after!r}")


def require_cursor(session: Session, scenario: str) -> None:
    hidden = session.output.rfind(b"\x1b[?25l")
    shown = session.output.rfind(b"\x1b[?25h")
    if hidden < 0:
        raise ScenarioError(f"{scenario}: dial never hid the cursor")
    if shown < hidden:
        raise ScenarioError(f"{scenario}: dial did not restore the cursor after its last hide")


def apply_case(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-apply-"))
    try:
        initialize(root, scratch, language, node, binary)
        state = scratch / "state"
        before = snapshot(state)
        config_before = json.loads((state / "config.json").read_text(encoding="utf-8"))
        before_level = config_before["axes"]["formality"]
        with run_session(scratch, language, node, binary, ["set"]) as session:
            session.wait_for([title(language)])
            session.send(b"\x1b[C\r")
            code = session.wait(8)
            require_termios(session, "apply")
            require_cursor(session, "apply")
            if code != 0 or saved(language) not in session.output:
                raise ScenarioError(f"apply: exit={code}, output={session.output[-1600:].decode('utf-8', 'replace')!r}")
        config_after = json.loads((state / "config.json").read_text(encoding="utf-8"))
        if config_after["axes"]["formality"] != min(5, before_level + 1):
            raise ScenarioError("apply: right-arrow value was not persisted")
        if any(config_after["axes"][axis] != config_before["axes"][axis] for axis in config_before["axes"] if axis != "formality"):
            raise ScenarioError("apply: an unrelated axis changed")
        if snapshot(state) == before:
            raise ScenarioError("apply: state snapshot did not change")
        return {"exit": 0, "termiosRestored": True, "cursorRestored": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def cancel_case(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-cancel-"))
    try:
        initialize(root, scratch, language, node, binary)
        state = scratch / "state"
        before = snapshot(state)
        with run_session(scratch, language, node, binary, ["set"]) as session:
            session.wait_for([title(language)])
            session.send(b"\x1b[Cq")
            code = session.wait(8)
            require_termios(session, "cancel")
            require_cursor(session, "cancel")
            if code != 0:
                raise ScenarioError(f"cancel: exit={code}")
        if snapshot(state) != before:
            raise ScenarioError("cancel: state changed after q")
        return {"exit": 0, "termiosRestored": True, "cursorRestored": True, "unchanged": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def help_resize_case(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-resize-"))
    try:
        initialize(root, scratch, language, node, binary)
        state = scratch / "state"
        before = snapshot(state)
        with run_session(scratch, language, node, binary, ["set"]) as session:
            session.wait_for([title(language)])
            help_start = session.mark()
            session.send(b"?")
            session.wait_for([help_title(language)], since=help_start)
            resize_start = session.mark()
            session.resize(45, 10)
            session.wait_for([too_small(language)], since=resize_start)
            session.send(b"\x1b[C\r")
            if not session.wait_until_running():
                raise ScenarioError("resize: Enter exited while the preview was hidden")
            resume_start = session.mark()
            session.resize(60, 24)
            session.send(b"?")
            session.wait_for([title(language)], since=resume_start)
            session.send(b"q")
            code = session.wait(8)
            require_termios(session, "resize")
            require_cursor(session, "resize")
            if code != 0:
                raise ScenarioError(f"resize: exit={code}")
        if snapshot(state) != before:
            raise ScenarioError("resize: hidden preview changed state")
        return {"exit": 0, "termiosRestored": True, "cursorRestored": True, "help": True, "tooSmall": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def ctrl_c_case(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-ctrl-c-"))
    try:
        initialize(root, scratch, language, node, binary)
        before = snapshot(scratch / "state")
        with run_session(scratch, language, node, binary, ["set"]) as session:
            session.wait_for([title(language)])
            session.send(b"\x03")
            code = session.wait(8)
            require_termios(session, "ctrl-c")
            require_cursor(session, "ctrl-c")
            if code != 0:
                raise ScenarioError(f"ctrl-c: exit={code}")
        if snapshot(scratch / "state") != before:
            raise ScenarioError("ctrl-c: state changed")
        return {"exit": 0, "termiosRestored": True, "cursorRestored": True, "unchanged": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def error_case(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-error-"))
    try:
        initialize(root, scratch, language, node, binary)
        expected_title = json.dumps(title(language).decode("utf-8"), ensure_ascii=False)
        source = (
            f"const expected = {expected_title};"
            "const originalWrite = process.stdout.write;"
            "let observed = '';"
            "let armed = false;"
            "process.stdout.write = function (...args) {"
            "  const chunk = args[0];"
            "  const encoding = typeof args[1] === 'string' ? args[1] : 'utf8';"
            "  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding);"
            "  const result = Reflect.apply(originalWrite, this, args);"
            "  if (!armed) {"
            "    observed += text;"
            "    if (observed.includes(expected)) {"
            "      armed = true;"
            "      process.stdout.write = originalWrite;"
            "      setImmediate(() => { throw new Error('PTY async failure'); });"
            "    }"
            "    observed = observed.slice(-expected.length);"
            "  }"
            "  return result;"
            "};"
        )
        preload = "data:text/javascript," + quote(source, safe="")
        # The error is armed only after the real dial title has reached the PTY.
        env = base_env(scratch, language)
        project = scratch / "project"
        with Session([node, "--import", preload, str(binary), "set"], project, env) as session:
            session.wait_for([title(language)])
            code = session.wait(8)
            require_termios(session, "error")
            require_cursor(session, "error")
            if code == 0 or b"PTY async failure" not in session.output:
                raise ScenarioError(f"error: exit={code}, output={session.output[-1600:].decode('utf-8', 'replace')!r}")
        return {"exit": code, "termiosRestored": True, "cursorRestored": True, "error": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def init_case(root: Path, language: str, node: str, binary: Path, approve: bool) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix=f"tonedial-pty-init-{'yes' if approve else 'no'}-"))
    try:
        project = scratch / "project"
        project.mkdir(parents=True)
        env = base_env(scratch, language)
        with Session([node, str(binary), "init", "--lang", language, "--tools", "none", "--here"], project, env) as session:
            session.wait_for([b"  > "])
            # Answer each readline question after its prompt is observed. A burst of blank lines
            # can be consumed before the next readline listener is installed on some PTYs.
            prompt_start = session.mark()
            session.send(b"1\n")
            session.wait_for([b"Your name", "내 호칭".encode()], since=prompt_start)
            prompt_start = session.mark()
            session.send(b"\n")
            session.wait_for([b"Agent's name", "에이전트 호칭".encode()], since=prompt_start)
            prompt_start = session.mark()
            session.send(b"\n")
            session.wait_for([b"Safeword", "세이프워드".encode()], since=prompt_start)
            prompt_start = session.mark()
            session.send(b"\n")
            session.wait_for([b"[y/N]"], since=prompt_start)
            session.send(b"y\n" if approve else b"n\n")
            code = session.wait(8)
            require_termios(session, "init approval" if approve else "init cancel")
            if code != 0:
                raise ScenarioError(f"init {'approval' if approve else 'cancel'}: exit={code}")
            marker = init_done(language) if approve else init_declined(language)
            if marker not in session.output:
                raise ScenarioError(f"init {'approval' if approve else 'cancel'}: missing result marker")
        state = scratch / "state"
        files = snapshot(state)
        if approve:
            if not (state / "config.json").exists() or not (state / "TONE.md").exists():
                raise ScenarioError("init approval: state files were not written")
        elif files:
            raise ScenarioError(f"init cancel: state was written: {sorted(files)}")
        return {"exit": 0, "approved": approve, "termiosRestored": True, "written": approve}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def persona_case(root: Path, language: str, node: str, binary: Path, interrupt: bool) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-persona-"))
    try:
        initialize(root, scratch, language, node, binary)
        state = scratch / "state"
        before = snapshot(state)
        original = json.loads((state / "config.json").read_text())
        with run_session(scratch, language, node, binary, ["persona"]) as session:
            session.wait_for([b"  > "])
            start = session.mark()
            session.send(("😀" * 201 + "\n").encode())
            session.wait_for([b"  > "], since=start)
            if b"201" not in session.output[start:] or snapshot(state) != before:
                raise ScenarioError("persona retry did not reject 201 code points without writing")
            start = session.mark()
            session.send(b"Fictional reviewer\n")
            session.wait_for([b"  > "], since=start)
            if snapshot(state) != before:
                raise ScenarioError("persona wrote before both roles were supplied")
            session.send(b"\x03" if interrupt else b"\n")
            if session.wait(8) != (130 if interrupt else 0):
                raise ScenarioError("persona returned an unsuccessful exit")
            require_termios(session, "persona")
        if interrupt:
            if snapshot(state) != before:
                raise ScenarioError("interrupted persona changed files")
        else:
            config = json.loads((state / "config.json").read_text())
            if config["persona"]["agent"] != "Fictional reviewer" or config["persona"]["user"] != original["persona"]["user"]:
                raise ScenarioError("persona did not apply the agent role and keep the user's role")
            if config["axes"] != original["axes"] or config["persona"]["address"] != original["persona"]["address"]:
                raise ScenarioError("persona changed axes or address terms")
            if "Fictional reviewer" not in (state / "TONE.md").read_text():
                raise ScenarioError("persona did not recompile the role")
            with run_session(scratch, language, node, binary, ["persona"]) as session:
                session.wait_for([b"  > "])
                start = session.mark()
                session.send(b"\n")
                session.wait_for([b"  > "], since=start)
                session.send(b'""\n')
                if session.wait(8) != 0:
                    raise ScenarioError("persona clearing failed")
                require_termios(session, "persona clear")
            config = json.loads((state / "config.json").read_text())
            if config["persona"]["agent"] != "Fictional reviewer" or config["persona"]["user"] is not None:
                raise ScenarioError("persona did not keep one role and clear the other")
        return {"written": not interrupt, "termiosRestored": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def create_case(root: Path, language: str, node: str, binary: Path, outcome: str) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix=f"tonedial-pty-create-{outcome}-"))
    try:
        initialize(root, scratch, language, node, binary)
        state = scratch / "state"
        before = snapshot(state)
        with run_session(scratch, language, node, binary, ["create"]) as session:
            session.wait_for([b"  > "])
            if outcome == "interrupt":
                session.send(b"\x03")
                if session.wait() != 130:
                    raise ScenarioError("create interview: Ctrl+C did not interrupt")
            else:
                answers = [b"PTY Jarvis\n", b"pty-jarvis\n", b"guide\n", b"friend\n",
                           b"Maintains services\n", b"Fictional reviewer\n", b"polite\n", b"plain answer please\n"]
                for index, answer in enumerate(answers):
                    if outcome == "retry" and index == 4:
                        start = session.mark()
                        session.send(("x" * 201 + "\n").encode())
                        session.wait_for([b"  > "], since=start)
                        if b"201" not in session.output[start:] or snapshot(state) != before:
                            raise ScenarioError("create role retry lost its error or wrote state")
                    start = session.mark()
                    session.send(answer)
                    session.wait_for([title(language)] if index == len(answers) - 1 else [b"  > "], since=start)
                if snapshot(state) != before:
                    raise ScenarioError("create interview wrote files before approval")
                if outcome == "cancel":
                    session.send(b"\x1b")
                else:
                    approval_start = session.mark()
                    session.send(b"1\r")
                    session.wait_for([b"[y/N]"])
                    review = session.output[approval_start:]
                    heading = "저장할 프로필".encode() if language == "ko" else b"Profile to save"
                    if heading not in review or b"Fictional reviewer" not in review or b"18/200" not in review:
                        raise ScenarioError("create approval omitted the profile role summary")
                    if snapshot(state) != before:
                        raise ScenarioError("create dial wrote files before approval")
                    session.send(b"\x03" if outcome == "approval-interrupt" else b"y\n" if outcome in {"approve", "retry"} else b"n\n")
                if session.wait(8) != (130 if outcome == "approval-interrupt" else 0):
                    raise ScenarioError(f"create {outcome}: unsuccessful exit")
                require_cursor(session, f"create {outcome}")
            require_termios(session, f"create {outcome}")
        if outcome in {"approve", "retry"}:
            config = json.loads((state / "config.json").read_text())
            preset = json.loads((state / "presets" / "custom" / "pty-jarvis.json").read_text())
            if config["preset"] != "pty-jarvis" or config["axes"]["formality"] != 1:
                raise ScenarioError("create approval did not apply the selected axes")
            if config["persona"]["agent"] != "Fictional reviewer" or config["persona"]["user"] != "Maintains services" or config["persona"]["address"]["user_ref"] != "friend":
                raise ScenarioError("create approval did not keep shared settings")
            if set(preset) != {"schema", "slug", "displayName", "values", "settings"} or preset["schema"] != 2:
                raise ScenarioError("create approval did not save the complete profile")
            if preset["settings"]["persona"] != config["persona"]:
                raise ScenarioError("create approval lost the profile's personal settings")
            if "Fictional reviewer" not in (state / "TONE.md").read_text():
                raise ScenarioError("create approval did not compile the shared role")
        elif snapshot(state) != before:
            raise ScenarioError(f"create {outcome}: state changed")
        return {"written": outcome in {"approve", "retry"}, "termiosRestored": True}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def recovery_case(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    scratch = Path(tempfile.mkdtemp(prefix="tonedial-pty-recovery-")).resolve()
    try:
        initialize(root, scratch, language, node, binary)
        source = (
            f"import {{ seedRecoveryHistory, RECOVERY_OPERATION_ID }} from {json.dumps((root / 'test/support/maintenance.ts').as_uri())};"
            f"import {{ catalogue }} from {json.dumps((root / 'src/core/i18n.ts').as_uri())};"
            "seedRecoveryHistory(process.env);"
            f"const copy = catalogue({json.dumps(language)}).cli.recovery;"
            "console.log(JSON.stringify({ id: RECOVERY_OPERATION_ID, question: copy.resumeQuestion, cancelled: copy.cancelled, mismatch: copy.operationMismatch }));"
        )
        seeded = subprocess.run([node, "--input-type=module", "--eval", source], cwd=root,
                                env=base_env(scratch, language), text=True, encoding="utf-8",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if seeded.returncode != 0:
            raise ScenarioError(f"recovery fixture failed: {seeded.stderr[-1200:]}")
        selection = json.loads(seeded.stdout)
        state = scratch / "state"
        before = snapshot(state)
        prompt = ""
        for outcome, answer in [("blank", b"\n"), ("wrong", b"0" * 32 + b"\n"),
                                ("decline", selection["id"].encode() + b"\n")]:
            with run_session(scratch, language, node, binary, ["doctor", "--fix", "--here"]) as session:
                session.wait_for([selection["question"].encode()])
                if selection["id"].encode() not in session.output or snapshot(state) != before:
                    raise ScenarioError("recovery selection omitted its exact ID or wrote before selection")
                if outcome == "blank":
                    prompt = session.output.decode("utf-8").replace("\r\n", "\n").replace(str(scratch), "<ROOT>")
                start = session.mark()
                session.send(answer)
                if outcome == "decline":
                    session.wait_for([b"[y/N]"], since=start)
                    if snapshot(state) != before:
                        raise ScenarioError("matching the recovery ID authorized writes before plan approval")
                    session.send(b"n\n")
                code = session.wait(8)
                require_termios(session, f"recovery {outcome}")
                if code != (0 if outcome == "decline" else 1):
                    raise ScenarioError(f"recovery {outcome}: exit={code}")
                message = selection["cancelled"] if outcome == "blank" else selection["mismatch"] if outcome == "wrong" else None
                if message is not None and message.encode() not in session.output:
                    raise ScenarioError(f"recovery {outcome}: missing truthful selection result")
            if snapshot(state) != before:
                raise ScenarioError(f"recovery {outcome}: declined or rejected selection changed state")
        return {"unchanged": True, "termiosRestored": True, "prompt": prompt}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def run_all(root: Path, language: str, node: str, binary: Path) -> dict[str, Any]:
    global last_transcript
    cases = {
        "apply": lambda: apply_case(root, language, node, binary),
        "cancel": lambda: cancel_case(root, language, node, binary),
        "help-resize": lambda: help_resize_case(root, language, node, binary),
        "ctrl-c": lambda: ctrl_c_case(root, language, node, binary),
        "error": lambda: error_case(root, language, node, binary),
        "init-approve": lambda: init_case(root, language, node, binary, True),
        "init-cancel": lambda: init_case(root, language, node, binary, False),
        "persona-apply-retry-clear": lambda: persona_case(root, language, node, binary, False),
        "persona-interrupt": lambda: persona_case(root, language, node, binary, True),
        "create-approve": lambda: create_case(root, language, node, binary, "approve"),
        "create-role-retry": lambda: create_case(root, language, node, binary, "retry"),
        "create-decline": lambda: create_case(root, language, node, binary, "decline"),
        "create-cancel": lambda: create_case(root, language, node, binary, "cancel"),
        "create-interrupt": lambda: create_case(root, language, node, binary, "interrupt"),
        "create-approval-interrupt": lambda: create_case(root, language, node, binary, "approval-interrupt"),
        "recovery-selection": lambda: recovery_case(root, language, node, binary),
    }
    results: dict[str, Any] = {}
    for name, run_case in cases.items():
        last_transcript = ""
        try:
            results[name] = run_case()
        except Exception as exc:
            error = str(exc).replace(str(root), "<repository>")
            trace = traceback.format_exc(limit=4).replace(str(root), "<repository>")
            return {
                "ok": False,
                "language": language,
                "failed": name,
                "error": error,
                "traceback": trace,
                "transcript": last_transcript,
                "completed": results,
            }
    return {"ok": True, "language": language, "cases": results}


def main() -> int:
    # The wrapped command may contain arbitrary Node flags (including `--help`), so let the
    # child path consume its argv before argparse treats those flags as driver options.
    if len(sys.argv) >= 5 and sys.argv[1] == "--child":
        return child_main(sys.argv[2], sys.argv[3], sys.argv[4:])
    parser = argparse.ArgumentParser()
    parser.add_argument("--root")
    parser.add_argument("--language", choices=("en", "ko"))
    parser.add_argument("--node", default="node")
    parser.add_argument("--binary")
    args = parser.parse_args()
    if args.root is None or args.language is None or args.binary is None:
        parser.error("--root, --language and --binary are required")
    result = run_all(Path(args.root).resolve(), args.language, args.node, Path(args.binary).resolve())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
