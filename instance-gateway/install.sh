#!/usr/bin/env bash
set -Eeuo pipefail

VERSION=${NOLAND_MOONLIGHT_WEB_VERSION:-v2.10.0}
INSTALL_ROOT=/opt/noland-web-gateway
CONFIG_ROOT=/etc/noland-web
STATE_ROOT=/var/lib/noland-web

case "$(uname -m)" in
  x86_64)
    target=x86_64-unknown-linux-gnu
    expected_sha256=b17fa535676a1c118bc1eb009134644cab98190b36a0776fb1b4a505d569f5eb
    ;;
  aarch64|arm64)
    target=aarch64-unknown-linux-gnu
    expected_sha256=1a6bb6845756883671a5a783c0797367e84166c8210f8cfa51059f434f0e5a3a
    ;;
  *)
    echo "Unsupported gateway architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl openssl tar python3 pipewire pipewire-pulse wireplumber

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
archive="$work_dir/moonlight-web.tar.gz"
url="https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/${VERSION}/moonlight-web-${target}.tar.gz"
curl --fail --location --retry 3 --silent --show-error "$url" --output "$archive"
printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check --status

rm -rf "$INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT" "$CONFIG_ROOT/tls" "$STATE_ROOT/server"
tar -xzf "$archive" --strip-components=1 -C "$INSTALL_ROOT"
chmod 0755 "$INSTALL_ROOT/web-server" "$INSTALL_ROOT/streamer"

install_sunshine() {
  if command -v sunshine >/dev/null 2>&1; then
    return
  fi
  . /etc/os-release
  local arch asset_pattern release_json asset_url package_path
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
  esac
  case "${ID:-}:${VERSION_ID:-}:${VERSION_CODENAME:-}" in
    ubuntu:22.04:*|ubuntu:24.04:*|ubuntu:26.04:*)
      asset_pattern="sunshine-ubuntu-${VERSION_ID}-${arch}\\.deb"
      ;;
    debian:*:bookworm) asset_pattern="sunshine-debian-bookworm-${arch}\\.deb" ;;
    debian:*:trixie) asset_pattern="sunshine-debian-trixie-${arch}\\.deb" ;;
    *) echo "Unsupported Sunshine host: ${ID:-unknown} ${VERSION_ID:-unknown}" >&2; return 1 ;;
  esac
  release_json=$(curl -fsSL https://api.github.com/repos/LizardByte/Sunshine/releases/latest)
  asset_url=$(python3 -c '
import json,re,sys
pattern=re.compile(sys.argv[1])
for asset in json.load(sys.stdin).get("assets", []):
    if pattern.fullmatch(asset.get("name", "")):
        print(asset["browser_download_url"]); break
' "$asset_pattern" <<<"$release_json")
  test -n "$asset_url"
  package_path="$work_dir/sunshine.deb"
  curl -fsSL "$asset_url" -o "$package_path"
  apt-get install -y "$package_path"
}

install_sunshine

target_user=${NOLAND_TARGET_USER:-}
if [[ -z "$target_user" ]]; then
  target_user=$(getent passwd 1000 | cut -d: -f1 || true)
fi
if [[ -z "$target_user" || "$target_user" == root ]]; then
  target_user=user
  id "$target_user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$target_user"
fi
target_home=$(getent passwd "$target_user" | cut -d: -f6)
sunshine_user=$(printf '%s' "${NOLAND_SUNSHINE_USER_B64:-bm9sYW5k}" | base64 --decode)
sunshine_password=$(printf '%s' "${NOLAND_SUNSHINE_PASSWORD_B64:-}" | base64 --decode)
if [[ -z "$sunshine_password" ]]; then
  sunshine_password=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
fi
runuser -u "$target_user" -- env HOME="$target_home" sunshine --creds "$sunshine_user" "$sunshine_password"

cat > /etc/systemd/system/sunshine.service <<EOF
[Unit]
Description=Sunshine game stream host
After=network-online.target graphical.target
Wants=network-online.target

[Service]
Type=simple
User=${target_user}
Environment=HOME=${target_home}
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$target_user")
ExecStart=/usr/bin/sunshine
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if [[ ! -s "$CONFIG_ROOT/tls/key.pem" || ! -s "$CONFIG_ROOT/tls/cert.pem" ]]; then
  public_name=${NOLAND_GATEWAY_PUBLIC_NAME:-$(curl -fsS https://api.ipify.org || hostname -f)}
  openssl req -x509 -newkey rsa:3072 -nodes -days 30 \
    -keyout "$CONFIG_ROOT/tls/key.pem" \
    -out "$CONFIG_ROOT/tls/cert.pem" \
    -subj "/CN=${public_name}" \
    -addext "subjectAltName=DNS:${public_name},IP:${public_name}" 2>/dev/null
  chmod 0600 "$CONFIG_ROOT/tls/key.pem"
fi

cat > "$CONFIG_ROOT/config.json" <<EOF
{
  "data_storage": {
    "type": "json",
    "path": "${STATE_ROOT}/server/data.json",
    "session_expiration_check_interval": { "secs": 300, "nanos": 0 }
  },
  "webrtc": {
    "ice_servers": [
      {
        "is_default": true,
        "urls": ["stun:stun.cloudflare.com:3478"],
        "username": "",
        "credential": ""
      }
    ],
    "ice_server_script": null,
    "port_range": { "min": 40000, "max": 40100 },
    "nat_1to1": null,
    "network_types": ["udp4", "tcp4"],
    "include_loopback_candidates": false
  },
  "web_server": {
    "bind_address": "0.0.0.0:8080",
    "certificate": {
      "private_key_pem": "${CONFIG_ROOT}/tls/key.pem",
      "certificate_pem": "${CONFIG_ROOT}/tls/cert.pem"
    },
    "url_path_prefix": "",
    "session_cookie_secure": true,
    "session_cookie_expiration": { "secs": 86400, "nanos": 0 },
    "first_login_create_admin": true,
    "first_login_assign_global_hosts": true,
    "default_user_id": null,
    "default_role_id": null,
    "forwarded_header": null
  },
  "moonlight": {},
  "streamer_path": "${INSTALL_ROOT}/streamer",
  "log": { "level_filter": "info", "file_path": null, "dev_venator": false },
  "default_settings": null
}
EOF

cat > /etc/systemd/system/noland-web-gateway.service <<EOF
[Unit]
Description=Noland browser streaming gateway
After=network-online.target sunshine.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_ROOT}
ExecStart=${INSTALL_ROOT}/web-server --config-path ${CONFIG_ROOT}/config.json run
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STATE_ROOT}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sunshine.service
systemctl enable --now noland-web-gateway.service

cat > "$STATE_ROOT/install.json" <<EOF
{"version":"${VERSION}","target":"${target}","sunshineUser":"${sunshine_user}","installedAt":"$(date -u +%FT%TZ)"}
EOF

echo "Noland Web gateway ${VERSION} installed for ${target}."
