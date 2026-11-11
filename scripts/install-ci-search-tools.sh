#!/usr/bin/env bash
# CI-only provisioning. Local tests MUST replace sudo with a non-executing stub.
set -euo pipefail

fail() {
  printf 'CI search prerequisites: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || fail 'only Ubuntu Linux hosted runners are supported'
[[ "$(lsb_release -is)" == Ubuntu ]] || fail 'an Ubuntu runner is required'
architecture="$(dpkg --print-architecture)"
[[ "$architecture" == amd64 ]] || fail 'only the current amd64 CI matrix is supported'
codename="$(lsb_release -cs)"
[[ "$codename" =~ ^[a-z][a-z0-9]*$ ]] || fail 'invalid Ubuntu codename'

for name in RUNNER_TEMP GITHUB_PATH; do
  value="${!name:-}"
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "invalid $name path"
done
[[ -d "$RUNNER_TEMP" && -w "$RUNNER_TEMP" ]] || fail 'RUNNER_TEMP is not a writable directory'
[[ -f "$GITHUB_PATH" && ! -L "$GITHUB_PATH" && -w "$GITHUB_PATH" ]] || fail 'GITHUB_PATH is not a writable regular file'

# Public signed metadata/archives only. Private runner/home ancestors can block
# _apt despite a traversable child: use canonical /tmp, never chmod those parents.
umask 022
work="$(mktemp -d /tmp/ink-ci-search.XXXXXX)"
chmod 755 "$work"
mkdir "$work/lists" "$work/cache" "$work/cache/archives"
sources="$work/sources.list"
keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
printf '%s\n' \
  "deb [arch=amd64 signed-by=$keyring] https://archive.ubuntu.com/ubuntu $codename main universe" \
  "deb [arch=amd64 signed-by=$keyring] https://archive.ubuntu.com/ubuntu $codename-updates main universe" \
  "deb [arch=amd64 signed-by=$keyring] https://security.ubuntu.com/ubuntu $codename-security main universe" > "$sources"

# Fail before APT if its actual sandbox user cannot traverse/read this root.
# Local sudo mocks MUST simulate this check, never execute the supplied command.
if sudo -n -u _apt /usr/bin/test -r "$sources"; then
  :
else
  status=$?
  printf 'CI search prerequisites: _apt cannot traverse/read the owned APT sources\n' >&2
  exit "$status"
fi

# Pass the SAME isolated configuration to update and install. Do not let image
# mirror lists, foreign-architecture indexes or stale third-party lists select
# the failed Azure mirror again. System dpkg status remains the real database.
apt_options=(
  -o "Dir::Etc::sourcelist=$sources"
  -o 'Dir::Etc::sourceparts=-'
  -o "Dir::State::lists=$work/lists"
  -o "Dir::Cache=$work/cache"
  -o "Dir::Cache::archives=$work/cache/archives"
  -o 'APT::Sandbox::User=_apt'
  -o 'Acquire::Retries=1'
  -o 'Acquire::http::Timeout=15'
  -o 'Acquire::https::Timeout=15'
  -o 'APT::Update::Error-Mode=any'
)
printf 'CI search prerequisites: Ubuntu %s/%s; isolated signed official HTTPS sources; sandbox=_apt access checked; retries=1, timeouts=15s\n' "$codename" "$architecture"
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install -y --no-install-recommends ripgrep fd-find

rg --version
fdfind --version
fd_binary="$(command -v fdfind)"
[[ "$fd_binary" == /* ]] || fail 'fdfind did not resolve to an absolute path'
tools="$(mktemp -d "$RUNNER_TEMP/ink-ci-tools.XXXXXX")"
ln -s "$fd_binary" "$tools/fd"
"$tools/fd" --version
# Publish PATH only once installation AND actual executable verification passed.
printf '%s\n' "$tools" >> "$GITHUB_PATH"
