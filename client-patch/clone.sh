#!/data/data/com.termux/files/usr/bin/bash
# Turn any RustDesk Android APK (e.g. a CI build of the tribixbite/rustdesk fork)
# into the side-by-side "RustDesk P2P fix" package, signed with the same local
# key as build.sh, so it installs beside the official app and updates an earlier
# copy in place (its settings are kept).
#
# usage: client-patch/clone.sh <input.apk> [output.apk]
set -euo pipefail
cd "$(dirname "$0")"

IN=$(realpath "$1")
OUT=$(realpath -m "${2:-build/$(basename "${IN%.apk}")-p2pfix.apk}")
APK_EDITOR="${APK_EDITOR_PATH:-$HOME/git/termux-tools/edge-fix/tools/APKEditor.jar}"
SUFFIX="${PACKAGE_SUFFIX:-p2pfix}"
W=build/work-clone

test -f "$APK_EDITOR" || { echo "APKEditor.jar not found: $APK_EDITOR" >&2; exit 1; }
test -f build/local.keystore || { echo "run build.sh once first: it creates the signing key" >&2; exit 1; }
rm -rf "$W"; mkdir -p "$W"

# Drop the old v1 signature files; v2/v3 signatures live outside the entries.
python3 -I - "$IN" "$W/unsigned.apk" <<'EOF'
import sys, zipfile
src, dst = sys.argv[1:]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
    for info in zin.infolist():
        n = info.filename
        if n.startswith("META-INF/") and n.rsplit(".", 1)[-1] in ("SF", "RSA", "EC", "DSA", "MF"):
            continue
        zout.writestr(info, zin.read(n), compress_type=info.compress_type)
EOF
[[ -f build/work/clone-manifest.jar ]] || {
    mkdir -p build/work
    kotlinc CloneManifest.kt -classpath "$APK_EDITOR" -include-runtime -d build/work/clone-manifest.jar 2>/dev/null
}
java -Xmx1024m -cp "build/work/clone-manifest.jar:$APK_EDITOR" CloneManifestKt "$W/unsigned.apk" "$W/clone.apk" "$SUFFIX"
zipalign -p -f 4 "$W/clone.apk" "$W/aligned.apk"
apksigner sign --ks build/local.keystore --ks-pass file:build/key-password --ks-key-alias local \
    --out "$OUT" "$W/aligned.apk"
apksigner verify "$OUT" >/dev/null
zipalign -c -p 4 "$OUT"
sha256sum "$OUT"
