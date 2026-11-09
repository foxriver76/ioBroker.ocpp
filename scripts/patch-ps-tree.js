const fs = require('node:fs');
const path = require('node:path');

// 1. Read root package.json for dynamic adapter info
const rootPkgFile = path.join(__dirname, '..', 'package.json');
let adapterFullName = '';
let adapterShortName = '';
let currentVersion = '';

if (fs.existsSync(rootPkgFile)) {
    try {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgFile, 'utf8'));
        adapterFullName = rootPkg.name || '';
        adapterShortName = adapterFullName.replace(/^iobroker\./, '');
        currentVersion = rootPkg.version || '';
    } catch (err) {
        console.warn('[patch-ps-tree] Could not read root package.json:', err.message);
    }
}

// 2. Synchronize adapter tarball version in all .dev-server profiles
const devServerDir = path.join(__dirname, '..', '.dev-server');
if (adapterFullName && currentVersion && fs.existsSync(devServerDir)) {
    try {
        const expectedTarball = `file:../../${adapterFullName}-${currentVersion}.tgz`;
        const profiles = fs.readdirSync(devServerDir, { withFileTypes: true });

        for (const profile of profiles) {
            if (profile.isDirectory()) {
                const profilePkgFile = path.join(devServerDir, profile.name, 'package.json');
                if (fs.existsSync(profilePkgFile)) {
                    const profilePkg = JSON.parse(fs.readFileSync(profilePkgFile, 'utf8'));
                    if (profilePkg.dependencies?.[adapterFullName]) {
                        const currentDep = profilePkg.dependencies[adapterFullName];
                        if (currentDep !== expectedTarball) {
                            profilePkg.dependencies[adapterFullName] = expectedTarball;
                            fs.writeFileSync(profilePkgFile, JSON.stringify(profilePkg, null, 2), 'utf8');
                            console.log(
                                `[patch-ps-tree] Synced ${profile.name}/package.json dependency to ${adapterFullName}@${currentVersion}.`
                            );
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[patch-ps-tree] Error syncing dev-server profiles:', err.message);
    }
}

// 3. Patch ps-tree for Windows 11 compatibility (replace wmic.exe with PowerShell CIM)
const psTreeFile = path.join(__dirname, '..', 'node_modules', 'ps-tree', 'index.js');

if (fs.existsSync(psTreeFile)) {
    let content = fs.readFileSync(psTreeFile, 'utf8');
    if (content.includes("spawn('wmic.exe'")) {
        const target =
            "    processLister = spawn('wmic.exe', ['PROCESS', 'GET', 'Name,ProcessId,ParentProcessId,Status']);\n  } else {\n    processLister = spawn('ps', ['-A', '-o', 'ppid,pid,stat,comm']);\n  }";
        const replacement =
            "    var psScript = \"$ProgressPreference = 'SilentlyContinue'; Write-Output 'Name  ParentProcessId  ProcessId  Status'; Get-CimInstance Win32_Process | ForEach-Object { Write-Output (\\\"{0}  {1}  {2}  OK\\\" -f ($_.Name -replace ' ','_'), $_.ParentProcessId, $_.ProcessId) }\";\n    var b64 = Buffer.from(psScript, 'utf16le').toString('base64');\n    processLister = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', b64]);\n  } else {\n    processLister = spawn('ps', ['-A', '-o', 'ppid,pid,stat,comm']);\n  }\n  processLister.on('error', callback);";

        if (content.includes(target)) {
            content = content.replace(target, replacement);
            fs.writeFileSync(psTreeFile, content, 'utf8');
            console.log('[patch-ps-tree] Successfully patched ps-tree for Windows 11 compatibility.');
        }
    }
}

// 4. Patch @iobroker/dev-server proxy and update logic
const devServerIndex = path.join(__dirname, '..', 'node_modules', '@iobroker', 'dev-server', 'dist', 'index.js');
if (fs.existsSync(devServerIndex)) {
    let content = fs.readFileSync(devServerIndex, 'utf8');

    // Resilience patch for admin proxy startup delay
    const crashTarget =
        "app.get('/', async (_req, res) => {\n                const { data } = await axios_1.default.get(adminUrl);\n                res.send((0, jsonConfig_1.injectCode)(data, this.adapterName, path.basename(jsonConfigFile)));\n            });";
    const resilientReplacement = `app.get('/', async (_req, res) => {
                let retries = 15;
                while (retries > 0) {
                    try {
                        const { data } = await axios_1.default.get(adminUrl);
                        return res.send((0, jsonConfig_1.injectCode)(data, this.adapterName, path.basename(jsonConfigFile)));
                    } catch (err) {
                        retries--;
                        if (retries === 0) {
                            return res.status(502).send('Admin is starting up. Please reload this page in a moment.');
                        }
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            });`;

    if (content.includes(crashTarget)) {
        content = content.replace(crashTarget, resilientReplacement);
        fs.writeFileSync(devServerIndex, content, 'utf8');
        console.log('[patch-ps-tree] Successfully patched dev-server proxy for connection resilience.');
    }

    // Update-order patch: install local adapter before npm update to keep package.json in sync
    const updateTarget =
        "        if (!((_a = this.config) === null || _a === void 0 ? void 0 : _a.useSymlinks)) {\n            this.log.notice('Building local adapter.');\n            await this.buildLocalAdapter();\n            await this.installLocalAdapter(false); //do not install, keep .tgz file.\n        }\n        this.execSync('npm update --loglevel error', this.profileDir);\n        this.uploadAdapter('admin');\n        await this.installLocalAdapter();";
    const updateReplacement =
        "        if (!((_a = this.config) === null || _a === void 0 ? void 0 : _a.useSymlinks)) {\n            this.log.notice('Building local adapter.');\n            await this.buildLocalAdapter();\n            await this.installLocalAdapter(true);\n        }\n        this.execSync('npm update --loglevel error', this.profileDir);\n        this.uploadAdapter('admin');";

    if (content.includes(updateTarget)) {
        content = content.replace(updateTarget, updateReplacement);
        fs.writeFileSync(devServerIndex, content, 'utf8');
        console.log('[patch-ps-tree] Successfully patched dev-server update logic for version synchronization.');
    }
}

// 5. Clean up stale jsonl lock directories from previous crashes
const dataDir = path.join(__dirname, '..', '.dev-server', 'default', 'iobroker-data');
if (fs.existsSync(dataDir)) {
    try {
        const entries = fs.readdirSync(dataDir);
        for (const entry of entries) {
            if (entry.endsWith('.lock')) {
                const lockPath = path.join(dataDir, entry);
                try {
                    fs.rmSync(lockPath, { recursive: true, force: true });
                    console.log(`[patch-ps-tree] Cleaned up stale lock: ${entry}`);
                } catch {
                    // Ignore if locked by active process
                }
            }
        }
    } catch {
        // Ignore readdir error
    }
}

// 6. Patch js-controller in .dev-server so it never spawns a duplicate instance of the adapter
if (adapterShortName) {
    const controllerFiles = [
        path.join(
            __dirname,
            '..',
            '.dev-server',
            'default',
            'node_modules',
            'iobroker.js-controller',
            'build',
            'esm',
            'main.js'
        ),
        path.join(
            __dirname,
            '..',
            '.dev-server',
            'default',
            'node_modules',
            'iobroker.js-controller',
            'build',
            'cjs',
            'main.js'
        )
    ];

    for (const ctrlFile of controllerFiles) {
        if (fs.existsSync(ctrlFile)) {
            let ctrlContent = fs.readFileSync(ctrlFile, 'utf8');
            const targetEsm =
                'async function startInstance(id, wakeUp = false) {\n    if (isStopping || !connected || !objects) {\n        return;\n    }';
            const replacementEsm = `async function startInstance(id, wakeUp = false) {\n    if (isStopping || !connected || !objects) {\n        return;\n    }\n    if (id === 'system.adapter.${adapterShortName}.0' || id === '${adapterShortName}.0') {\n        return;\n    }`;
            const targetCjs =
                'async function startInstance(id, wakeUp = false) {\n  if (isStopping || !connected || !objects) {\n    return;\n  }';
            const replacementCjs = `async function startInstance(id, wakeUp = false) {\n  if (isStopping || !connected || !objects) {\n    return;\n  }\n  if (id === 'system.adapter.${adapterShortName}.0' || id === '${adapterShortName}.0') {\n    return;\n  }`;

            let modified = false;
            if (ctrlContent.includes(targetEsm)) {
                ctrlContent = ctrlContent.replace(targetEsm, replacementEsm);
                modified = true;
            }
            if (ctrlContent.includes(targetCjs)) {
                ctrlContent = ctrlContent.replace(targetCjs, replacementCjs);
                modified = true;
            }
            if (modified) {
                fs.writeFileSync(ctrlFile, ctrlContent, 'utf8');
                console.log(
                    `[patch-ps-tree] Successfully patched js-controller (${path.basename(path.dirname(ctrlFile))}) to prevent instance collision for ${adapterShortName}.`
                );
            }
        }
    }
}

