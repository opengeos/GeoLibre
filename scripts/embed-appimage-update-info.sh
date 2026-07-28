#!/usr/bin/env bash
#
# Embed AppImage update information into a built AppImage and write the matching
# zsync file next to it.
#
# An AppImage type-2 runtime reserves a 1 KiB `.upd_info` ELF section for a
# single "update information" string. Tauri's bundler leaves it zeroed, so
# AppImageUpdate, AppImageLauncher, AppManager and AM all report that the image
# carries no update information and refuse to update it. Filling it in, plus
# publishing a `.zsync` alongside the AppImage, lets those tools fetch only the
# blocks that changed instead of the whole ~120 MB image.
#
# See https://github.com/AppImage/AppImageSpec/blob/master/draft.md#update-information
#
# Usage:
#   REPO=opengeos/GeoLibre TAG=v1.5.0 \
#     scripts/embed-appimage-update-info.sh path/to/GeoLibre.Desktop_1.5.0_amd64.AppImage
#
#   # Print the update information string for a file name and exit (no writes):
#   REPO=opengeos/GeoLibre TAG=v1.5.0 \
#     scripts/embed-appimage-update-info.sh --print GeoLibre.Desktop_1.5.0_amd64.AppImage
#
# REPO (owner/name) and TAG (the release tag, e.g. v1.5.0) are both required.
# The AppImage is patched in place, so run this before uploading it.
set -euo pipefail

: "${REPO:?Set REPO to the GitHub repository, e.g. opengeos/GeoLibre}"
: "${TAG:?Set TAG to the release tag, e.g. v1.5.0}"

print_only=false
if [[ "${1:-}" == "--print" ]]; then
  print_only=true
  shift
fi

appimage="${1:?Pass the path to the .AppImage}"

[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || {
  echo "REPO is not an owner/name pair: $REPO" >&2
  exit 1
}
owner="${REPO%%/*}"
name="${REPO##*/}"

# The tag carries the version the bundler stamped into the file name.
version="${TAG#v}"
base="$(basename "$appimage")"

# The update information has to match *every future* release, not just this one,
# so the version in the file name becomes a glob. Rewriting it here (rather than
# hard-coding the pattern) keeps the two in step, and the guard below turns a
# future rename of the bundle into a loud failure instead of update information
# that silently matches nothing.
pattern="${base/_${version}_/_*_}"
[[ "$pattern" != "$base" ]] || {
  echo "AppImage name '$base' does not contain _${version}_; cannot derive a zsync pattern" >&2
  exit 1
}

# `latest` makes the installed AppImage track the newest release rather than the
# one it shipped in.
update_information="gh-releases-zsync|${owner}|${name}|latest|${pattern}.zsync"

if [[ "$print_only" == true ]]; then
  printf '%s\n' "$update_information"
  exit 0
fi

[[ -f "$appimage" ]] || {
  echo "No such AppImage: $appimage" >&2
  exit 1
}

# Columns of `objdump -h`: Idx Name Size VMA LMA "File off" Algn. The two hex
# fields are converted in bash, not awk: `strtonum` is a gawk extension and the
# Ubuntu runners' default awk is mawk.
read -r size_hex offset_hex < <(
  objdump -h "$appimage" | awk '$2 == ".upd_info" { print $3, $6; exit }'
)
[[ "${size_hex:-}" =~ ^[0-9a-fA-F]+$ && "${offset_hex:-}" =~ ^[0-9a-fA-F]+$ ]] || {
  echo "No .upd_info section in $appimage; is it an AppImage type-2 runtime?" >&2
  exit 1
}
size=$((16#$size_hex))
offset=$((16#$offset_hex))
(( size > 0 )) || {
  echo "The .upd_info section in $appimage is empty" >&2
  exit 1
}
# Leave room for the terminating NUL.
(( ${#update_information} < size )) || {
  echo "Update information (${#update_information} bytes) does not fit in the ${size}-byte .upd_info section" >&2
  exit 1
}

# Overwrite the whole section, NUL-padded, rather than only the prefix: the
# reader stops at the first NUL, so any leftover bytes would corrupt the string.
# `dd` (not objcopy) because objcopy would rewrite the ELF and drop the squashfs
# image appended after it.
{
  printf '%s' "$update_information"
  head -c "$((size - ${#update_information}))" /dev/zero
} | dd of="$appimage" bs=1 seek="$offset" count="$size" conv=notrunc status=none

# Read it back so a silent short write cannot ship as a working AppImage.
embedded="$(dd if="$appimage" bs=1 skip="$offset" count="$size" status=none | tr -d '\0')"
[[ "$embedded" == "$update_information" ]] || {
  echo "Verification failed: .upd_info holds '$embedded', expected '$update_information'" >&2
  exit 1
}
echo "Embedded update information: $update_information"

# zsync must be generated from the *patched* image, otherwise its checksums
# describe a file that no longer exists. The URL is absolute so the client never
# has to resolve it against the redirect GitHub serves release assets through.
command -v zsyncmake >/dev/null || {
  echo "zsyncmake not found; install the 'zsync' package" >&2
  exit 1
}
zsyncmake \
  -u "https://github.com/${REPO}/releases/download/${TAG}/${base}" \
  -o "${appimage}.zsync" \
  "$appimage"
echo "Wrote ${appimage}.zsync"
