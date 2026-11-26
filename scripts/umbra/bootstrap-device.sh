#!/bin/bash
# Install or refresh the Umbra runtime on an umbrelOS device.
#
# Run as root on the device after installing this fork:
#   sudo ./scripts/umbra/bootstrap-device.sh
#
# What it does:
#   1. Copies the custom runtime into the persistent data partition.
#   2. Installs a data-resident pre-start hook that re-applies the integration
#      bridges after an official OTA replaced /opt/umbreld.
#   3. Runs the integrator now so the running daemon picks the layer up on the
#      next restart.
set -eu

DATA_DIR="${UMBREL_ROOT:-/home/umbrel/umbrel}"
UMBREL_SOURCE="${UMBREL_SOURCE:-/opt/umbreld}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${DATA_DIR}/umbra/runtime"
HOOK_DIR="${DATA_DIR}/custom-hooks"
HOOK_PATH="${HOOK_DIR}/pre-start"

if [ "$(id -u)" -ne 0 ]; then
	echo "umbra: run this as root" >&2
	exit 1
fi

mkdir -p "${DATA_DIR}/umbra" "${HOOK_DIR}"
chmod 700 "${DATA_DIR}/umbra"

# Prefer the packaged runtime on the device; fall back to this checkout for
# development images that do not copy packages/umbreld/source/umbra yet.
if [ -d "${UMBREL_SOURCE}/source/umbra" ]; then
	SOURCE_RUNTIME="${UMBREL_SOURCE}/source/umbra"
else
	SOURCE_RUNTIME="${REPO_DIR}/packages/umbreld/source/umbra"
fi
if [ ! -d "${SOURCE_RUNTIME}" ]; then
	echo "umbra: cannot find the runtime at ${SOURCE_RUNTIME}" >&2
	exit 1
fi

rm -rf "${RUNTIME_DIR}.new"
cp -a "${SOURCE_RUNTIME}" "${RUNTIME_DIR}.new"
rm -rf "${RUNTIME_DIR}"
mv "${RUNTIME_DIR}.new" "${RUNTIME_DIR}"
chmod -R u+rwX,go-w "${RUNTIME_DIR}"

cat > "${HOOK_PATH}" <<'HOOK'
#!/bin/bash
# Managed by Umbra. Re-applies the custom layer after an official OTA replaced
# /opt/umbreld, using only data-partition files. Never blocks umbreld startup.
set -u
DATA_DIR="${UMBREL_ROOT:-/home/umbrel/umbrel}"
RUNTIME_DIR="${DATA_DIR}/umbra/runtime"
LOG="${DATA_DIR}/umbra/pre-start.log"
if [ ! -f "${RUNTIME_DIR}/tools/integrate.mjs" ]; then
	exit 0
fi
if command -v node >/dev/null 2>&1; then
	node "${RUNTIME_DIR}/tools/integrate.mjs" --repo /opt/umbreld --data "${DATA_DIR}" --from "${RUNTIME_DIR}" --quiet >>"${LOG}" 2>&1 || true
fi
exit 0
HOOK
chmod 755 "${HOOK_PATH}"

# Apply now. Failure here is reported but does not prevent bootstrapping the hook.
node "${RUNTIME_DIR}/tools/integrate.mjs" --repo "${UMBREL_SOURCE}" --data "${DATA_DIR}" || {
	echo "umbra: integration failed; inspect ${DATA_DIR}/umbra/pre-start.log after next boot" >&2
	exit 1
}

echo "umbra: runtime installed at ${RUNTIME_DIR}"
echo "umbra: pre-start hook installed at ${HOOK_PATH}"
echo "umbra: restart umbreld to load the layer: systemctl restart umbrel"
