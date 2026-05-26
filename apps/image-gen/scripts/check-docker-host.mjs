const dockerHost = process.env.DOCKER_HOST;

console.log(`process.env.DOCKER_HOST = ${dockerHost ?? "(unset)"}`);

if (!dockerHost) {
  console.log("DOCKER_HOST is not set. Docker will use the default context.");
  process.exit(0);
}

const normalized = dockerHost.trim().toLowerCase();
const isNpipe = normalized.startsWith("npipe:");

if (isNpipe) {
  console.warn("");
  console.warn("Warning: DOCKER_HOST is set to a Windows named pipe value.");
  console.warn(`Current value: ${dockerHost}`);
  console.warn(
    "flyctl can fail to parse malformed npipe URLs like npipe:////./pipe/docker_engine.",
  );
  console.warn("Unset DOCKER_HOST before running fly deploy so Docker Desktop can use its default context.");
  console.warn("");
  console.warn("Windows CMD:");
  console.warn("set DOCKER_HOST=");
  console.warn("fly deploy --depot=false -a leaderbot-fb-image-gen");
  process.exitCode = 1;
} else {
  console.log("DOCKER_HOST is set, but it is not an npipe value.");
}
