#!/bin/bash
set -euo pipefail

# Cross-platform POSIX installer for macOS and Linux.
#
# Website/release usage can pin an immutable tarball:
#   OPENCODEX_PACKAGE_SPEC=https://github.com/Zhao73/opencodex-universal/releases/download/vX/opencodex-universal-X.tgz \
#   OPENCODEX_PACKAGE_SHA256=<sha256> \
#   bash install.sh
#
# Registry installs default to the preview channel and rely on npm's registry SRI.

PACKAGE_NAME="opencodex-universal"
PACKAGE_SPEC="${OPENCODEX_PACKAGE_SPEC:-${PACKAGE_NAME}@preview}"
EXPECTED_SHA256="${OPENCODEX_PACKAGE_SHA256:-}"
INSTALL_PREFIX="${OPENCODEX_INSTALL_PREFIX:-${HOME}/.local/share/opencodex-universal/npm}"
SHIM_DIR="${OPENCODEX_BIN_DIR:-${HOME}/.local/bin}"
STATE_DIR="${OPENCODEX_HOME:-${HOME}/.opencodex}"
ACTION="${1:-install}"

fail() {
  printf "opencodex-universal installer: %s\n" "$*" >&2
  exit 1
}

case "$ACTION" in
  install|--install|check|--check|uninstall|--uninstall|purge|--purge|help|--help|-h) ;;
  *) fail "unknown action '$ACTION' (use install, check, uninstall, or purge)" ;;
esac

if [ "$ACTION" = "help" ] || [ "$ACTION" = "--help" ] || [ "$ACTION" = "-h" ]; then
  cat <<'EOF'
Usage: bash install.sh [install|check|uninstall|purge]

Environment:
  OPENCODEX_PACKAGE_SPEC       npm spec, local .tgz, or HTTPS release .tgz
  OPENCODEX_PACKAGE_SHA256     required for local/HTTPS .tgz installs
  OPENCODEX_INSTALL_PREFIX     dedicated npm prefix
  OPENCODEX_BIN_DIR            user shim directory

uninstall removes the managed runtime but preserves ~/.opencodex.
purge also invokes the application's state cleanup before removing the runtime.
EOF
  exit 0
fi

