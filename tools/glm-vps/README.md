# GLM en VPS — agente de código headless con Ollama cloud

Levanta un **agente de código** (Claude Code CLI) potenciado por un **modelo cloud de Ollama**
(por defecto `glm-5.2:cloud`) en un VPS Ubuntu headless. El cómputo del modelo es **remoto**
(Ollama cloud), así que **no necesitas GPU** — solo el cliente + tu cuenta de Ollama con acceso cloud.

Reproducible por terceros: cada uno en **su propio VPS** y con **su propia cuenta de Ollama**.

## Prerequisitos
- VPS **Ubuntu** (22.04 / 24.04), acceso **root/sudo**.
- Una **cuenta de Ollama con acceso cloud** (https://ollama.com) — `glm-5.2:cloud` es un modelo cloud.

## Instalación
```bash
curl -fsSL https://raw.githubusercontent.com/MauricioPerera/a2e-engine/main/tools/glm-vps/setup-glm-vps.sh -o setup-glm-vps.sh
sudo bash setup-glm-vps.sh
```
Instala Node 22, Ollama, el CLI Claude Code y un wrapper `glm`. Durante el setup, **`ollama signin`**
abrirá un flujo: visita la URL que imprime y autoriza con **TU** cuenta de ollama.com.

## Uso
```bash
glm "crea /tmp/ok.txt con el texto FUNCIONA y nada mas"
```
`glm "<tarea>"` lanza el agente headless sobre la tarea (auto-aprueba edits + Bash).

## Variables
- `GLM_MODEL` — modelo cloud de Ollama (default `glm-5.2:cloud`). Ej: `GLM_MODEL=kimi-k2.6:cloud`.
- `SKIP_SIGNIN=1` — omite el `signin` interactivo (para CI / construir imágenes).

## Notas / gotchas (ya resueltos en el script)
- El instalador de Ollama necesita **`zstd`** → el script lo instala.
- La auth (keypair) debe vivir en el home del **servicio** ollama (`/usr/share/ollama/.ollama`),
  o el daemon no la ve → el script hace `signin` como el usuario correcto.
- Como **root**, `--dangerously-skip-permissions` está bloqueado por Claude Code → el wrapper usa
  `--permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read"`.
- Los **modelos cloud no aparecen en `ollama list`** pero sí se ejecutan.
- **Sin systemd** (p.ej. dentro de un contenedor) el script arranca `ollama serve` en background.

## Verificado
Probado en un contenedor **Ubuntu 24.04 limpio** (install completo de node + ollama + claude + wrapper,
`SKIP_SIGNIN=1`). El `signin` y la ejecución del modelo requieren tu cuenta cloud.
