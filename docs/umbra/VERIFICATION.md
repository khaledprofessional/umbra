# Verification report

Environment: Windows host, Node 24.22.1, TypeScript 5.8.3. Upstream base: `getumbrel/umbrel` tag `2.0.1` (`a72dac24`).

| Check | Command | Result |
| --- | --- | --- |
| Umbra unit/integration tests | `npx tsx --test source/umbra/test/*.test.ts` | 62 tests, 61 pass, 1 skipped (bash unavailable on Windows) |
| umbreld typecheck (real deps) | `npm run typecheck` in `packages/umbreld` | 0 errors |
| Isolated layer typecheck | `tsc -p source/umbra/tsconfig.json` | 0 errors |
| UI typecheck | `npm run typecheck` in `packages/ui` | 0 errors |
| UI production build | `npm run build` in `packages/ui` | built successfully (≈52 s) |
| UI lint | `eslint` on changed UI files | 0 errors |
| Formatting | `prettier --check source/umbra/**` | clean |
| Translations | `node update-translations.js --validate` | passed |
| Integration doctor | `node source/umbra/tools/integrate.mjs --check` | complete |
| Fresh 2.0.1 anchors | integrator against a pristine copy of the 2.0.1 files | 12/12 patches applied, idempotent |
| Shell syntax | `bash -n` on app-script, bootstrap, overlay bootstrap | 0 errors |
| Existing component tests | install button + settings catalog suites | pass |

Coverage highlights:

- atomic config writes and concurrent updates;
- HMAC audit chain, filtering, export, and tamper detection;
- PNG/JPEG/WebP re-writing (metadata stripped, animated formats rejected);
- closed plugin manifest validation including nested unknown fields;
- plugin installation plus a real sandboxed backend activation through Node's permission model;
- member request → owner approval → install → share;
- encrypted snapshots (device key and passphrase) and restore;
- terminal policy denial, approval, timeout-to-denial, and working-directory confinement;
- Cloudflare Access JWT signature/audience/expiry/policy checks;
- edge lockdown, origin lock, login rate limit, and Access gating of owner procedures;
- authenticated HTTP session/CSRF/agent listing/member request flow;
- single-subdomain app path proxy HTML, cookie, and base rewriting.

Not executed in this environment (require Linux/hardware/credentials):

- a real Rugix A/B OTA and the pre-start recovery hook on a device;
- a live Cloudflare Tunnel and Access application;
- Docker-dependent tunnel lifecycle and `unshare --net` sandbox behavior;
- umbreld's VM test suite (native bindings such as `drivelist` are Linux/device-specific).
