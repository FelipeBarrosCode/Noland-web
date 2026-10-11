# Noland instance gateway

`install.sh` installs the pinned Moonlight Web Stream release on a rented Linux
instance and starts it as `noland-web-gateway.service`.

The installer verifies the upstream release checksum, enables HTTPS, reserves UDP
ports `40000-40100` for WebRTC, and keeps gateway state under `/var/lib/noland-web`.

The first browser connection creates the local gateway administrator. Add Sunshine
as `localhost` and pair it once. A later Noland-specific gateway patch will replace
this first-login flow with instance-scoped, short-lived session tokens.

Production deployments should provide a trusted certificate or Cloudflare Tunnel
hostname instead of relying on the generated 30-day bootstrap certificate.
