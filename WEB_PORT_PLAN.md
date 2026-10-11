# Noland Web Port Production Plan

## Goal

Provide a browser-only Noland client that streams from a rented Linux instance while
preserving the existing desktop client for native performance and advanced workflows.

The browser must connect to a gateway running on the rented instance:

```text
Browser ⇄ HTTPS/WebRTC ⇄ Noland gateway ⇄ Moonlight/UDP ⇄ Sunshine
```

The gateway will be based on the open-source Moonlight Web project rather than a new
Moonlight protocol implementation.

## Architecture

### Browser application

- Reuse the existing React/TypeScript application where practical.
- Add a browser runtime that does not depend on Tauri APIs.
- Use WebRTC for media transport and signaling.
- Use WebCodecs for H.264/Opus where available.
- Use WebGPU for optional custom rendering and WebGL/video-element fallback paths.
- Support Gamepad API, Pointer Lock, Keyboard Lock, reconnect, and session cleanup.

### Instance gateway

- Install the gateway during Linux instance provisioning.
- Run it as a systemd service beside Sunshine.
- Connect to Sunshine over localhost using the Moonlight protocol.
- Convert Moonlight video/audio/input to browser-compatible WebRTC traffic.
- Require short-lived, instance-scoped session tokens.
- Expose health, readiness, version, and shutdown endpoints.
- Restart automatically and stop when the rented instance is stopped or deleted.

### Noland control services

- Reuse desktop Vast.ai instance lifecycle and reconciliation logic.
- Create browser sessions only for instances returned by the authoritative provider list.
- Generate Cloudflare TURN credentials per session where required.
- Return gateway endpoint, token, ICE servers, and expiration time.
- Never expose Sunshine credentials or long-lived provider secrets to the browser.

## Implementation phases

## Current implementation status

- [x] Browser-safe command transport replacing Tauri invocation for core flows.
- [x] IndexedDB state with the Vast API key limited to session storage.
- [x] Same-origin Cloudflare Worker proxy with an explicit Vast endpoint allowlist.
- [x] Vast onboarding validation, offer search, selection, wallet, instance listing,
  creation, deletion, and deleted-instance reconciliation.
- [x] Pinned Moonlight Web Stream gateway source and verified binary installer.
- [x] Rented-instance bootstrap for Sunshine, TLS, WebRTC ports, and systemd services.
- [x] Web-only CI and Cloudflare Worker/static asset deployment configuration.
- [x] Origin-restricted loopback helper API with expiring browser sessions.
- [x] Generic Tauri command bridge preserving the complete Rust/SSH implementation.
- [x] Server-sent native provisioning, terminal, upload, and storage events.
- [x] Existing desktop state/keychain migration, autostart, and tray lifecycle.
- [x] Native helper file picker and existing SFTP upload pathway.
- [x] SSH installation/repair of the rented-instance WebRTC gateway.
- [x] Cloudflare TURN credentials injected into the gateway at stream handoff.
- [x] macOS ARM64, Windows x64, and Linux x64 helper release workflow.
- [ ] Replace Moonlight Web's initial local administrator flow with Noland-scoped tokens.
- [ ] Automate Sunshine pairing from the Noland browser session.
- [ ] Add trusted per-instance TLS hostnames instead of bootstrap self-signed certificates.
- [ ] Port terminal, uploads, shared storage, microphone, and display controls.
- [ ] Complete browser matrix, NAT/TURN, reconnect, and destructive lifecycle tests.

The checked items form the first deployable browser control and gateway slice. The
unchecked security and feature work remains required before declaring feature parity
with the native clients.

### Phase 1: Gateway proof of concept

1. Build Moonlight Web Stream for the supported Linux target.
2. Install it manually on one provisioned instance.
3. Connect it to Sunshine on localhost.
4. Verify browser video, audio, keyboard, mouse, and gamepad input.
5. Verify direct WebRTC and Cloudflare TURN fallback.
6. Record codec, latency, bandwidth, and reconnect behavior.

**Exit criteria:** a browser can start and stop one stream reliably without the desktop
client running.

### Phase 2: Provisioning integration

1. Add a versioned gateway artifact to the Linux provisioning pipeline.
2. Add systemd service and configuration templates.
3. Add gateway health and readiness checks.
4. Add gateway install retry, upgrade, rollback, and cleanup behavior.
5. Ensure deleted provider instances remove local state and active browser sessions.

**Exit criteria:** every newly provisioned supported Linux instance receives a healthy,
versioned gateway automatically.

### Phase 3: Browser session security

1. Add short-lived session tokens bound to user, instance, and browser session.
2. Add token revocation on stop, delete, timeout, and credential change.
3. Add origin validation, rate limiting, and replay protection.
4. Keep provider, SSH, and Sunshine secrets in secure native/server-side storage.
5. Add audit logging without recording secrets or media data.

**Exit criteria:** a token cannot access another instance or be reused after expiration.

### Phase 4: Web client integration

1. Add a browser-safe backend abstraction alongside the Tauri backend.
2. Reuse dashboard, instance cards, settings, and provisioning state where possible.
3. Add WebRTC stream lifecycle state and controls.
4. Add browser capability detection and clear unsupported-feature messages.
5. Use IndexedDB for non-sensitive browser preferences and cached instance metadata.
6. Use secure session cookies only for opaque session identifiers when needed.

**Exit criteria:** the browser client can provision, connect, reconnect, stop, and clean
up an instance without requiring the desktop binary.

### Phase 5: Production hardening

- Test Chrome, Edge, Firefox, Safari, iOS Safari, and Android browsers.
- Test restrictive NAT, corporate networks, IPv4/IPv6, and TURN-only sessions.
- Test instance deletion during provisioning, streaming, and reconnect.
- Add gateway and browser telemetry with privacy-safe metrics.
- Add signed gateway releases and reproducible Linux packaging.
- Add automated end-to-end tests using a Sunshine test host.
- Document bandwidth, codec, browser, controller, and microphone limitations.

## State migration

Do not move the complete desktop `state.json` into cookies.

### Safe browser state

- Selected instance ID
- UI preferences
- Language
- Display and stream preferences
- Last selected offer filters

Store these in IndexedDB or local storage after schema validation.

### Sensitive state

- Vast API key
- SSH keys and passwords
- Sunshine credentials
- Cloudflare API credentials
- Gateway session tokens

Keep these in the existing OS keychain for desktop, or secure backend/gateway storage
for the browser flow. The browser receives only short-lived scoped tokens.

## Release and operations

- Publish gateway artifacts separately from desktop installers.
- Pin the gateway version in provisioning scripts.
- Support gateway health checks before exposing a stream button.
- Roll back gateway versions when WebRTC or Sunshine compatibility fails.
- Keep native desktop and mobile streaming paths unchanged until browser streaming is
  proven stable.

## Initial deliverables

1. `noland-web-gateway` Linux artifact.
2. Provisioning installer and systemd unit.
3. Session/token API.
4. Browser WebRTC stream component.
5. Cloudflare TURN credential integration.
6. Browser instance reconciliation and cleanup.
7. End-to-end streaming test environment.

## Definition of production readiness

- No long-lived secrets are exposed to browser JavaScript.
- Deleted instances disappear from the browser and terminate active sessions.
- Gateway sessions are scoped, expiring, revocable, and audited.
- WebRTC works directly and through TURN.
- Browser reconnect does not create duplicate Sunshine sessions.
- Gateway upgrades and failures are recoverable.
- Desktop and iOS clients continue passing their existing release tests.
