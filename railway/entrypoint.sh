#!/bin/sh
# Start hbbs or hbbr inside the Railway image (see docs/railway.md).
#
# Environment:
#   RUSTDESK_ROLE  hbbs | hbbr (required)
#   KEY_PUB        base64 public key from `rustdesk-utils genkeypair` (required)
#   KEY_PRIV       base64 secret key from the same keypair (required)
#   RELAY          hbbs only: public relay address handed to clients, e.g.
#                  hbbr-production.up.railway.app (":21117" is appended when no
#                  port is given, so clients map it to wss://<host>/ws/relay)
#   RUSTDESK_DATA  data directory, default /data (mount a Railway volume here)
#
# Any arguments are passed through to the selected binary.
set -eu

die() {
  echo "rustdesk-entrypoint: $*" >&2
  exit 1
}

role="${RUSTDESK_ROLE:-}"
data="${RUSTDESK_DATA:-/data}"

case "$role" in
  hbbs | hbbr) ;;
  *) die "RUSTDESK_ROLE must be 'hbbs' or 'hbbr' (got '${role}')" ;;
esac

# Railway injects PORT for its HTTP routing. hbbs reads PORT as its base port
# and hbbr listens on PORT+1, which would move every listener away from the
# ports the Railway domains target. Both binaries use their defaults instead.
unset PORT

# Both services must share one keypair: with `-k _` hbbs and hbbr each load
# id_ed25519 from the working directory and reject clients whose key differs.
# Generating a key here would silently give the two services different keys.
[ -n "${KEY_PUB:-}" ] || die "KEY_PUB is not set (generate with: rustdesk-utils genkeypair)"
[ -n "${KEY_PRIV:-}" ] || die "KEY_PRIV is not set (generate with: rustdesk-utils genkeypair)"
/usr/bin/rustdesk-utils validatekeypair "$KEY_PUB" "$KEY_PRIV" >/dev/null \
  || die "KEY_PUB and KEY_PRIV are not a valid keypair"

mkdir -p "$data"
cd "$data"
umask 077
# The variables are the source of truth, so rewrite the files on every start;
# rotating the key is then just a variable change plus a redeploy.
printf '%s' "$KEY_PRIV" > id_ed25519
printf '%s' "$KEY_PUB" > id_ed25519.pub
unset KEY_PRIV

if [ "$role" = "hbbs" ]; then
  relay="${RELAY:-}"
  [ -n "$relay" ] || die "RELAY is not set (public domain of the hbbr service)"
  case "$relay" in
    *:*) ;;
    *) relay="${relay}:21117" ;;
  esac
  echo "rustdesk-entrypoint: starting hbbs, relay ${relay}"
  exec /usr/bin/hbbs -r "$relay" -k _ "$@"
fi

echo "rustdesk-entrypoint: starting hbbr"
exec /usr/bin/hbbr -k _ "$@"
