FROM node:24-bookworm

# Locale setup
RUN apt-get update && apt-get install -y --no-install-recommends locales && \
    sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && \
    locale-gen
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8

# System tools + Python + GDAL/GIS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Dev tools
    fzf jq less vim nano procps tree zsh curl wget ca-certificates \
    # Python (for build scripts)
    python3 python3-pip python3-venv pipx \
    # GIS native deps (for rasterio, fiona, shapely)
    gdal-bin libgdal-dev python3-gdal \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install just (task runner)
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin

# Install Claude Code
RUN DISABLE_AUTOUPDATER=1 curl -fsSL https://claude.ai/install.sh | bash -s latest || \
    echo "Claude Code install failed - install manually"
ENV PATH="/root/.local/bin:${PATH}"

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Install git-delta for better diffs
ARG GIT_DELTA_VERSION=0.19.2
RUN ARCH=$(dpkg --print-architecture) && \
    wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

RUN git config --global --add safe.directory /workspace

# Shell setup
ENV SHELL=/bin/zsh EDITOR=nano VISUAL=nano DEVCONTAINER=true

# Persist shell history
RUN mkdir /commandhistory && touch /commandhistory/.zsh_history && chown -R root:root /commandhistory

# Install zsh plugins + starship + zoxide
RUN git clone https://github.com/zsh-users/zsh-autosuggestions /root/.zsh/zsh-autosuggestions && \
    git clone https://github.com/zsh-users/zsh-syntax-highlighting /root/.zsh/zsh-syntax-highlighting && \
    git clone https://github.com/zsh-users/zsh-completions /root/.zsh/zsh-completions && \
    curl -sS https://starship.rs/install.sh | sh -s -- -y && \
    curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh

RUN cat <<'ZSHRC' > /root/.zshrc
HISTFILE=/commandhistory/.zsh_history
HISTSIZE=1000000
SAVEHIST=1000000
setopt EXTENDED_HISTORY HIST_IGNORE_ALL_DUPS HIST_REDUCE_BLANKS SHARE_HISTORY INC_APPEND_HISTORY
setopt AUTO_CD CORRECT INTERACTIVE_COMMENTS NO_BEEP

fpath=(~/.zsh/zsh-completions/src $fpath)
autoload -Uz compinit && compinit
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'

source ~/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh
source ~/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

bindkey '^[[A' history-search-backward
bindkey '^[[B' history-search-forward

eval "$(starship init zsh)"
eval "$(zoxide init zsh)"

alias ls='ls --color=auto'
alias ll='ls -lah'
alias gs='git status'
alias gd='git diff'
alias gl='git log --oneline -20'
ZSHRC

WORKDIR /workspace
