#!/bin/bash
set -euo pipefail
if command -v docker >/dev/null 2>&1; then
  echo "Docker уже установлен: $(docker --version)"
  exit 0
fi
sudo apt-get update -qq
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:-${UBUNTU_CODENAME:-jammy}} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker ubuntu 2>/dev/null || true
docker --version
docker compose version
echo "Готово. Выйдите из shell и зайдите снова (или newgrp docker), чтобы группа docker подхватилась."
