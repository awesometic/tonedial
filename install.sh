#!/bin/sh
# tonedial — the npm-less install path.
#
#   curl -fsSL https://raw.githubusercontent.com/awesometic/tonedial/main/install.sh | sh
#
# For someone who has Node and does not want a global npm install. It assumes Node rather than
# vendoring it: vendoring a runtime would reverse the decision that this ships as a script, and
# the target user has Node by definition.
#
# **It does not touch the shell rc, agent files, or tonedial state.** Appending a line with `>>`
# would satisfy none of the contracts this product holds itself to for a file it does not own — no
# diff, no approval, nothing for `eject` to reverse. This script only fetches and validates a
# candidate, then hands the package to its private install entry point.

set -eu

REGISTRY="${TONEDIAL_REGISTRY:-https://registry.npmjs.org}"
ROOT="${TONEDIAL_HOME:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/tonedial}}"
ROOT="${ROOT:-${HOME:-}/.tonedial}"
BIN="$ROOT/bin"
# Keep the bootstrap's two network reads bounded even before Node's bounded fetch path exists.
# These are constants rather than user-controlled flags: a wrapper cannot silently turn a
# bootstrap into an unbounded process.
CURL_CONNECT_TIMEOUT=15
CURL_MAX_TIME=60

json_output=0
die() {
  printf '%s\n' "$1" >&2
  if [ "$json_output" -eq 1 ]; then
    printf '%s\n' '{"ok":false,"packageRepair":{"status":"failed"},"stateRepair":{"status":"not-started"},"error":"bootstrap failed; see stderr"}'
  fi
  exit 1
}

# URL bytes arrive through a bounded private pipe; only the mode reaches Node's argv.
url_info() {
  node -e '
    const fs = require("node:fs");
    try {
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(0, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      if (count > 1024 * 1024) process.exit(1);
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
      if (/[\p{Cc}]/u.test(source)) process.exit(1);
      const url = new URL(source);
      if (process.argv[1] === "origin") {
        process.stdout.write(url.protocol === "http:" || url.protocol === "https:" ? url.origin : "remote source");
      } else {
        // curl config quotes recognize escaped backslashes and double quotes.
        const escaped = source.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
        process.stdout.write("url = \"" + escaped + "\"\n");
      }
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}

download() {
  # The config is already validated before curl starts; its pipe is separate from streamed sh.
  if printf '%s\n' "$1" | curl -q -fsSL --config - \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" --max-filesize "$4" \
    -o "$3" >/dev/null 2>/dev/null; then
    return
  else
    status=$?
  fi
  case "$status" in
    22) reason="HTTP failure" ;;
    28) reason="timeout" ;;
    60) reason="secure connection could not be verified" ;;
    63) reason="download exceeded its size limit" ;;
    *) reason="transport failure" ;;
  esac
  die "could not download from $2: $reason."
}

metadata_value() {
  node -e '
    const fs = require("node:fs");
    try {
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(0, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      if (count > 1024 * 1024) process.exit(1);
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
          raw.dist === null || typeof raw.dist !== "object" || Array.isArray(raw.dist) ||
          typeof raw.dist.tarball !== "string" || raw.dist.tarball === "" ||
          typeof raw.dist.integrity !== "string" || raw.dist.integrity === "" ||
          /[\p{Cc}]/u.test(raw.dist.tarball) || /[\p{Cc}]/u.test(raw.dist.integrity)) process.exit(1);
      process.stdout.write(raw.dist[process.argv[1]]);
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}

validate_arguments() {
  repair_seen=0
  scope_seen=0
  seen_options=" "
  while [ "$#" -gt 0 ]; do
    case "$seen_options" in *" $1 "*) die "Repeated installer argument: $1" ;; esac
    seen_options="$seen_options$1 "
    case "$1" in
      --repair) repair_seen=1 ;;
      --global | --here) scope_seen=$((scope_seen + 1)) ;;
      --auto | --dry-run | --json) ;;
      --project | --tools | --from-operation | --from-preset | --restore-preset | --rollback | --archive-current)
        option="$1"
        [ "$#" -ge 2 ] || die "$option requires a value."
        shift
        case "$1" in "" | --*) die "$option requires a value." ;; esac
        [ "$option" != --project ] || scope_seen=$((scope_seen + 1))
        if [ "$option" = --archive-current ]; then
          node -e 'const values = process.argv[1].split(","); if (new Set(values).size !== values.length || values.some(value => !["lib", "command", "legacy-bin"].includes(value))) process.exit(1)' "$1" \
            || die "--archive-current accepts only lib,command,legacy-bin."
        fi
        ;;
      *) die "Unknown installer argument: $1" ;;
    esac
    shift
  done
  [ "$scope_seen" -le 1 ] || die "Choose only one of --global, --here, or --project."
  [ "$repair_seen" -eq 1 ] || die "Recovery flags require --repair."
}

