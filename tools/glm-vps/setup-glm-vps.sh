#!/usr/bin/env bash
# setup-glm-vps.sh — Bootstrap a headless coding agent (Claude Code CLI) powered by
# an Ollama *cloud* model (default: glm-5.2:cloud) on a fresh Ubuntu VPS.
#
# Idempotent. Run as root (or via sudo). Tu cómputo del modelo es REMOTO (Ollama cloud),
# así que el VPS NO necesita GPU — solo el cliente + tu cuenta de Ollama con acceso cloud.
#
#   sudo bash setup-glm-vps.sh
#   glm "crea /tmp/ok.txt con el texto FUNCIONA"
#
# Env:
#   GLM_MODEL   modelo cloud de ollama (default glm-5.2:cloud)
#   SKIP_SIGNIN =1 omite el paso interactivo de signin (para CI/imágenes)
set -euo pipefail

MODEL="${GLM_MODEL:-glm-5.2:cloud}"
SKIP_SIGNIN="${SKIP_SIGNIN:-0}"
log(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
[ "$(id -u)" = "0" ] || { echo "Corre como root (sudo bash $0)"; exit 1; }

# --- 0. Prereqs base (zstd lo necesita el instalador de ollama; curl/ca-certs el resto) ---
log "Prereqs del sistema (curl, ca-certificates, zstd)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates zstd >/dev/null

# --- 1. Node 22+ (lo necesita el CLI claude) ---
if ! have node || [ "$(node -v | tr -dc '0-9.' | cut -d. -f1)" -lt 22 ]; then
  log "Instalando Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else log "Node $(node -v) ya presente"; fi

# --- 2. Ollama ---
if ! have ollama; then
  log "Instalando Ollama"
  curl -fsSL https://ollama.com/install.sh | sh
else log "Ollama ya presente ($(ollama --version 2>/dev/null | head -1))"; fi

# --- 2b. Daemon arriba: systemd si existe, si no `ollama serve` en background ---
USE_SYSTEMD=0
if have systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service'; then
  USE_SYSTEMD=1; systemctl enable --now ollama 2>/dev/null || true
else
  pgrep -x ollama >/dev/null 2>&1 || { log "Arrancando ollama serve (sin systemd)"; nohup ollama serve >/var/log/ollama.log 2>&1 & sleep 2; }
fi
# El servicio systemd corre como usuario 'ollama' con HOME /usr/share/ollama -> la auth
# (keypair) DEBE vivir ahí, si no el daemon no la ve.
if getent passwd ollama >/dev/null; then OLL_USER=ollama; OLL_HOME=$(getent passwd ollama | cut -d: -f6); else OLL_USER=root; OLL_HOME=/root; fi
run_as_ollama(){ if [ "$OLL_USER" = root ]; then HOME="$OLL_HOME" "$@"; else runuser -u "$OLL_USER" -- env HOME="$OLL_HOME" "$@"; fi; }
sleep 2

# --- 3. Auth cloud (TU cuenta de Ollama; interactivo: imprime una URL a autorizar) ---
model_ok(){ echo hi | run_as_ollama timeout 40 ollama run "$MODEL" >/dev/null 2>&1; }
if [ "$SKIP_SIGNIN" = "1" ]; then
  log "SKIP_SIGNIN=1 — saltando auth (hazlo luego: runuser -u $OLL_USER -- ollama signin)"
elif model_ok; then
  log "Auth Ollama OK (el modelo $MODEL responde)"
else
  log "Auth Ollama requerida — se abrirá 'ollama signin'"
  echo "Visita la URL que imprima y autoriza con TU cuenta de ollama.com (necesita acceso cloud)."
  run_as_ollama ollama signin || true
  [ "$USE_SYSTEMD" = 1 ] && systemctl restart ollama 2>/dev/null || true
  sleep 2
fi

# --- 4. Claude Code CLI ---
if ! have claude; then log "Instalando Claude Code CLI"; npm install -g @anthropic-ai/claude-code; else log "claude $(claude --version 2>/dev/null | head -1) ya presente"; fi

# --- 5. Wrapper 'glm' ---
log "Instalando /usr/local/bin/glm"
cat > /usr/local/bin/glm <<WRAP
#!/usr/bin/env bash
# glm "tarea"  — Claude Code (modelo ${MODEL}) headless sobre la tarea.
# Como root, --dangerously-skip-permissions está bloqueado -> acceptEdits + allowedTools.
exec ollama launch claude --model "\${GLM_MODEL:-${MODEL}}" -y -- \\
  --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read" -p "\$*" </dev/null
WRAP
chmod +x /usr/local/bin/glm

# --- 6. Verificación ---
log "Verificación"
have ollama && have claude && echo "binarios: ollama + claude OK"
[ -x /usr/local/bin/glm ] && echo "wrapper glm OK"
echo
echo "Listo. Si ya hiciste signin, prueba:"
echo "    glm \"crea /tmp/ok.txt con el texto FUNCIONA y nada mas\""
echo "(Si el modelo no responde, corre:  runuser -u $OLL_USER -- ollama signin )"