case "$INSTALL_PREFIX" in
  /*) ;;
  *) INSTALL_PREFIX="$(pwd)/${INSTALL_PREFIX}" ;;
esac
case "$SHIM_DIR" in
  /*) ;;
  *) SHIM_DIR="$(pwd)/${SHIM_DIR}" ;;
esac

case "$INSTALL_PREFIX" in
  ""|"/"|"$HOME") fail "refusing unsafe install prefix '$INSTALL_PREFIX'" ;;
esac
if [ -L "$INSTALL_PREFIX" ]; then
  fail "install prefix must be a real directory, not a symlink: $INSTALL_PREFIX"
fi

launcher_path() {
  printf "%s/bin/ocxu" "$1"
}

remove_managed_shim() {
  shim="$1"
  if [ -L "$shim" ]; then
    target="$(readlink "$shim" 2>/dev/null || true)"
    case "$target" in
      "$INSTALL_PREFIX"/*) rm -f "$shim" ;;
    esac
  fi
}

install_shims() {
  mkdir -p "$SHIM_DIR"
  ln -sfn "$(launcher_path "$INSTALL_PREFIX")" "$SHIM_DIR/ocxu"
  ln -sfn "$INSTALL_PREFIX/bin/opencodex-universal" "$SHIM_DIR/opencodex-universal"

  # Keep the upstream `ocx` command untouched when it already exists. New users
  # still get the familiar alias; side-by-side users use collision-free `ocxu`.
  existing_ocx="$(command -v ocx 2>/dev/null || true)"
  if [ -z "$existing_ocx" ] || [ "$existing_ocx" = "$SHIM_DIR/ocx" ]; then
    ln -sfn "$INSTALL_PREFIX/bin/ocx" "$SHIM_DIR/ocx"
  else
    printf "Existing ocx left untouched: %s\n" "$existing_ocx"
  fi
}

run_check() {
  launcher="$(launcher_path "$INSTALL_PREFIX")"
  [ -x "$launcher" ] || fail "runtime is not installed at $INSTALL_PREFIX"
  "$launcher" help >/dev/null || fail "installed launcher failed: $launcher help"
  version="$("$launcher" --version 2>/dev/null || true)"
  printf "OK: %s (%s, Node %s, %s/%s)\n" \
    "${version:-opencodex-universal}" "$launcher" "$(node --version)" "$(uname -s)" "$(uname -m)"
}

remove_runtime() {
  purge="$1"
  launcher="$(launcher_path "$INSTALL_PREFIX")"
  if [ -x "$launcher" ]; then
    if [ "$purge" = "1" ]; then
      "$launcher" uninstall
    else
      "$launcher" stop >/dev/null 2>&1 || true
    fi
  fi

  remove_managed_shim "$SHIM_DIR/ocxu"
  remove_managed_shim "$SHIM_DIR/opencodex-universal"
  remove_managed_shim "$SHIM_DIR/ocx"
  if [ -e "$INSTALL_PREFIX" ]; then
    rm -rf "$INSTALL_PREFIX"
  fi
  if [ "$purge" = "1" ]; then
    printf "Removed runtime and local opencodex state.\n"
  else
    printf "Removed runtime; ~/.opencodex was preserved.\n"
  fi
}

if [ "$ACTION" = "uninstall" ] || [ "$ACTION" = "--uninstall" ]; then
  remove_runtime 0
  exit 0
fi
if [ "$ACTION" = "purge" ] || [ "$ACTION" = "--purge" ]; then
  remove_runtime 1
  exit 0
fi

command -v node >/dev/null 2>&1 \
  || fail "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun."
command -v npm >/dev/null 2>&1 \
  || fail "npm is required (it is normally bundled with Node.js)."

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 18 ] \
  || fail "Node.js 18+ is required. Current version: $(node --version)"

NODE_ARCH="$(node -p "process.arch")"
case "$NODE_ARCH" in
  x64|arm64) ;;
  *) fail "unsupported Node architecture '$NODE_ARCH'; use an x64 or arm64 Node build" ;;
esac

OS_NAME="$(uname -s)"
OS_ARCH="$(uname -m)"
case "$OS_NAME" in
  Darwin)
    case "$OS_ARCH" in
      arm64|x86_64) ;;
      *) fail "unsupported macOS architecture '$OS_ARCH'" ;;
    esac
    ;;
  Linux)
    case "$OS_ARCH" in
      aarch64|arm64|x86_64) ;;
      *) fail "unsupported Linux architecture '$OS_ARCH'" ;;
    esac
    ;;
  *) fail "unsupported operating system '$OS_NAME'; Windows users must run install.ps1" ;;
esac

if [ "$ACTION" = "check" ] || [ "$ACTION" = "--check" ]; then
  run_check
  exit 0
fi

printf "Installing %s for %s/%s with Node %s...\n" \
  "$PACKAGE_SPEC" "$OS_NAME" "$OS_ARCH" "$(node --version)"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ocxu-install.XXXXXX")"
PREFIX_PARENT="$(dirname "$INSTALL_PREFIX")"
STAGING_PREFIX="${INSTALL_PREFIX}.next.$$"
ROLLBACK_PREFIX="${INSTALL_PREFIX}.rollback.$$"
SWAPPED=0
SERVICE_WAS_INSTALLED=0
SERVICE_BACKEND=""
PROXY_WAS_RUNNING=0

cleanup() {
  rm -rf "$TMP_ROOT"
  if [ -e "$STAGING_PREFIX" ]; then
    rm -rf "$STAGING_PREFIX"
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$PREFIX_PARENT"
if [ -e "$STAGING_PREFIX" ] || [ -e "$ROLLBACK_PREFIX" ]; then
  fail "stale installer transaction exists; remove '$STAGING_PREFIX' / '$ROLLBACK_PREFIX' after checking no installer is running"
fi

INSTALL_SOURCE="$PACKAGE_SPEC"
case "$PACKAGE_SPEC" in
  https://*)
    [ -n "$EXPECTED_SHA256" ] \
      || fail "OPENCODEX_PACKAGE_SHA256 is required for an HTTPS release artifact"
    command -v curl >/dev/null 2>&1 || fail "curl is required to download a release artifact"
    INSTALL_SOURCE="$TMP_ROOT/package.tgz"
    curl --fail --location --proto '=https' --tlsv1.2 "$PACKAGE_SPEC" --output "$INSTALL_SOURCE"
    ;;
  http://*) fail "plain HTTP package URLs are not allowed" ;;
  */*|*.tgz)
    if [ -f "$PACKAGE_SPEC" ]; then
      [ -n "$EXPECTED_SHA256" ] \
        || fail "OPENCODEX_PACKAGE_SHA256 is required for a local release artifact"
      INSTALL_SOURCE="$PACKAGE_SPEC"
    elif [ "${PACKAGE_SPEC#./}" != "$PACKAGE_SPEC" ] || [ "${PACKAGE_SPEC#/}" != "$PACKAGE_SPEC" ]; then
      fail "local package artifact not found: $PACKAGE_SPEC"
    elif [ -n "$EXPECTED_SHA256" ]; then
      fail "SHA-256 pinning is supported only for local or HTTPS .tgz artifacts"
    fi
    ;;
  *)
    [ -z "$EXPECTED_SHA256" ] \
      || fail "SHA-256 pinning is supported only for local or HTTPS .tgz artifacts"
    ;;
