#!/usr/bin/env bash
# transcode-hls.sh — Turn an approved ad MP4 into an adaptive HLS ladder.
#
# Usage:  ./transcode-hls.sh <input.mp4> <adId> [outDir]
# Output: <outDir>/<adId>/master.m3u8 + 240p/360p/480p renditions + segments.
#
# Renditions are deliberately small (an ad, not cinema): H.264 baseline + AAC,
# 2s segments. Adaptive bitrate means weak devices pull the low ladder and a
# subscriber who drops off early only downloads what they watched — minimising
# ETC data transfer. Serve the result from deploy/nginx-video.conf.
set -euo pipefail

IN="${1:?input mp4 required}"
AD_ID="${2:?adId required}"
OUT_DIR="${3:-/srv/hls}"
DEST="${OUT_DIR}/${AD_ID}"
mkdir -p "$DEST"

# rendition: name  height  video-bitrate  maxrate  bufsize  audio-bitrate
render() {
  local name="$1" h="$2" vb="$3" mr="$4" bs="$5" ab="$6"
  ffmpeg -y -i "$IN" \
    -vf "scale=-2:${h}" \
    -c:v libx264 -profile:v baseline -level 3.1 -preset veryfast \
    -b:v "$vb" -maxrate "$mr" -bufsize "$bs" \
    -c:a aac -b:a "$ab" -ac 2 \
    -hls_time 2 -hls_playlist_type vod \
    -hls_segment_filename "${DEST}/${name}_%03d.ts" \
    "${DEST}/${name}.m3u8"
}

render "240p" 240 "300k"  "360k"  "600k"  "48k"
render "360p" 360 "600k"  "720k"  "1200k" "64k"
render "480p" 480 "1000k" "1200k" "2000k" "96k"

# Master playlist referencing the ladder.
cat > "${DEST}/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240
240p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1150000,RESOLUTION=854x480
480p.m3u8
EOF

echo "HLS ready: ${DEST}/master.m3u8"
echo "Serve as:  /hls/${AD_ID}/master.m3u8"
