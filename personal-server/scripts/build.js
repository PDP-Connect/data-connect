// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Build script for personal-server
 *
 * 1. Uses esbuild to bundle all dependencies into a single CJS file
 * 2. Uses @yao-pkg/pkg to create a standalone binary with Node.js
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, lstatSync, readlinkSync, cpSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname, posix, resolve, relative, win32 } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { platform, arch } from 'os';
import { createRequire } from 'module';
import { isMainModule } from '../../scripts/is-main-module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const PLATFORM = platform();
const ARCH = arch();

function log(msg) {
  console.log(`[build] ${msg}`);
}

function exec(cmd, opts = {}) {
  log(`Running: ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function getPkgTarget() {
  const nodeVersion = 'node22';
  if (PLATFORM === 'darwin') {
    return ARCH === 'arm64'
      ? `${nodeVersion}-macos-arm64`
      : `${nodeVersion}-macos-x64`;
  } else if (PLATFORM === 'win32') {
    return `${nodeVersion}-win-x64`;
  }
  return `${nodeVersion}-linux-x64`;
}

function getOutputName() {
  const base = 'personal-server';
  return PLATFORM === 'win32' ? `${base}.exe` : base;
}

/**
 * Replace symlinks in node_modules with actual copies.
 * Required so esbuild and pkg can resolve file: dependencies.
 * Note: With npm packages from registry, symlinks are less common,
 * but we keep this for any linked local development.
 */
function dereferenceSymlinks() {
  const nodeModules = join(ROOT, 'node_modules');

  // Check scoped entries (e.g. @opendatalabs/*)
  const scopes = ['@opendatalabs'];
  for (const scope of scopes) {
    const scopeDir = join(nodeModules, scope);
    if (!existsSync(scopeDir)) continue;

    for (const entry of readdirSync(scopeDir)) {
      const entryPath = join(scopeDir, entry);
      if (existsSync(entryPath) && lstatSync(entryPath).isSymbolicLink()) {
        const realPath = resolve(dirname(entryPath), readlinkSync(entryPath));
        log(`Dereferencing symlink: ${entry} -> ${realPath}`);
        rmSync(entryPath, { recursive: true });
        cpSync(realPath, entryPath, { recursive: true });
      }
    }
  }
}

function collectJsFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

function toImportPath(fromFile, toFile) {
  const rel = relative(dirname(fromFile), toFile).replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

// Walk `node_modules` upward from the importing file, the way Node resolves a
// bare specifier, and answer with the first copy of the package that is
// actually visible to it.
//
// A fixed `DIST/node_modules` lookup was right only while one copy of each
// package existed. It stopped being right when personal-server-ts-mcp pinned
// `personal-server-ts-core` at exactly 0.2.0 while personal-server-ts-server
// requires 1.16.1: npm nests the 0.2.0 copy under ts-mcp, and the two versions
// do not export the same subpaths. `./gateway` exists in 0.2.0 and was removed
// in 1.x, so ts-mcp's own `import ... from "@opendatalabs/personal-server-ts-core/gateway"`
// was being answered from the top-level 1.16.1 package.json, which has no such
// entry, and the build stopped on a subpath that is present on disk in the copy
// that importer resolves.
function packageRootFor(packageName, fromFile) {
  const segments = packageName.split('/');
  let directory = dirname(fromFile);
  for (;;) {
    const candidate = join(directory, 'node_modules', ...segments);
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function resolveWorkspaceSpecifier(specifier, fromFile, packageJsonCache) {
  const workspacePackages = [
    '@opendatalabs/personal-server-ts-core',
    '@opendatalabs/personal-server-ts-mcp',
  ];
  const packageName = workspacePackages.find(
    candidate => specifier === candidate || specifier.startsWith(`${candidate}/`)
  );
  if (!packageName) return null;

  const packageRoot =
    packageRootFor(packageName, fromFile) ?? join(DIST, 'node_modules', ...packageName.split('/'));
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson =
    packageJsonCache.get(packageJsonPath) ??
    JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageJsonCache.set(packageJsonPath, packageJson);

  const exportKey =
    specifier === packageName ? '.' : `./${specifier.slice(packageName.length + 1)}`;
  const exportEntry = packageJson.exports?.[exportKey];
  const importTarget =
    typeof exportEntry === 'string'
      ? exportEntry
      : exportEntry?.import ?? exportEntry?.default ?? null;

  if (!importTarget) {
    throw new Error(`Missing export mapping for ${specifier} in ${packageJsonPath}`);
  }

  return join(packageRoot, importTarget);
}

// Every copy of a package under a `node_modules` tree, top level and nested.
// npm nests a second copy whenever two dependents pin incompatible ranges, and
// a step that treats the top-level copy as the only one silently leaves the
// nested one as it found it.
function findPackageCopies(nodeModulesRoot, packageName) {
  const copies = [];
  if (!existsSync(nodeModulesRoot)) return copies;

  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    if (entry.name === packageName) {
      copies.push(join(nodeModulesRoot, entry.name));
      continue;
    }

    // Scopes hold packages rather than being one, so descend a level.
    const children = entry.name.startsWith('@')
      ? readdirSync(join(nodeModulesRoot, entry.name), { withFileTypes: true })
          .filter(child => child.isDirectory())
          .map(child => join(nodeModulesRoot, entry.name, child.name))
      : [join(nodeModulesRoot, entry.name)];

    for (const child of children) {
      copies.push(...findPackageCopies(join(child, 'node_modules'), packageName));
    }
  }

  return copies;
}

/** Every `.node` addon under a directory, at any depth. */
function collectNativeAddons(dir, found = []) {
  if (!existsSync(dir)) return found;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) collectNativeAddons(entryPath, found);
    else if (entry.isFile() && entry.name.endsWith('.node')) found.push(entryPath);
  }

  return found;
}

/**
 * The C library an ELF file needs, or `null` for anything that is not a native
 * ELF for this machine.
 *
 * Read straight from the `DT_NEEDED` entries rather than inferred from the
 * filename: packages disagree about naming (`linuxmusl-x64.node` for
 * better-sqlite3, `secp256k1.musl.node` for secp256k1), and a name is a claim
 * while the dynamic section is the fact linuxdeploy will act on.
 */
function neededLibc(addonPath) {
  // `-d` needs a parsable ELF; anything else (Mach-O, PE) exits non-zero and is
  // not our problem -- see below.
  const result = spawnSync('readelf', ['-d', addonPath], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return null;

  const needed = [...result.stdout.matchAll(/Shared library: \[([^\]]+)\]/g)].map(m => m[1]);
  return needed.find(lib => lib.startsWith('libc.')) ?? null;
}

/**
 * Delete bundled addons that this Linux build's own C library cannot satisfy.
 *
 * Packages that ship prebuilt binaries ship one per platform they support, and
 * exactly one of them is ever loadable here. The rest are usually just weight.
 * On Linux they are not: linuxdeploy walks the AppDir, identifies ELF files by
 * magic bytes, and resolves every `DT_NEEDED` entry it finds.
 *
 * Mach-O and PE addons it cannot parse, so it skips them, and a foreign-arch
 * ELF it warns about and ships. A *musl* addon is neither -- it is a native
 * x86_64 ELF, so it is parsed like any other, and it needs
 * `libc.musl-x86_64.so.1`, which does not exist on a glibc runner. linuxdeploy
 * cannot resolve it and exits non-zero. Tauri discards the tool's output and
 * reports only `failed to run linuxdeploy`, which is the whole of the
 * diagnostic for the ubuntu-22.04 bundling failure.
 *
 * Two packages in this bundle ship one: better-sqlite3
 * (`prebuilds/linuxmusl-x64.node`) and secp256k1
 * (`prebuilds/linux-x64/secp256k1.musl.node`). Matching on the libc rather than
 * on either package's naming scheme is what makes this cover both, and the next
 * one.
 *
 * This removes no capability. Both Linux bundle targets, `appimage` and `deb`,
 * are glibc formats, so a musl addon could never have been the one loaded from
 * either; the matching glibc build sits beside each one and is untouched.
 */
function pruneUnsatisfiableAddons() {
  if (PLATFORM !== 'linux') return;

  // What this machine -- and so the bundle it is producing -- actually links.
  const hostLibc = neededLibc(process.execPath) ?? 'libc.so.6';

  const removed = [];
  for (const addon of collectNativeAddons(join(DIST, 'node_modules'))) {
    const libc = neededLibc(addon);
    // `null` is a non-ELF or foreign-arch addon, which linuxdeploy handles on
    // its own. Only a native ELF wanting a different libc is the failure.
    if (libc === null || libc === hostLibc) continue;

    rmSync(addon, { force: true });
    removed.push(`${relative(DIST, addon)} (needs ${libc})`);
  }

  if (removed.length === 0) {
    log('No bundled addon requires a foreign C library.');
    return;
  }

  for (const entry of removed) log(`Removed unloadable addon ${entry}.`);
  log(`Pruned ${removed.length} addon(s) this ${hostLibc} build cannot load.`);
}

function resolveCopiedImportSpecifier(specifier, fromFile, packageJsonCache) {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return null;
  }

  if (
    specifier === '@opendatalabs/personal-server-ts-core' ||
    specifier.startsWith('@opendatalabs/personal-server-ts-core/') ||
    specifier === '@opendatalabs/personal-server-ts-mcp' ||
    specifier.startsWith('@opendatalabs/personal-server-ts-mcp/')
  ) {
    return resolveWorkspaceSpecifier(specifier, fromFile, packageJsonCache);
  }

  const requireFromFile = createRequire(fromFile);
  try {
    return requireFromFile.resolve(specifier);
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
    // The files being rewritten here are ESM, so a subpath their author
    // published under `import` alone is legitimate and `require.resolve` is
    // simply the wrong resolver for it. That only started to matter when
    // personal-server-ts-core began routing through `@opendatalabs/vana-sdk`,
    // whose `./browser` and `./*` entries carry `types` and `import` and no
    // `require` -- correct for a browser build, which has no CJS artifact to
    // point at. Every dependency before it shipped dual CJS/ESM, so the CJS
    // resolver happened to answer for all of them.
    //
    // The ESM resolver is consulted only on this error, so every specifier
    // that resolves today keeps resolving to the same file it resolves to
    // now. Widening it to the first choice would re-point the other
    // specifiers at their ESM artifacts, which is a larger change than the
    // one this failure calls for.
    return fileURLToPath(import.meta.resolve(specifier, pathToFileURL(fromFile).href));
  }
}

function rewriteCopiedPackageImports() {
  const packageJsonCache = new Map();
  const jsFiles = [
    ...collectJsFiles(
      join(DIST, 'node_modules', '@opendatalabs', 'personal-server-ts-core', 'dist')
    ),
    ...collectJsFiles(
      join(DIST, 'node_modules', '@opendatalabs', 'personal-server-ts-server', 'dist')
    ),
    ...collectJsFiles(
      join(DIST, 'node_modules', '@opendatalabs', 'personal-server-ts-mcp', 'dist')
    ),
  ];

  for (const file of jsFiles) {
    const original = readFileSync(file, 'utf8');
    const rewritten = original
      .split('\n')
      .map(line => {
        const trimmed = line.trimStart();
        if (
          !(trimmed.startsWith('import ') || trimmed.startsWith('export ')) ||
          !trimmed.includes(' from ')
        ) {
          return line;
        }

        return line.replace(/from\s+(["'])([^"'`]+)\1/, (match, quote, specifier) => {
          const target = resolveCopiedImportSpecifier(specifier, file, packageJsonCache);
          if (!target) {
            return match;
          }
          const importPath = toImportPath(file, target);
          return match.replace(specifier, importPath);
        });
      })
      .join('\n');

    if (rewritten !== original) {
      writeFileSync(file, rewritten);
    }
  }
}

export function listProductionDependencyPaths({
  root = ROOT,
  platformName = PLATFORM,
  nodePath = process.execPath,
  npmCliPath = process.env.npm_execpath,
  spawn = spawnSync,
} = {}) {
  const pathApi = platformName === 'win32' ? win32 : posix;
  const command = npmCliPath
    ? nodePath
    : platformName === 'win32'
      ? 'npm.cmd'
      : 'npm';
  const args = [
    ...(npmCliPath ? [npmCliPath] : []),
    'ls',
    '--omit=dev',
    '--all',
    '--parseable',
  ];
  const productionTree = spawn(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: !npmCliPath && platformName === 'win32',
  });
  if (productionTree.error) {
    throw new Error(
      `Failed to list production dependencies: ${productionTree.error.message}`
    );
  }
  if (productionTree.status !== 0) {
    throw new Error(
      `Failed to list production dependencies: ${productionTree.stderr || productionTree.stdout || `exit ${productionTree.status}`}`
    );
  }

  const nodeModulesRoot = pathApi.join(root, 'node_modules');
  return productionTree.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line !== root)
    .filter(line => line.startsWith(nodeModulesRoot));
}

async function build() {
  log('Starting personal-server build...');

  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true });
  }
  mkdirSync(DIST, { recursive: true });

  // Dereference symlinks so esbuild can resolve all imports
  dereferenceSymlinks();

  // Step 1: Bundle with esbuild into a single CJS file
  const bundlePath = join(DIST, 'bundle.cjs');
  log('Bundling with esbuild...');

  // Patch require resolution so native addons load from beside the executable
  // Also provide import.meta.url shim for ESM code bundled to CJS
  // Must redirect better-sqlite3, bindings, and file-uri-to-path to external node_modules
  const nativeModulesList = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
  const runtimeExternalModules = [
    '@opendatalabs/personal-server-ts-server/config',
    '@opendatalabs/personal-server-ts-server',
    '@opendatalabs/personal-server-ts-mcp',
    '@hono/node-server',
    'hono',
  ];
  const nativeBanner = [
    'var _M=require("module"),_P=require("path"),_U=require("url"),_R=_M._resolveFilename;',
    // Shim for import.meta.url
    'if(typeof globalThis.__importMetaUrl==="undefined"){globalThis.__importMetaUrl=_U.pathToFileURL(__filename).href;}',
    // Patch require resolution for native modules.
    // pkg runs the bundle from a snapshot path, so native addons must be
    // resolved from dist/node_modules beside the executable.
    `var _NM=${JSON.stringify(nativeModulesList)};`,
    '_M._resolveFilename=function(r,p,m,o){',
    'if(_NM.includes(r)){var _np=_P.join(_P.dirname(process.execPath),"node_modules");',
    'try{return _R.call(this,r,p,m,Object.assign({},o||{},{paths:[_np]}));}catch(e){}}',
    'return _R.call(this,r,p,m,o);};',
  ].join('');

  // Create shim file for import.meta.url injection
  const shimPath = join(DIST, '_shim.js');
  writeFileSync(shimPath, `
    const { pathToFileURL } = require('url');
    globalThis.__importMetaUrl = pathToFileURL(__filename).href;
  `);

  // Use esbuild JavaScript API for reliable banner injection
  const esbuild = await import('esbuild');

  // Plugin to make native module requires invisible to pkg's static analysis.
  // pkg bundles any require() it finds statically. By using eval('require'),
  // we hide these from pkg so they're loaded from the real filesystem at runtime.
  const dynamicNativeRequirePlugin = {
    name: 'dynamic-native-require',
    setup(build) {
      // For each native module, intercept the require and replace with dynamic require
      for (const mod of nativeModulesList) {
        build.onResolve({ filter: new RegExp(`^${mod}$`) }, args => ({
          path: mod,
          namespace: 'dynamic-native',
        }));
      }
      build.onLoad({ filter: /.*/, namespace: 'dynamic-native' }, args => ({
        // eval('require') hides the require from pkg's static analysis
        contents: `module.exports = eval('require')(${JSON.stringify(args.path)});`,
        loader: 'js',
      }));
    }
  };

  // Plugin to inline require("../package.json") calls from @opendatalabs
  // packages at build time, so the runtime never needs to resolve that path
  // inside the pkg snapshot. Applies to all @opendatalabs packages (not just
  // personal-server-ts-server) to prevent MODULE_NOT_FOUND errors.
  const inlinePackageJsonPlugin = {
    name: 'inline-package-json',
    setup(build) {
      build.onLoad(
        { filter: /node_modules[\\/]@opendatalabs[\\/][^\\/]+[\\/]dist[\\/].*\.js$/ },
        async (args) => {
          const { readFileSync } = await import('fs');
          const { join, dirname } = await import('path');
          let contents = readFileSync(args.path, 'utf8');
          if (contents.includes('require("../package.json")')) {
            const pkgJsonPath = join(dirname(args.path), '..', 'package.json');
            const pkgJson = readFileSync(pkgJsonPath, 'utf8');
            contents = contents.replace(
              /require\("\.\.\/package\.json"\)/g,
              `(${pkgJson.trim()})`
            );
          }
          return { contents, loader: 'js' };
        }
      );
    }
  };

  await esbuild.build({
    entryPoints: [join(ROOT, 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: runtimeExternalModules,
    plugins: [inlinePackageJsonPlugin, dynamicNativeRequirePlugin],
    banner: { js: nativeBanner },
    inject: [shimPath],
    define: {
      'import.meta.url': 'globalThis.__importMetaUrl',
    },
  });

  // Clean up shim file
  rmSync(shimPath, { force: true });

  // Step 2: Package with pkg
  const target = getPkgTarget();
  const outputName = getOutputName();
  const outputPath = join(DIST, outputName);

  log(`Building binary for target: ${target}`);
  exec(`npx pkg "${bundlePath}" -t ${target} -o "${outputPath}" --no-bytecode --public-packages '*' --public --options no-warnings`);

  // Clean up intermediate bundle
  rmSync(bundlePath, { force: true });

  // Copy the full production dependency tree beside the binary.
  // The pkg snapshot cannot host native addons, and the external runtime
  // packages we intentionally leave on disk need their transitive deps too.
  const dependencyPaths = listProductionDependencyPaths();

  for (const src of dependencyPaths) {
    const relative = src.slice(ROOT.length + 1);
    const dest = join(DIST, relative);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
  }

  rewriteCopiedPackageImports();

  // Re-download the better-sqlite3 prebuilt binary for the pkg target Node version.
  // The local npm install compiles for the host Node.js, which may differ from the
  // Node.js version embedded in the pkg binary (e.g. local Node 20 vs pkg Node 22).
  //
  // Every copy is redownloaded, not just the one at the top of `dist`. npm
  // nests a second better-sqlite3 whenever a dependency pins a different major
  // -- personal-server-ts-server 1.16.1 pins 12.11.1 while this package
  // declares 13.x -- and the nested copy is the one its own code loads. Fixing
  // only the top-level copy left that nested addon compiled against the host
  // Node, and the packaged binary died on first database access with
  // `NODE_MODULE_VERSION 137 ... requires 127`. The build still succeeded,
  // because nothing in the build loads the addon.
  const pkgNodeMajor = target.match(/node(\d+)/)?.[1];
  if (pkgNodeMajor) {
    for (const bsqlDist of findPackageCopies(join(DIST, 'node_modules'), 'better-sqlite3')) {
      const where = relative(DIST, bsqlDist);

      // 13.x ships Node-API prebuilds in `prebuilds/<platform>-<arch>.node` and
      // builds no `build/Release` at all. Node-API is ABI-stable across Node
      // versions, so those need no per-ABI download and there is nothing for
      // this step to do -- which is just as well, because 13.x publishes no
      // downloadable linux-x64 prebuild for any ABI.
      //
      // The 12.11.1 copy nested under personal-server-ts-server is the older
      // shape, compiled against the host Node by `npm install`, and does need
      // redownloading for the pkg target's ABI.
      if (existsSync(join(bsqlDist, 'prebuilds'))) {
        log(`better-sqlite3 in ${where} ships Node-API prebuilds; no per-ABI download needed.`);
        continue;
      }

      log(`Downloading better-sqlite3 prebuilt for Node ${pkgNodeMajor} in ${where}...`);
      try {
        exec(`npx prebuild-install -r node -t ${pkgNodeMajor}.0.0 --platform ${PLATFORM} --arch ${ARCH}`, { cwd: bsqlDist });
      } catch (e) {
        log(`WARNING: prebuild-install failed, falling back to local build: ${e.message}`);
      }

      // A missing addon is only observable at runtime, on first database
      // access, long after this build reports success. Checking here keeps the
      // failure attached to the step that caused it.
      if (!existsSync(join(bsqlDist, 'build', 'Release', 'better_sqlite3.node'))) {
        throw new Error(
          `better-sqlite3 in ${where} has no build/Release/better_sqlite3.node after preparing it for Node ${pkgNodeMajor}.`
        );
      }
    }
  }

  // Last, so it sees the tree exactly as it will be bundled -- including the
  // addons the step above just downloaded.
  pruneUnsatisfiableAddons();

  log('Build complete!');
  log(`Output: ${DIST}`);

  const files = readdirSync(DIST);
  log('Contents:');
  for (const file of files) {
    const stat = statSync(join(DIST, file));
    const size = stat.isDirectory()
      ? 'dir'
      : `${(stat.size / 1024 / 1024).toFixed(1)}MB`;
    log(`  ${file} (${size})`);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  build().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}