esac

if [ -n "$EXPECTED_SHA256" ]; then
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(shasum -a 256 "$INSTALL_SOURCE" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(sha256sum "$INSTALL_SOURCE" | awk '{print $1}')"
  else
    fail "no SHA-256 tool found (expected shasum or sha256sum)"
  fi
  EXPECTED_NORMALIZED="$(printf "%s" "$EXPECTED_SHA256" | tr '[:upper:]' '[:lower:]')"
  ACTUAL_NORMALIZED="$(printf "%s" "$ACTUAL_SHA256" | tr '[:upper:]' '[:lower:]')"
  [ "$EXPECTED_NORMALIZED" = "$ACTUAL_NORMALIZED" ] \
    || fail "SHA-256 mismatch (expected $EXPECTED_NORMALIZED, got $ACTUAL_NORMALIZED)"
  printf "SHA-256 verified: %s\n" "$ACTUAL_NORMALIZED"
fi

if [ -f "$STATE_DIR/service-state.json" ]; then
  SERVICE_WAS_INSTALLED=1
  SERVICE_BACKEND="$(node -e '
    const fs = require("fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (state.backend === "native") process.stdout.write("native");
    } catch {}
  ' "$STATE_DIR/service-state.json")"
fi

OLD_LAUNCHER="$(launcher_path "$INSTALL_PREFIX")"
if [ -x "$OLD_LAUNCHER" ]; then
  OLD_STATUS="$("$OLD_LAUNCHER" status --json 2>/dev/null || true)"
  PROXY_WAS_RUNNING="$(printf "%s" "$OLD_STATUS" | node -e '
    let raw = "";
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const status = JSON.parse(raw);
        process.stdout.write(status?.proxy?.running === true ? "1" : "0");
      } catch {
        process.stdout.write("0");
      }
    });
  ')"
fi

if ! npm install -g --prefix "$STAGING_PREFIX" --no-audit --fund=false "$INSTALL_SOURCE"; then
  fail "npm installation into staging failed; active runtime was not changed"
fi
STAGED_LAUNCHER="$(launcher_path "$STAGING_PREFIX")"
[ -x "$STAGED_LAUNCHER" ] || fail "staged package did not provide the ocxu launcher"
"$STAGED_LAUNCHER" help >/dev/null || fail "staged launcher self-check failed"

