#!/usr/bin/env bash
# Golden Influencer — host verification and environment fingerprint (Linux / WSL2).
# Read-only. Prints JSON shaped for ops.environment_fingerprints (docs/14 §1).
# Fields that cannot be read are null and listed in "missing"; an incomplete
# fingerprint cannot satisfy a benchmark gate.
#
#   ops/scripts/verify-host.sh > fingerprint.json
set -uo pipefail

ENGINE_PORTS="${ENGINE_PORTS:-8188}"
LLM_PORTS="${LLM_PORTS:-8000 8080 11434}"
PG_PORT="${PG_PORT:-5432}"
MIN_RAM_GB="${MIN_RAM_GB:-64}"
MIN_FREE_DISK_GB="${MIN_FREE_DISK_GB:-500}"

missing=()
json_str() { if [ -z "${1:-}" ]; then printf 'null'; else printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; fi; }

os_name=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s)
kernel=$(uname -r)
cpu_model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ //')
cpu_threads=$(nproc 2>/dev/null || echo "")
ram_kb=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
if [ -n "$ram_kb" ]; then ram_gb=$(awk -v k="$ram_kb" 'BEGIN{printf "%.1f", k/1048576}'); else ram_gb=""; missing+=("ram"); fi
in_wsl=false; grep -qi microsoft /proc/version 2>/dev/null && in_wsl=true

disks=$(df -B1G --output=target,fstype,size,avail -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2 | awk '{printf "{\"mount\":\"%s\",\"filesystem\":\"%s\",\"size_gb\":%s,\"free_gb\":%s},", $1,$2,$3+0,$4+0}' | sed 's/,$//')
[ -z "$disks" ] && missing+=("storage")
max_free=$(df -B1G --output=avail -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2 | sort -n | tail -1 | tr -d ' ')

gpu_json="null"; cuda_driver=""
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_json=$(nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap,power.limit,temperature.gpu --format=csv,noheader,nounits 2>/dev/null \
    | awk -F', ' '{printf "{\"name\":\"%s\",\"vram_total_mb\":%s,\"driver_version\":\"%s\",\"compute_capability\":\"%s\",\"power_limit_w\":\"%s\",\"temperature_c\":\"%s\"},", $1,$2,$3,$4,$5,$6}' | sed 's/,$//')
  gpu_json="[${gpu_json}]"
  cuda_driver=$(nvidia-smi 2>/dev/null | grep -o 'CUDA Version: [0-9.]*' | awk '{print $3}')
else
  missing+=("gpu (nvidia-smi not found)")
fi
nvcc_ver=$(command -v nvcc >/dev/null 2>&1 && nvcc --version | grep -o 'release [0-9.]*' | awk '{print $2}' || echo "")

port_json() {
  local port=$1 line
  line=$( (ss -ltnpH "sport = :$port" 2>/dev/null || true) | head -1)
  if [ -n "$line" ]; then printf '{"port":%s,"listening":true,"detail":%s}' "$port" "$(json_str "$line")"; else printf '{"port":%s,"listening":false}' "$port"; fi
}
engine_ports=$(for p in $ENGINE_PORTS; do port_json "$p"; printf ','; done | sed 's/,$//')
llm_ports=$(for p in $LLM_PORTS; do port_json "$p"; printf ','; done | sed 's/,$//')
pg_port=$(port_json "$PG_PORT")
comfy=$(pgrep -af 'comfy' 2>/dev/null | grep -v pgrep | head -5 | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')

node_v=$(node --version 2>/dev/null || echo "")
psql_v=$(psql --version 2>/dev/null || echo "")
docker_present=false; command -v docker >/dev/null 2>&1 && docker_present=true

ram_ok=null; [ -n "$ram_gb" ] && ram_ok=$(awk -v r="$ram_gb" -v m="$MIN_RAM_GB" 'BEGIN{print (r>=m)?"true":"false"}')
disk_ok=null; [ -n "$max_free" ] && disk_ok=$(awk -v f="$max_free" -v m="$MIN_FREE_DISK_GB" 'BEGIN{print (f>=m)?"true":"false"}')
gpu_ok=false; [ "$gpu_json" != "null" ] && gpu_ok=true
engine_ok=false; echo "$engine_ports" | grep -q '"listening":true' && engine_ok=true
pg_ok=false; echo "$pg_port" | grep -q '"listening":true' && pg_ok=true

missing_json=$(printf '%s\n' "${missing[@]:-}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
complete=true; [ "${#missing[@]}" -gt 0 ] && complete=false

body=$(cat <<EOF
{
  "schema": "golden.environment_fingerprint/1",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": $(json_str "$(hostname)"),
  "os": {"name": $(json_str "$os_name"), "kernel": $(json_str "$kernel"), "wsl": $in_wsl},
  "cpu": {"model": $(json_str "$cpu_model"), "logical_processors": ${cpu_threads:-null}},
  "ram": {"visible_to_os_gb": ${ram_gb:-null}, "note": "Inside WSL2 this is the WSL memory limit, not installed RAM. Run verify-host.ps1 on Windows for installed RAM."},
  "storage": [${disks}],
  "gpu": ${gpu_json},
  "max_cuda_version_supported_by_driver": $(json_str "$cuda_driver"),
  "cuda_toolkit": $(json_str "$nvcc_ver"),
  "services": {"postgres_port": ${pg_port}, "visual_engine_ports": [${engine_ports}], "llm_ports": [${llm_ports}], "comfyui_processes": ${comfy}, "docker": ${docker_present}},
  "node": $(json_str "$node_v"),
  "psql": $(json_str "$psql_v"),
  "checks": {"ram_at_least_min": ${ram_ok}, "largest_free_disk_at_least_min": ${disk_ok}, "nvidia_gpu_present": ${gpu_ok}, "visual_engine_listening": ${engine_ok}, "postgres_listening": ${pg_ok}},
  "thresholds": {"min_ram_gb": ${MIN_RAM_GB}, "min_free_disk_gb": ${MIN_FREE_DISK_GB}, "source": "docs/15 section 4"},
  "missing": ${missing_json},
  "complete": ${complete}
}
EOF
)
hash=$(printf '%s' "$body" | sha256sum | awk '{print $1}')
printf '{"fingerprint": %s, "fingerprint_hash": "%s"}\n' "$body" "$hash" | python3 -m json.tool
