export function buildRemoteNodeCommand(source) {
  const payload = Buffer.from(String(source), "utf8").toString("base64");
  const loader =
    'require("node:vm").runInThisContext(Buffer.from(process.argv[1],"base64").toString("utf8"))';
  return `node -e '${loader}' ${payload}`;
}
