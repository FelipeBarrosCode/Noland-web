# Noland instance gateway

`install.sh` installs the pinned Moonlight Web Stream release on a rented Linux
instance and starts it as `noland-web-gateway.service`.

The installer verifies the upstream release checksum, enables HTTPS, reserves UDP
ports `40000-40100` for WebRTC, and keeps gateway state under `/var/lib/noland-web`.

Nginx terminates HTTPS and protects the gateway with the Noland username and password
entered during browser onboarding. The Moonlight Web process binds only to localhost,
accepts the authenticated identity header from Nginx, and creates the corresponding
local administrator without a separate Moonlight Web account-registration screen.

Sunshine is installed beside the gateway and receives the same local credentials.
Sunshine pairing remains an explicit step before the first stream.

Production deployments should provide a trusted certificate or Cloudflare Tunnel
hostname instead of relying on the generated 30-day bootstrap certificate.
