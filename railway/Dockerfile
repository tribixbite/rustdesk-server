# Railway image for hbbs / hbbr, built from this repository's source.
#
# One image serves both Railway services (each sets RAILWAY_DOCKERFILE_PATH to
# this file); RUSTDESK_ROLE (hbbs | hbbr) picks the binary at start-up.
# See docs/railway.md for the full deployment guide.
#
# The build context must include the libs/hbb_common submodule checkout
# (`git submodule update --init`), which `railway up` uploads from the working
# tree. Railway's GitHub builder is not used because it does not document
# submodule support.

# Floating stable toolchain, matching the upstream release workflow.
FROM rust:1-bookworm AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# Fail early with a clear message instead of a confusing cargo error.
RUN test -f libs/hbb_common/Cargo.toml || { \
      echo "libs/hbb_common is empty: run 'git submodule update --init' before deploying" >&2; \
      exit 1; }
# sqlx checks queries at compile time against this tracked database
# (DATABASE_URL in .env); .railwayignore re-includes it for `railway up`.
RUN test -f db_v2.sqlite3 || { \
      echo "db_v2.sqlite3 missing from the build context (see .railwayignore)" >&2; \
      exit 1; }

RUN cargo build --release --locked --bin hbbs --bin hbbr --bin rustdesk-utils

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/hbbs /src/target/release/hbbr /src/target/release/rustdesk-utils /usr/bin/
COPY railway/entrypoint.sh /usr/local/bin/rustdesk-entrypoint

WORKDIR /data

# 21118 (hbbs) and 21119 (hbbr) are the WebSocket listeners that Railway's
# HTTPS edge forwards to. The plain TCP ports stay private to the container.
EXPOSE 21118 21119

ENTRYPOINT ["/usr/local/bin/rustdesk-entrypoint"]
