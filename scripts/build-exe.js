const fs = require("fs/promises");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const buildDir = path.join(projectRoot, "build");
const distDir = path.join(projectRoot, "dist");
const nodeBinary = process.execPath;
const nodeDir = path.dirname(nodeBinary);
const seaPrepBlob = path.join(buildDir, "hide-my-screen.blob");
const seaConfigPath = path.join(buildDir, "sea-config.json");
const outputExe = path.join(distDir, "HideMyScreen.exe");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

async function ensureCleanDir(dirPath) {
  await fs.rm(dirPath, { force: true, recursive: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function collectFiles(dirPath, rootPath = dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, rootPath)));
      continue;
    }

    const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");
    files.push({ fullPath, relativePath });
  }

  return files;
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function quoteForShell(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function runWithShell(command, args) {
  const commandLine = [command, ...args].map(quoteForShell).join(" ");

  execSync(commandLine, {
    cwd: projectRoot,
    shell: true,
    stdio: "inherit",
  });
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("This build script currently targets Windows .exe packaging only.");
  }

  const publicDir = path.join(projectRoot, "public");
  const publicFiles = await collectFiles(publicDir);

  const assets = Object.fromEntries(
    publicFiles.map((file) => [`public/${file.relativePath}`, file.fullPath])
  );

  const seaConfig = {
    main: path.join(projectRoot, "server.js"),
    output: seaPrepBlob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };

  await ensureCleanDir(buildDir);
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  console.log("Building SEA blob...");
  run(nodeBinary, ["--experimental-sea-config", seaConfigPath]);

  console.log("Copying Node runtime...");
  await fs.copyFile(nodeBinary, outputExe);

  console.log("Injecting SEA blob with postject...");
  const npxCmd = path.join(nodeDir, "npx.cmd");
  runWithShell(npxCmd, [
    "--yes",
    "postject",
    outputExe,
    "NODE_SEA_BLOB",
    seaPrepBlob,
    "--sentinel-fuse",
    sentinelFuse,
  ]);

  console.log(`Built ${outputExe}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
