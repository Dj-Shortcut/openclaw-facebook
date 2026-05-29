@echo off
setlocal
set "DOCKER_HOST="
echo DOCKER_HOST cleared for this shell.
echo.
echo Active Docker context:
docker context show
echo.
echo Docker version:
docker version
