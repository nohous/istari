#!/usr/bin/env bash
# Produces images/istari.gif and images/listing.png for the README by driving
# the extension in a headless VS Code on the WPX workspace.
#
# Needs: xvfb-run, ImageMagick (import, convert), ffmpeg, xdotool, and enough
# free inotify instances for a VS Code process (fs.inotify.max_user_instances).
set -euo pipefail
cd "$(dirname "$0")/.."

FRAMES=${ISTARI_SHOTS_DIR:-$(mktemp -d)}
WIDTH=${ISTARI_SHOTS_WIDTH:-1440}
HEIGHT=${ISTARI_SHOTS_HEIGHT:-900}
TITLE_BAR=${ISTARI_SHOTS_TITLE_BAR:-0}
OUT_WIDTH=${ISTARI_GIF_WIDTH:-1200}
SECONDS_PER_FRAME=${ISTARI_GIF_SECONDS:-3.5}

pnpm run compile-tests >/dev/null
pnpm run compile >/dev/null

# A capture profile of its own: no extensions, no git, a bare workbench.
mkdir -p .vscode-test/shots-user-data/User
cp scripts/shots-settings.json .vscode-test/shots-user-data/User/settings.json

# Electron follows WAYLAND_DISPLAY when it is set and would open on the desktop
# instead of the virtual X server.
env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 ELECTRON_OZONE_PLATFORM_HINT=x11 \
    ISTARI_SHOTS_DIR="$FRAMES" ISTARI_SHOTS_WIDTH="$WIDTH" ISTARI_SHOTS_HEIGHT="$HEIGHT" \
    xvfb-run -a -s "-screen 0 ${WIDTH}x${HEIGHT}x24" pnpm exec vscode-test --label screenshots

# Crop the window title bar off every frame.
mkdir -p "$FRAMES/cropped"
for f in "$FRAMES"/*.png; do
    convert "$f" -crop "${WIDTH}x$((HEIGHT - TITLE_BAR))+0+${TITLE_BAR}" +repage "$FRAMES/cropped/$(basename "$f")"
done

mkdir -p images
cp "$FRAMES/cropped/2-listing.png" images/listing.png
ffmpeg -y -loglevel error -framerate "1/${SECONDS_PER_FRAME}" -pattern_type glob -i "$FRAMES/cropped/*.png" \
    -vf "scale=${OUT_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=255:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 images/istari.gif

ls -la images/istari.gif images/listing.png
echo "frames kept in $FRAMES"
