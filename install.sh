#!/usr/bin/env bash
set -euo pipefail

REPO="evantahler/membot"
INSTALL_DIR="${MEMBOT_INSTALL_DIR:-/usr/local/bin}"

OS="$(uname -s)"
case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)
    echo "error: unsupported OS: $OS" >&2
    exit 1
    ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)
    echo "error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ARTIFACT="membot-${os}-${arch}"

echo "Fetching latest release..."
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

if [ -z "$TAG" ]; then
  echo "error: could not determine latest release" >&2
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"

echo "Downloading membot ${TAG} (${os}/${arch})..."
curl -fsSL "$URL" -o /tmp/membot

chmod +x /tmp/membot

if [ -w "$INSTALL_DIR" ]; then
  mv /tmp/membot "${INSTALL_DIR}/membot"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv /tmp/membot "${INSTALL_DIR}/membot"
fi

echo "membot ${TAG} installed to ${INSTALL_DIR}/membot"