# **Everything below runs from a function called on the last line.** Piped to `sh`, a download
# that is cut short leaves the shell executing whatever arrived — and the worst place to be cut
# is between the two `mv`s, where the old install is gone and the new one is not in place. A
# body that is only ever entered from the final line cannot be half-run.
main() {
  for argument in "$@"; do [ "$argument" != --json ] || json_output=1; done
  # The caller's shell remains outside this boundary; downloader/formatter children need no override.
  unset TONEDIAL_REGISTRY
  # `$ROOT` reaches `rm -rf` below, and a wrapper that exports an empty or root-level value is the
  # way that goes wrong. The CLI guards the sibling variable for the same reason.
  case "$ROOT" in
    "" | "/" | "/.tonedial") die "TONEDIAL_HOME resolves to $ROOT, which is not a safe place to install." ;;
  esac
  [ -n "${HOME:-}" ] || [ -n "${TONEDIAL_HOME:-}" ] || die "\$HOME is not set. Set TONEDIAL_HOME to choose where tonedial lives."

  command -v node >/dev/null 2>&1 || die "tonedial needs Node 24 or newer, and node is not on your PATH."

  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 24 ] || die "tonedial needs Node 24 or newer; this is $(node -v)."

  if [ "$#" -gt 0 ]; then
    validate_arguments "$@"
  fi
  ROOT="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$ROOT")"
  BIN="$ROOT/bin"
  export TONEDIAL_HOME="$ROOT"

  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "this installer needs $tool."
  done

  staging="$(mktemp -d "${TMPDIR:-/tmp}/tonedial.XXXXXX")"
  trap 'if [ "${child_started:-0}" -eq 0 ] || [ -f "$staging/child-exited" ]; then rm -rf "$staging"; else printf "Fresh recovery staging retained at %s; its child did not confirm exit.\n" "$staging" >&2; fi' EXIT
  # Shell cleanup waits until the synchronous child has exited. An interrupted child retains
  # its durable operation evidence rather than losing the fresh recovery code underneath it.
  trap 'if [ -n "${child_pid:-}" ]; then kill -INT "$child_pid" 2>/dev/null || true; wait "$child_pid" || true; fi; exit 130' INT
  trap 'if [ -n "${child_pid:-}" ]; then kill -TERM "$child_pid" 2>/dev/null || true; wait "$child_pid" || true; fi; exit 143' TERM

  printf 'Fetching tonedial…\n' >&2
  # The registry's own integrity hash comes back with the tarball URL, and it is the only thing
  # standing between "the network said so" and running the result. `npm install` verifies it; a
  # curl installer that skipped it would hand whoever controls the response — or TONEDIAL_REGISTRY,
  # which any wrapper can set — arbitrary code execution as the invoking user.
  registry_origin="$(printf '%s' "$REGISTRY" | url_info origin)" || die "the registry URL is invalid."
  registry_config="$(printf '%s' "$REGISTRY/tonedial/latest" | url_info config)" || die "the registry URL is invalid."
  download "$registry_config" "$registry_origin" "$staging/release.json" $((1024 * 1024))
  release="$(node -e '
    const fs = require("node:fs");
    try {
      const file = process.argv[1];
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) process.exit(1);
      const bytes = fs.readFileSync(file);
      if (bytes.length > 1024 * 1024) process.exit(1);
      process.stdout.write(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { process.exit(1); }
  ' "$staging/release.json" 2>/dev/null)" || die "the registry metadata was too large or unreadable."
  tarball="$(printf '%s' "$release" | metadata_value tarball)" || die "the registry release metadata is invalid."
  integrity="$(printf '%s' "$release" | metadata_value integrity)" || die "the registry release metadata is invalid."
  tarball_origin="$(printf '%s' "$tarball" | url_info origin)" || die "the package URL is invalid."
  tarball_config="$(printf '%s' "$tarball" | url_info config)" || die "the package URL is invalid."
  download "$tarball_config" "$tarball_origin" "$staging/package.tgz" $((16 * 1024 * 1024))

  case "$integrity" in
    sha512-*) digest="${integrity#sha512-}" ;;
    *) die "the registry did not provide a sha512 integrity hash." ;;
  esac
  printf '%s' "$digest" | node -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    try {
      const file = process.argv[1];
      const expected = fs.readFileSync(0, "utf8");
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) process.exit(1);
      const actual = createHash("sha512").update(fs.readFileSync(file)).digest("base64");
      if (actual !== expected) process.exit(1);
    } catch { process.exit(1); }
  ' "$staging/package.tgz" 2>/dev/null || die "the download did not match the registry's integrity hash."

  # `--no-same-owner` and `--no-same-permissions`: a tarball unpacked as root could otherwise carry
  # setuid bits into a directory this script then moves into place.
  # Inspect the archive headers before tar is allowed to write. Only package-relative regular
  # files/directories are accepted; links, hard links, special files, PAX/unknown records, and
  # absolute/parent paths are refused while the destination is still empty.
  node -e '
    const { spawnSync } = require("node:child_process");
    const { gunzipSync } = require("node:zlib");
    const fs = require("node:fs");
    const archive = process.argv[1];
    let bytes;
    try { bytes = gunzipSync(fs.readFileSync(archive), { maxOutputLength: 16 * 1024 * 1024 }); }
    catch { process.exit(1); }
    if (bytes.length === 0 || bytes.length % 512 !== 0) process.exit(1);
    const field = (source, start, length) => {
      const value = source.subarray(start, start + length);
     const end = value.indexOf(0);
     const text = value.subarray(0, end === -1 ? value.length : end).toString("utf8");
     return text.includes("\ufffd") ? null : text;
   };
    const sizeOf = (source, start, length) => {
      const value = field(source, start, length);
     if (value === null || value.trim() === "") return value === null ? null : 0;
     if (!/^[0-7]+$/.test(value.trim())) return null;
     const size = Number.parseInt(value.trim(), 8);
     return Number.isSafeInteger(size) ? size : null;
   };
    const safePath = (value) => {
      const path = value.endsWith("/") ? value.slice(0, -1) : value;
      const parts = path.split("/");
     return (path === "package" || path.startsWith("package/")) &&
        !/[\u0000-\u001f\u007f]/.test(path) &&
       parts.every((part) => part !== "" && part !== "." && part !== "..");
    };
    let offset = 0;
    let entries = 0;
    let zeroBlocks = 0;
    while (offset < bytes.length) {
      const header = bytes.subarray(offset, offset + 512);
      if (header.length !== 512) process.exit(1);
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        offset += 512;
        continue;
      }
      if (zeroBlocks >= 2) process.exit(1);
      zeroBlocks = 0;
      const type = header[156];
      if (type !== 0 && type !== 48 && type !== 53) process.exit(1);
      const size = sizeOf(header, 124, 12);
      const name = field(header, 0, 100);
      const prefix = field(header, 345, 155);
      const path = name === null || prefix === null ? null : (prefix === "" ? name : prefix + "/" + name);
      if (size === null || path === null || !safePath(path) ||
          size > 16 * 1024 * 1024 || offset + 512 + size > bytes.length) process.exit(1);
      offset += 512 + Math.ceil(size / 512) * 512;
      entries += 1;
    }
    if (entries === 0 || zeroBlocks < 2) process.exit(1);
    const run = (args) => spawnSync("tar", args.concat(archive), {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const list = run(["-tzf"]);
    const detail = run(["-tvzf"]);
    if (list.status !== 0 || detail.status !== 0 || typeof list.stdout !== "string" || typeof detail.stdout !== "string") process.exit(1);
    const names = list.stdout.endsWith("\n") ? list.stdout.slice(0, -1).split("\n") : list.stdout.split("\n");
    const headers = detail.stdout.endsWith("\n") ? detail.stdout.slice(0, -1).split("\n") : detail.stdout.split("\n");
    if (names.length === 0 || names.length !== headers.length) process.exit(1);
    for (let i = 0; i < names.length; i += 1) {
      const type = headers[i][0];
      const path = names[i].endsWith("/") ? names[i].slice(0, -1) : names[i];
      const parts = path.split("/");
      if ((type !== "d" && type !== "-") ||
          (path !== "package" && !path.startsWith("package/")) ||
          path.includes("\0") || path.includes("\r") ||
          parts.some((part) => part === "" || part === "." || part === "..")) process.exit(1);
    }
  ' "$staging/package.tgz" || die "the package archive contains an unsafe member."

  mkdir -p "$staging/unpacked"
  tar -xzf "$staging/package.tgz" -C "$staging/unpacked" --no-same-owner --no-same-permissions \
    || die "could not unpack the tonedial package."
  [ -f "$staging/unpacked/package/dist/bin.js" ] || die "the package does not look like tonedial."
  [ -f "$staging/unpacked/package/dist/install.js" ] || die "the package has no install entry point."

  # The release entry owns package recovery and dispatches only its closed doctor argument
  # vector. Keep staging alive until that recovery returns, including operation-ID rollback.
  child_started=1
  node -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [entry, root, candidate, completion, ...recovery] = process.argv.slice(1);
    let terminal;
    let stdio = "inherit";
    if (recovery.includes("--repair") && !recovery.includes("--auto") && !recovery.includes("--dry-run") && !recovery.includes("--json")) {
      try { terminal = fs.openSync("/dev/tty", "r+"); stdio = [terminal, terminal, terminal]; }
      catch { /* The fresh entry returns a no-write approval diagnostic without a terminal. */ }
    }
    const child = spawn(process.execPath, [entry, "--root", root, "--candidate", candidate, ...recovery], {
      stdio, env: { ...process.env, TONEDIAL_HOME: root },
    });
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    child.once("error", () => { console.error("the fresh installer could not start"); process.exitCode = 1; });
    child.once("close", (code, signal) => {
      if (terminal !== undefined) fs.closeSync(terminal);
      // SIGKILL cannot forward cancellation to a recovery grandchild. Keep the stage when its
      // exit is unconfirmed; normal cancellation waits for the fresh dispatcher to close it.
      if (signal !== "SIGKILL") fs.writeFileSync(completion, "", { flag: "wx", mode: 0o600 });
      process.exit(code === null ? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1) : code);
    });
  ' "$staging/unpacked/package/dist/install.js" "$ROOT" "$staging/unpacked/package" "$staging/child-exited" "$@" &
  child_pid=$!
  wait "$child_pid" || exit $?
  child_pid=""

  case " $* " in *" --dry-run "*) return ;; esac
  [ -x "$BIN/tonedial" ] || die "tonedial was installed but the command was not created at $BIN/tonedial."
}

main "$@"
