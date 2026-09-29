#!/bin/sh
# Builds git from source into /usr/local, reusing a previous build from $GIT_CACHE_DIR if present.
# Usage: install-git.sh <version|latest>
set -eu

version=$1
if [ "$version" = latest ]; then
  version=$(git ls-remote --tags --refs https://github.com/git/git.git 'v*' \
    | sed 's|.*refs/tags/v||' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)
fi

cache=${GIT_CACHE_DIR:-/tmp/git-cache}
build="$cache/$version"
if [ ! -x "$build/usr/local/bin/git" ]; then
  rm -rf "$cache"
  echo "Building git $version"
  curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$version.tar.gz" | tar xz -C /tmp
  # Rust is enabled by default since git 2.55 (mandatory from 3.0).
  if [ -f "/tmp/git-$version/Cargo.toml" ] && ! command -v cargo >/dev/null; then
    apt-get update -qq && apt-get install -y -qq --no-install-recommends cargo >/dev/null
  fi
  make -C "/tmp/git-$version" -j"$(nproc)" prefix=/usr/local DESTDIR="$build" SKIP_DASHED_BUILT_INS=YesPlease \
    NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 NO_CURL=1 NO_EXPAT=1 install >/dev/null
fi

cp -R "$build/usr/local/." /usr/local/
git --version
