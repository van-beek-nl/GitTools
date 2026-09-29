#!/bin/sh
# Builds git from source into /usr/local. Usage: install-git.sh <version|latest>
set -eu

version=$1
if [ "$version" = latest ]; then
  version=$(git ls-remote --tags --refs https://github.com/git/git.git 'v*' \
    | sed 's|.*refs/tags/v||' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)
fi

curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$version.tar.gz" | tar xz -C /tmp
make -C "/tmp/git-$version" -j"$(nproc)" prefix=/usr/local \
  NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 NO_CURL=1 NO_EXPAT=1 install >/dev/null
git --version
