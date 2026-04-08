#!/bin/bash
# Double-click this file in Finder to choose and run a converter script.
# Requires: Node.js on PATH (https://nodejs.org/)

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Finder-launched .command windows often stay open after the shell exits; close this window explicitly.
# Schedule the close *after* this shell exits. If we call osascript while bash is still running,
# Terminal shows "terminate bash, osascript?" — users should not need to answer that.
close_terminal_window() {
  (
    sleep 0.35
    osascript -e 'tell application "Terminal" to if (count of windows) > 0 then close front window saving no' 2>/dev/null || true
  ) &
  disown -h "$!" 2>/dev/null || true
}

prompt_then_close_terminal() {
  read -rp "Press Enter to close… "
  close_terminal_window
}

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js not found" message "Install Node.js from https://nodejs.org/ and try again. It must be available in your terminal PATH." as critical' >/dev/null 2>&1 || true
  echo "Node.js not found. Install from https://nodejs.org/"
  prompt_then_close_terminal
  exit 1
fi

while true; do
  echo ""
  echo "ZT PNG Converter"
  echo "  1  PNG to ZT1"
  echo "  2  ZT1 to PNG"
  echo "  Q  Quit"
  echo ""
  read -rp "Enter choice (1, 2, or Q): " zt_choice
  zt_choice_lc=$(printf '%s' "$zt_choice" | tr '[:upper:]' '[:lower:]')
  case "$zt_choice_lc" in
    1)
      export ZT_CONVERTER_FROM_LAUNCHER=1
      node "$DIR/src/pngToZt1Assets.js"
      break
      ;;
    2)
      export ZT_CONVERTER_FROM_LAUNCHER=1
      node "$DIR/src/zt1GraphicToPng.js"
      break
      ;;
    q)
      close_terminal_window
      exit 0
      ;;
    *)
      echo "Invalid choice."
      ;;
  esac
done

echo
prompt_then_close_terminal
