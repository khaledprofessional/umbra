# Umbra — architecture and upstream-sync blueprint

Umbra is a fork layer for **umbrelOS 2.0.1** (latest stable, published 2026‑11‑01). It adds a plugin engine, a native MCP control plane for AI agents, member app governance, and hardened single-hostname Cloudflare exposure — without forking the UI framework or rewriting umbreld.

This document is the engineering contract: what is isolated, where state lives, how an official OTA is survived, and what each security boundary does and does not guarantee.

---

## 1. Baseline and research

| Item | Finding | Consequence for the fork |
| --- | --- | --- |
| Latest stable | `2.0.1` (`a72dac2`, 2026‑11‑01). `master` is `2.1.0-beta.2`. | Fork branch starts at tag `2.0.1`; beta features (Photos MCP, new update signer) are deliberately out of scope. |
| Update mechanism | Rugix A/B with a **signed release manifest**; legacy Mender devices migrate to Rugix. `performUpdate()` downloads a signed update script and reboots. | Custom code must live in the **data partition**; root files are replaced by every OTA. A data-resident pre-start hook must re-apply hooks. |
| Reverse proxy | `lan-ingress` owns ports 80/443 and proxies to umbreld on loopback; app ports are redirected with nftables. | Cloudflare Tunnel targets `http://127.0.0.1:80`; app containers are never published. |
| MCP | Already present: bearer tokens, scoped file/app/machine permissions, memory-only client names. | Extend rather than duplicate: add terminal/avatar/plugin/audit tools to the same endpoint and token model. |
| Multi-user | Owner/member accounts, per-app member shares, owner-only install. | Add a per-member install policy and a request queue; reuse `apps.install` and `addMemberShare`. |
| Widgets | App widgets exist; a community PR removes the three-widget limit. | Plugin widgets use a declarative data contract and the existing dashboard surface. |
| User overrides | `docker-compose.umbrel-user-settings.yml` is generated and **overwritten**, so it cannot hold custom overrides. | Store overrides outside the app directory and append them in `app-script`. |

Community signals reviewed (open/recent PRs and issues):

