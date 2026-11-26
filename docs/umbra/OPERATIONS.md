# Umbra operations

## First install on a device

```sh
git clone <your-fork> umbrel && cd umbrel
sudo ./scripts/umbra/bootstrap-device.sh
sudo systemctl restart umbrel
```

Verify:

```sh
journalctl -u umbrel -n 100 --no-pager | grep -i umbra
curl -s http://127.0.0.1:22080/umbra/api/health   # 401 without a session is expected
```

Open **Settings → Umbra**. The console is also directly reachable at `/umbra/`.

## Pulling a new upstream release

```sh
git remote add upstream https://github.com/getumbrel/umbrel.git   # once
node scripts/umbra/sync-upstream.mjs --check
node scripts/umbra/sync-upstream.mjs
```

If the rebase stops, resolve only the marked `// <umbra:…>` blocks, then:

```sh
git rebase --continue
node packages/umbreld/source/umbra/tools/integrate.mjs --check
```

The script creates `backup/umbra-<timestamp>` before touching history and updates `umbra-fork.json.base` after verification.

## Tests

```sh
cd packages/umbreld
npx tsx --test source/umbra/test/*.test.ts
npx tsc -p source/umbra/tsconfig.json
node source/umbra/tools/integrate.mjs --check
```

`tsconfig.json` in `source/umbra` is intentionally self-contained: it excludes the MCP adapter file and uses only Node types, so the layer can be validated without installing umbreld's native dependency tree. The MCP adapter is type-checked as part of the full monorepo build.

## Device paths

| Path | Contents |
| --- | --- |
| `/home/umbrel/umbrel/umbra/config.json` | validated configuration |
| `…/umbra/audit/` | chained JSONL audit log |
| `…/umbra/agents/` | agent profiles + avatars |
| `…/umbra/plugins/` | installed plugins + plugin data |
| `…/umbra/app-overrides/` | persistent Compose overrides |
| `…/umbra/snapshots/` | encrypted config snapshots |
| `…/umbra/runtime/` | post-OTA runtime copy |
| `…/custom-hooks/pre-start` | post-OTA bridge re-application |

## CLI fallbacks

```sh
# Emergency tunnel kill switch
docker rm -f umbra-cloudflared

# Stop a misbehaving plugin
curl -X POST http://127.0.0.1:22080/umbra/api/plugins/<id>/disable \
  -H "cookie: UMBREL_BROWSER_SESSION=…" -H "x-umbra-csrf: …"

# Verify audit chain from a shell
node -e "import('/opt/umbreld/source/umbra/audit.js').then(async ({default:A})=>{const a=new A('/home/umbrel/umbrel/umbra');await a.start();console.log(await a.verify())})"
```

## API map

Owner session required unless noted. Mutations require `x-umbra-csrf` (from `GET /umbra/api/session`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/umbra/api/session` | session, role, CSRF token |
| GET | `/umbra/api/summary` | dashboard summary |
| GET | `/umbra/api/agents` | agent profiles + avatars |
| POST | `/umbra/api/agents/:id/terminal-policy` | `{mode, allowlist}` |
| GET | `/umbra/api/agents/:id/avatar` | avatar bytes |
| GET | `/umbra/api/approvals` | pending commands |
| GET | `/umbra/api/approvals/stream` | SSE approval feed |
| POST | `/umbra/api/approvals/:id/decide` | `{approved, reason?}` |
| GET | `/umbra/api/audit` | filter/paginate |
| GET | `/umbra/api/audit/verify` | chain verification |
| GET | `/umbra/api/audit/export` | JSON export |
| GET | `/umbra/api/cloudflare` | settings, status, logs |
| POST | `/umbra/api/cloudflare/settings` | hostname, mode, Access, security |
| POST | `/umbra/api/cloudflare/token` | store token |
| POST | `/umbra/api/cloudflare/credentials` | store credentials JSON |
| POST | `/umbra/api/cloudflare/enable` / `disable` / `lockdown` | tunnel lifecycle |
| GET | `/umbra/api/plugins` | installed plugins |
| POST | `/umbra/api/plugins/install` | manifest + files |
| POST | `/umbra/api/plugins/:id/enable` / `disable` / `uninstall` / `settings` | lifecycle |
| GET | `/umbra/api/plugins/widgets` | widget data |
| GET | `/umbra/api/access/members` | members + policies |
| POST | `/umbra/api/access/members/:id/policy` | set policy |
| GET/POST | `/umbra/api/access/requests` | queue |
| POST | `/umbra/api/access/requests/:id/decide` | approve/deny |
| GET/POST | `/umbra/api/me/request-app` | member request (member session) |
| POST | `/umbra/api/me/install-app` | direct install if `manage` |
| GET/POST/DELETE | `/umbra/api/apps/:id/overrides` | quotas + Compose |
| GET/POST | `/umbra/api/snapshots` | list/create |
| POST | `/umbra/api/snapshots/:id/restore` | restore |
| GET/POST | `/umbra/api/auto-update` | maintenance window |

## Troubleshooting

**`/umbra` returns 401** — you are not signed in to umbrelOS, or the session cookie is for the other scheme (HTTP vs HTTPS). Sign in again through the same scheme.

**Settings → Umbra is missing after an OTA** — the backend hooks are restored by the pre-start hook, but Settings rows are compiled into the UI bundle. Use `/umbra/` directly or install the fork image; check `/home/umbrel/umbrel/umbra/pre-start.log`.

**Plugin stays disabled after enable** — `lastError` is shown in the console. Common causes: entry file missing, a permission used without declaring it, syntax error, or (Linux) `unshare` unavailable. Reinstall fixed files; the supervisor disables after three crashes.

**Tunnel container exits immediately** — inspect `docker logs umbra-cloudflared`. Token mode needs the public hostname configured in the Cloudflare dashboard to point at `http://127.0.0.1:80`; credentials mode writes local ingress. Ensure Docker is running and the image name is correct.

**App path page is blank** — the app assumes origin-root URLs or uses WebSockets; use the app gateway/LAN URL instead. This is a documented limitation of path routing.

**Everything external returns 503** — emergency lockdown is active. Release it in Settings → Cloudflare or via the API.

## Security checklist before exposing

- [ ] Long owner password + 2FA enabled.
- [ ] Cloudflare Access application covers `/settings`, `/umbra`, `/mcp`, `/terminal`, `/api`, `/trpc` (the default prefix list).
- [ ] `audience` is the Access application's AUD tag, not the team domain.
- [ ] Tunnel token/credentials stored through the UI, never in git.
- [ ] Test the kill switch once and confirm local access still works.
- [ ] Review Audit logs → Verify integrity after setup.
- [ ] Keep the pre-start hook and `umbra/runtime` in backups.
