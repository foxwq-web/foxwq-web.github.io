ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:noble
FROM ${PLAYWRIGHT_IMAGE}
ARG NODE_VERSION
ARG NPM_VERSION
RUN curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt \
       | grep " node-v${NODE_VERSION}-linux-x64.tar.gz$" | sha256sum --check \
    && tar -xzf node-v${NODE_VERSION}-linux-x64.tar.gz -C /usr/local --strip-components=1 \
    && rm node-v${NODE_VERSION}-linux-x64.tar.gz \
    && npm install --global npm@${NPM_VERSION} --no-audit --no-fund --no-update-notifier
