# syntax=docker/dockerfile:1

# Build dependencies (including native modules) in a disposable stage.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# Runtime image: Node, ffmpeg, Xvfb and Mesa for headless Dolphin rendering.
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="MAGI hit review" \
      org.opencontainers.image.description="Headless Slippi hit-review clip renderer" \
      org.opencontainers.image.source="https://github.com/Bloodshed-Rain/TheMAGI"

ENV DEBIAN_FRONTEND=noninteractive \
    LIBGL_ALWAYS_SOFTWARE=1 \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime \
    npm_config_update_notifier=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        ffmpeg \
        xvfb \
        xauth \
        libgl1 \
        libopengl0 \
        libglx-mesa0 \
        libgl1-mesa-dri \
        libegl1 \
        libgles2 \
        libgbm1 \
        libasound2 \
        libpulse0 \
        libdbus-1-3 \
        libx11-6 \
        libxext6 \
        libxrender1 \
        libxi6 \
        libxrandr2 \
        libxfixes3 \
        libxcursor1 \
        libxinerama1 \
        libsm6 \
        libice6 \
        libfontconfig1 \
        libfreetype6 \
        libxkbcommon0 \
        libxkbcommon-x11-0 \
        libfuse2 \
        procps \
        adwaita-icon-theme \
        hicolor-icon-theme \
        librsvg2-common \
        shared-mime-info \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /replays /assets \
    && install -d -m 700 -o node -g node /tmp/xdg-runtime \
    && chown -R node:node /data \
    && printf 'pcm.!default {\n    type null\n}\nctl.!default {\n    type null\n}\n' > /etc/asound.conf

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN chmod +x docker/entrypoint.sh scripts/*.sh

USER node
ENTRYPOINT ["/app/docker/entrypoint.sh"]
