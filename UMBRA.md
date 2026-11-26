# Umbra — umbrelOS custom layer

Umbra is a non-destructive fork layer for **umbrelOS 2.0.1**. It adds:

- a sandboxed **plugin/modding engine** with AI-friendly manifests and MCP scaffolding;
- native **MCP terminal access** with per-agent *always allowed* / *ask every time* policies, live approval prompts, avatar ingestion, and a tamper-evident **AI Agent Logs** view;
- **multi-user app permissions** with a one-click request/approval queue;
- hardened **single-hostname Cloudflare Tunnel** exposure configured inside official Settings, with Cloudflare Access JWT enforcement, real-IP restoration, rate limits, HSTS/CSP, origin lock, and an emergency kill switch;
- persistent **Compose overrides + CPU/memory quotas**, **encrypted configuration snapshots**, and maintenance-window **app auto-updates**.

## Start here

| Document | What it covers |
| --- | --- |
| [Architecture blueprint](docs/umbra/ARCHITECTURE.md) | upstream sync model, data layout, MCP/plugin/Cloudflare flows, threat model |
| [Plugin API](docs/umbra/PLUGIN_API.md) | strict manifest schema, sandbox contract, AI generation loop |
| [Operations](docs/umbra/OPERATIONS.md) | install, OTA recovery, tests, API map, troubleshooting |
| [Verification](docs/umbra/VERIFICATION.md) | what was tested, what requires a device |

## Quick start

```sh
sudo ./scripts/umbra/bootstrap-device.sh
sudo systemctl restart umbrel
```

Then open **Settings → Umbra** or `http://umbrel.local/umbra/`.

## Status

Backend implementation is complete and unit-tested on Node 24 (62 tests, including real plugin sandbox activation, JWT verification, audit tamper detection, encrypted snapshot restore, and the authenticated HTTP API). The official Settings entries are small iframe bridges; the console is a self-contained, CSP-safe app served by umbreld.

Known limits are documented rather than hidden: path routing only works for path-safe apps, a stock OTA restores backend hooks but not compiled Settings rows, and the terminal is deliberately a root capability granted by the owner.

