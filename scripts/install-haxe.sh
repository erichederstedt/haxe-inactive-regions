#!/usr/bin/env bash
# Installs the official Haxe and Neko (needed by haxelib) releases into /opt
# and sets up a haxelib repository. Run by the dev container on creation; safe to re-run.
#
# Usage: scripts/install-haxe.sh [haxe-version]
#
# Note: Haxe 4.3.7+ release binaries need glibc 2.35 or newer (Debian 12+ / Ubuntu 22.04+).
set -euo pipefail

HAXE_VERSION="${1:-${HAXE_VERSION:-4.3.7}}"
NEKO_VERSION="${NEKO_VERSION:-2.4.1}"

# install <url> <dir>: download a release tarball and unpack it into <dir>.
install() {
	local tmp
	tmp="$(mktemp -d)"
	curl -fsSL "$1" -o "$tmp/archive.tgz"
	sudo rm -rf "$2"
	sudo mkdir -p "$2"
	sudo tar xzf "$tmp/archive.tgz" -C "$2" --strip-components=1
	rm -rf "$tmp"
}

if [ "$(neko -version 2>/dev/null)" != "$NEKO_VERSION" ]; then
	echo "Installing Neko $NEKO_VERSION..."
	install "https://github.com/HaxeFoundation/neko/releases/download/v${NEKO_VERSION//./-}/neko-$NEKO_VERSION-linux64.tar.gz" /opt/neko
	sudo ln -sf /opt/neko/neko /opt/neko/nekoc /opt/neko/nekoml /opt/neko/nekotools /usr/local/bin/
	sudo ln -sf /opt/neko/libneko.so* /usr/local/lib/
	sudo mkdir -p /usr/local/lib/neko
	sudo ln -sf /opt/neko/*.ndll /usr/local/lib/neko/
	sudo ldconfig
fi

if [ "$(haxe --version 2>/dev/null)" != "$HAXE_VERSION" ]; then
	echo "Installing Haxe $HAXE_VERSION..."
	install "https://github.com/HaxeFoundation/haxe/releases/download/$HAXE_VERSION/haxe-$HAXE_VERSION-linux64.tar.gz" /opt/haxe
	sudo ln -sf /opt/haxe/haxe /opt/haxe/haxelib /usr/local/bin/
	# Haxe looks for its standard library here when HAXE_STD_PATH isn't set.
	sudo mkdir -p /usr/local/share/haxe
	sudo ln -sfn /opt/haxe/std /usr/local/share/haxe/std
fi

mkdir -p "$HOME/haxelib"
haxelib setup "$HOME/haxelib" >/dev/null
echo "Haxe $(haxe --version) and Neko $(neko -version) ready; haxelib repository: $HOME/haxelib"