if [ -x "$OLD_LAUNCHER" ]; then
  "$OLD_LAUNCHER" stop >/dev/null
fi

if [ -e "$INSTALL_PREFIX" ]; then
  mv "$INSTALL_PREFIX" "$ROLLBACK_PREFIX"
fi
if ! mv "$STAGING_PREFIX" "$INSTALL_PREFIX"; then
  if [ -e "$ROLLBACK_PREFIX" ]; then mv "$ROLLBACK_PREFIX" "$INSTALL_PREFIX"; fi
  fail "could not activate staged runtime"
fi
SWAPPED=1

restore_previous() {
  if [ "$SWAPPED" = "1" ]; then
    if [ -x "$(launcher_path "$INSTALL_PREFIX")" ]; then
      "$(launcher_path "$INSTALL_PREFIX")" stop >/dev/null 2>&1 || true
    fi
    remove_managed_shim "$SHIM_DIR/ocxu"
    remove_managed_shim "$SHIM_DIR/opencodex-universal"
    remove_managed_shim "$SHIM_DIR/ocx"
    failed_prefix="${INSTALL_PREFIX}.failed.$$"
    if [ -e "$INSTALL_PREFIX" ]; then mv "$INSTALL_PREFIX" "$failed_prefix" || true; fi
    if [ -e "$ROLLBACK_PREFIX" ]; then mv "$ROLLBACK_PREFIX" "$INSTALL_PREFIX" || true; fi
    rm -rf "$failed_prefix"
    if [ -x "$(launcher_path "$INSTALL_PREFIX")" ]; then
      install_shims || true
      if [ "$SERVICE_WAS_INSTALLED" = "1" ]; then
        if [ "$SERVICE_BACKEND" = "native" ]; then
          "$(launcher_path "$INSTALL_PREFIX")" service install --native || true
        else
          "$(launcher_path "$INSTALL_PREFIX")" service install || true
        fi
      elif [ "$PROXY_WAS_RUNNING" = "1" ]; then
        "$(launcher_path "$INSTALL_PREFIX")" ensure || true
      fi
    fi
  fi
}

FINAL_LAUNCHER="$(launcher_path "$INSTALL_PREFIX")"
if ! "$FINAL_LAUNCHER" help >/dev/null; then
  restore_previous
  fail "activated launcher failed; previous runtime was restored"
fi
if ! install_shims; then
  restore_previous
  fail "could not install user command shims; previous runtime was restored"
fi

if [ "$SERVICE_WAS_INSTALLED" = "1" ]; then
  if [ "$SERVICE_BACKEND" = "native" ]; then
    SERVICE_ARGS="native"
    if ! "$FINAL_LAUNCHER" service install --native; then
      restore_previous
      fail "native service refresh failed; previous runtime was restored"
    fi
  else
    SERVICE_ARGS="default"
    if ! "$FINAL_LAUNCHER" service install; then
      restore_previous
      fail "background service refresh failed; previous runtime was restored"
    fi
  fi
  printf "Refreshed existing %s background service.\n" "$SERVICE_ARGS"
elif [ "$PROXY_WAS_RUNNING" = "1" ]; then
  if ! "$FINAL_LAUNCHER" ensure; then
    restore_previous
    fail "proxy restart failed; previous runtime was restored"
  fi
  printf "Restarted the proxy that was running before the upgrade.\n"
fi

run_check
if [ -e "$ROLLBACK_PREFIX" ]; then
  rm -rf "$ROLLBACK_PREFIX"
fi
SWAPPED=0

case ":$PATH:" in
  *":$SHIM_DIR:"*) COMMAND_HINT="ocxu" ;;
  *) COMMAND_HINT="$SHIM_DIR/ocxu"
     printf "Add %s to PATH to use the short 'ocxu' command in new shells.\n" "$SHIM_DIR" ;;
esac
printf "Installed successfully. Run: %s init\n" "$COMMAND_HINT"
