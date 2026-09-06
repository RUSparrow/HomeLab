#!/bin/bash

set -e

cd /home/sparrow/HomeLab

git config --global --add safe.directory /home/sparrow/HomeLab

git pull

cd /home/sparrow/HomeLab/server-monitor

docker compose up -d --build --no-deps server-monitor