- [#2161 — load `docker-compose.override.yml` in compose](https://github.com/getumbrel/umbrel/pull/2161): confirms the compose path is the right, small integration point.
- [#2143 — remove the three-widget limit](https://github.com/getumbrel/umbrel/pull/2143): dashboard widgets are an accepted extension surface.
- [#2129 — Caddy HTTPS](https://github.com/getumbrel/umbrel/pull/2129) and [#546 — HTTPS support](https://github.com/getumbrel/umbrel/issues/546): strong demand for first-class TLS/remote access; addressed here at the Cloudflare edge instead of a second local proxy.
- [#2196 — clean up old Docker images](https://github.com/getumbrel/umbrel/pull/2196): confirms app-update lifecycle is a pain point; Umbra snapshots and override persistence build around it.
- [#2136 — expose the Umbrel user name to app environments](https://github.com/getumbrel/umbrel/pull/2136): multi-user context is an active gap.
- [MCP authentication](https://github.com/getumbrel/umbrel/issues/2298) and [MCP memory/subscription growth](https://github.com/getumbrel/umbrel/issues/2313): motivated bounded audit retention, bounded clients, and explicit per-agent policies.
- [#2321 — machine autostart](https://github.com/getumbrel/umbrel/pull/2321) and [#2178 — Wi‑Fi hotspot](https://github.com/getumbrel/umbrel/pull/2178): power-user controls trend toward explicit, per-feature settings.

---

## 2. Non-destructive upstream synchronization

### 2.1 Repository layout

```
packages/umbreld/source/umbra/       # all custom backend code (new directory)
packages/ui/src/routes/settings/umbra.tsx
packages/ui/src/lib/umbra-api.ts     # member install/request bridge
scripts/umbra/                       # bootstrap + upstream sync
docs/umbra/                          # this blueprint + operations
umbra-fork.json                      # base tag + integration contract
```

Custom modules never live inside an upstream module directory. The only upstream edits are eleven blocks, each wrapped in a named marker:

```ts
// <umbra:server-edge>
this.app.use(this.umbreld.umbra.edgeMiddleware())
// </umbra:server-edge>
```

The editor is `packages/umbreld/source/umbra/tools/integrate.mjs`. It anchors on code, not line numbers, is idempotent, and can be run in `--check` mode in CI.

### 2.2 Merge strategy

1. `git fetch upstream --tags`.
2. `git rebase --onto <new-stable-tag> <recorded-base> HEAD`.
3. Custom commits (docs, new directories, small bridge edits) replay. Conflicts can only occur in the marked blocks.
4. `node tools/integrate.mjs --check`; if an upstream refactor moved an anchor, run it without `--check` to re-apply.
5. Run unit tests and the VM smoke test; bump `umbra-fork.json.base`.
6. Build a **fork-signed** OTA from the merged tree.

`scripts/umbra/sync-upstream.mjs` automates steps 1–4, creates a `backup/umbra-*` branch first, and never force-pushes.

### 2.3 Surviving an official (stock) OTA

A stock signed update replaces `/opt/umbreld`, including our bridge lines. The data partition is preserved. Therefore the fork installs a **data-resident pre-start hook**:

```
/home/umbrel/umbrel/custom-hooks/pre-start
  └─ node /home/umbrel/umbrel/umbra/runtime/tools/integrate.mjs \
         --repo /opt/umbreld --data /home/umbrel/umbrel
```

On every boot, before `umbrel.service`, the hook:

1. verifies the persistent runtime copy under `umbra/runtime`;
2. re-applies the eleven bridge blocks to the newly installed upstream source;
3. copies the runtime back to `/opt/umbreld/source/umbra` if it was removed.

`scripts/umbra/bootstrap-device.sh` installs the runtime and hook. This is what makes an official OTA non-destructive for backend features. The **Settings UI bridge** is compiled into the UI bundle; after a stock OTA the console remains reachable at `/umbra` and the API/edge features keep working, while the Settings rows return after the fork image (or a UI rebuild). This limit is inherent to shipping compiled frontend assets in a signed OS image.

### 2.4 State layout (persistent, outside the OS image)

```
<umbreld data>/umbra/
  config.json                 # 0600, atomic writes, validated
  secrets/device.key          # 32-byte AES key, 0600
  secrets/audit.key           # HMAC chain key, 0600
  secrets/cloudflare-*.secret.json
  audit/audit-YYYY-MM-DD.jsonl
  agents/agents.json
  agents/avatars/<token>.<ext>
  plugins/installed/<id>/<version>/
  plugins/data/<id>/storage.json
  app-overrides/<appId>/docker-compose.override.yml
  app-overrides/<appId>/docker-compose.umbra-custom.yml
  snapshots/<id>.usnap.json
  cloudflare/config.yml
  runtime/                    # post-OTA recovery copy
```

---

## 3. Plugin and modding framework

### 3.1 Lifecycle

`install → validate → stage → enable → activate → (event loop) → disable → deactivate → uninstall`.

- **Install** accepts a strict manifest plus bounded files (inline base64/UTF-8, a local directory via the owner API, or an MCP tool). Every path is resolved inside a staging directory; traversal, symlinks, duplicate paths, oversized files, and undeclared entry files are rejected.
- **Enable/disable** start/stop a child process without touching other plugins or umbreld.
- **Uninstall** removes code and keeps data by default (`remove_data` opts in to deletion).
- A crash restarts with linear backoff; after three crashes the supervisor disables the plugin and records the error.

### 3.2 Sandbox

Each backend runs as a child process with:

- Node's permission model: `--permission --allow-fs-read=<plugin dir> --allow-fs-read=<runtime only>`, 128 MB heap;
- on Linux, `unshare --net`, so the process has no network namespace (Node's permission model does not cover sockets);
- no host credentials, no Docker socket, no umbreld environment;
- every privileged operation is an IPC RPC that the host re-checks against the manifest. A plugin cannot grant itself permissions at runtime;
- declared event subscriptions only; the host drops undeclared events;
- per-call timeouts (default 5 s, manifest-tunable to 30 s).

The IPC protocol is newline-free JSON over the inherited channel: host→plugin `invoke`, plugin→host `call`, both bounded and timed out.

### 3.3 UI surface

- **Widgets** are declarative: `{id, title, size, refreshSeconds}` plus plugin-provided data via `ctx.widgets.setData(id, data)`. The host caps data at 16 KB and serves it through `/umbra/api/plugins/widgets`. No plugin HTML executes in the dashboard origin.
- **Routes** are sandboxed iframe pages served from the plugin's own directory with `sandbox allow-scripts` and a no-network CSP.
- **Settings** are typed fields (`string|number|boolean|select`) validated on every write.
- Frontend mount points are stable ids (`plugin:<id>:widget:<widget>`, `plugin:<id>:route:<route>`) so a future React slot can render them without changing the manifest.

### 3.4 AI-generated plugins

`plugin_scaffold` (MCP and REST) returns a deterministic manifest + starter files. The schema is closed: unknown keys fail, ids must be reverse-DNS, versions semver, permissions must come from the fixed list. See [PLUGIN_API.md](./PLUGIN_API.md) for the full schema and examples.

---

## 4. Native MCP control plane

The existing `/mcp` endpoint remains the single native server. Umbra adds tools to it when the credential's policy allows.

### 4.1 Terminal tool

```json
{
  "name": "run_terminal_command",
  "arguments": {
    "command": "docker ps --format '{{.Names}}'",
    "cwd": "/home/umbrel/umbrel/Home",
    "timeout_ms": 30000,
    "justification": "Show which containers are running"
  }
}
```

Output: `{exit_code, signal, stdout, stderr, timed_out, truncated, duration_ms, policy}`.

Permission state machine per token:

| Mode | Behaviour |
| --- | --- |
| `deny` | Tool is not registered; execution is refused and audited. |
| `ask` | Every command creates an approval; allowlist patterns can pre-approve narrow commands. |
| `always` | Pre-approved autonomous execution (owner opt-in). |
| `inherit` | Follows the global default (`ask`). |

`ask` blocks the MCP call and emits an SSE `approval` event to `/umbra/api/approvals/stream`. The prompt contains the token label, self-declared client name, agent type, exact command, working directory, and expiry. Approve/Deny is owner-only and CSRF-protected. Timeout (default 120 s) becomes a denial, so an agent cannot hang forever.

Execution is non-interactive: sanitized environment, `bash -lc`, CPU rlimit, process-group kill on timeout, and a 256 KB output cap. Commands are audited with sizes and outcome, never full output (output may contain credentials).

### 4.2 Avatar ingestion

`set_agent_avatar({image_url})`:

1. HTTPS only (unless `UMBRA_ALLOW_HTTP_AVATARS=1` for development).
2. DNS resolved once; **every** address must be public; connection is pinned to the validated IP to defeat DNS rebinding.
3. Redirects are re-validated, max 3; 10 s timeout; 4 MB cap; PNG/JPEG/WebP only.
4. Image is structurally parsed and **re-written**, dropping EXIF/XMP/ICC/text chunks; APNG/animated WebP rejected; max 2048 px and 4.2 MP.
5. Stored 0600 under `agents/avatars/<token>.<ext>`; served only through the authenticated admin API with `nosniff` and a sandbox CSP.

### 4.3 Audit log

Every event is appended to a daily JSONL file and chained:

```
hash_n = HMAC-SHA256(audit.key, canonical_json(entry_n without hash))
entry_n.prev = hash_{n-1}
```

Recorded: MCP connections, every `tools/call` with redacted arguments, terminal request/approval/denial/execution, avatar changes, plugin lifecycle, app requests, Cloudflare changes, snapshot create/restore, override changes, blocked requests. Credentials are redacted recursively before serialization.

The console verifies the full chain, exports ranges, and filters by type, actor, outcome, and free text. Retention defaults to 90 days.

---

## 5. Multi-user app governance

Policies are per member:

| Policy | App Store button | Backend |
| --- | --- | --- |
| `none` | disabled | request/install rejected |
| `request` | **Request app** | creates a queue entry |
| `manage` | **Install** | installs directly and shares the app |

Approval path:

```
member POST /umbra/api/me/request-app
  → config.access.requests[status=pending]
owner POST /umbra/api/access/requests/:id/decide
  → status=installing (returns immediately)
  → apps.install(appId)
  → addMemberShare(appId, [userId])
  → status=installed | failed(error)
```

The request is shared with the requester so it appears on their desktop. Duplicate pending/installed requests are deduplicated. The owner UI shows the queue and updates the member's policy inline. The official App Store install button calls the same API for members; the label switches to “Request app”.

---

## 6. Hardened Cloudflare exposure

### 6.1 Topology

```
Internet
  │  HTTPS (Cloudflare edge)
  ▼
cloudflared container (host network, no published ports)
  │  http://127.0.0.1:80
  ▼
lan-ingress :80/:443 ──► umbreld :22080
  │                         ├─ edge guard (JWT, lockdown, rate limit, CSP)
  │                         ├─ dashboard / login / tRPC
  │                         ├─ /umbra console + API
  │                         ├─ /mcp native MCP
  │                         └─ /apps/<id>/… path proxy ──► app gateway port
  └─ app ports are blocked from the outside by nftables
```

Only one hostname is configured. App containers are never published; the path proxy forwards the browser's app-gateway cookie.

### 6.2 Configuration in official Settings

Settings → **Cloudflare exposure** (iframe of `/umbra/#/cloudflare`) provides:

- hostname, token vs credentials-file mode, cloudflared image;
- tunnel token / credentials upload (encrypted at rest, write-only in the API);
- enable/disable, live container state and health, last error, container logs;
- Cloudflare Access: team domain, AUD tag, allowed emails, protected prefixes;
- login rate limit, lockout threshold/minutes, HSTS, strict CSP, origin lock, direct-origin blocking;
- **Emergency lockdown** kill switch.

In **token mode** the public hostname's ingress rule is managed in the Cloudflare dashboard (remote configuration). In **credentials mode** Umbra writes local ingress:

```yaml
tunnel: "<tunnel-id>"
credentials-file: /etc/cloudflared/credentials.json
ingress:
  - hostname: "umbrel.example.com"
    service: "http://127.0.0.1:80"
  - service: http_status:404
```

Tunnel secrets are sealed with AES-256-GCM using the device key; the API returns only `tokenSet`/`credentialsSet`.

### 6.3 Request policy at the edge

For requests whose Host equals the configured public hostname:

1. **Real IP** — `CF-Connecting-IP` is trusted only when the socket is loopback and a Cloudflare marker (`CF-Ray`/`CF-Visitor`) is present; otherwise `X-Forwarded-For` or the socket address. The resolved IP is attached to the request, audit events, and rate-limit keys.
2. **Lockdown** — 503 for every public request. Local/LAN access is unaffected.
3. **Access JWT** — protected paths require `Cf-Access-Jwt-Assertion` (header or `CF_Authorization` cookie). RS256 signature, `kid`, JWKS (cached, refreshed on rotation), audience, issuer, `exp`/`nbf` with 60 s skew, email allowlist, and optional group claim.
4. **Origin lock** — mutations must carry `Origin: https://<configured-host>`; `/mcp` (bearer) and `/app-auth` are exempt.
5. **Brute force** — per-IP token bucket on login endpoints plus failure lockout. Lockout state clears on successful interval expiry or CLI reset.
6. **Headers** — HSTS on public requests; strict CSP (`default-src 'self'`, no third-party scripts, `frame-ancestors 'none'`, `object-src 'none'`); `/umbra` additionally gets `X-Frame-Options: DENY` and `no-store`.
7. **Portal** — `/`, `/login`, static assets, public account avatars, and an allowlist of public tRPC procedures remain reachable without Access. Everything else is protected.

WebSocket upgrades do not pass through Express, so the upgrade handler calls the same Access/lockdown policy before consuming a ticket.

### 6.4 Single-subdomain app routing

`/apps/<appId>/…` authenticates the browser session, checks member sharing, resolves the app's declared port, and proxies to the app gateway with the app-gateway cookie. HTML gets a `<base href="/apps/<id>/">`; root-absolute `src/href/action/poster` and CSS `url(/…)` are rewritten; redirects are prefixed; cookie paths are scoped.

**Limits (deliberate, documented):** an app that hard-codes `fetch('/api')`, registers a service worker, or requires WebSockets is not path-safe. Those apps need a dedicated hostname; the proxy does not pretend otherwise. This is why the feature is labelled experimental and exposed only through the single-hostname opt-in, with app links falling back to the native app gateway on the LAN.

### 6.5 Kill switch and recovery

- UI: Settings → Cloudflare → **Kill switch** sets `lockdown=true`, stops the container, and refuses public traffic.
- API: `POST /umbra/api/cloudflare/lockdown {locked:true}`.
- CLI fallback on the device:

```sh
docker rm -f umbra-cloudflared
```

The tunnel does not auto-restart while lockdown is set; release it in the UI/API. Local access remains available for recovery.

---

## 7. Additional power-user features

1. **Persistent app overrides + quotas** — stored in `umbra/app-overrides/<id>/`, appended by `app-script` after the generated settings file. CPU, memory, PID limits are enforced by Compose; VRAM is recorded as a label because Docker/NVIDIA expose no per-container VRAM quota. Overrides survive app updates/reinstalls.
2. **Encrypted configuration snapshots** — Umbra config, agents, plugin manifests/settings, overrides, and per-app `settings.yml`, gzipped and AES-256-GCM sealed (device key or scrypt passphrase). A snapshot is taken automatically before OS and app auto-updates. Restore is restricted to Umbra-managed files and requires a restart.
3. **Maintenance-window app auto-updates** — per-app policy, day/time window, compatibility filter, sequential updates (max 3 per tick), pre-update snapshot, and audit entries.
4. **Tamper-evident audit export** — an investigation/forensics feature that pairs with the AI logs view.
5. **Plugin widget data contract** — lets plugins contribute dashboard data without executing code in the dashboard origin.

---

## 8. Security boundaries and honest limits

- **Root terminal is root.** The terminal tool is an explicit owner grant, not a sandbox. Approval and audit reduce risk; they do not contain a malicious owner.
- **Plugin sandbox** blocks filesystem and network but shares the host kernel. A kernel exploit is out of scope. Plugins are not a substitute for OS-level multi-tenancy.
- **Cloudflare Access** protects privileged paths; the public portal is intentionally reachable. A misconfigured Access application (wrong AUD/team) fails closed (403).
- **Direct-origin blocking** is best-effort: LAN clients can spoof Cloudflare headers. Access JWT enforcement, not header detection, is the actual control.
- **Path routing** cannot fix apps that assume origin-root URLs; documented above.
- **Official OTA** restores backend hooks via the pre-start hook; compiled Settings UI rows require the fork image.
- **Secrets** are encrypted with a device key stored beside them. An attacker with the whole data directory and root can decrypt them; this protects backups, not a compromised host.

---

## 9. Verification

```sh
# unit + integration tests (no device needed)
cd packages/umbreld
npx tsx --test source/umbra/test/*.test.ts

# typecheck the isolated layer
npx tsc -p source/umbra/tsconfig.json

# integration markers
node source/umbra/tools/integrate.mjs --check

# on a device
sudo ./scripts/umbra/bootstrap-device.sh
systemctl restart umbrel
```

Test coverage includes config validation, audit chain integrity/tamper detection, image sanitization (PNG/JPEG/WebP), manifest and file validation, plugin lifecycle + real sandbox activation, member request/approval flow, snapshot encryption/restore, terminal approval timeout/deny, Access JWT signatures/policy, and edge lockdown/origin/rate-limit behavior.
