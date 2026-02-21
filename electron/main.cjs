const { app, BrowserWindow, shell, Menu, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');

const isDev = !app.isPackaged;
const isProduction = app.isPackaged;

let mainWindow;
let serverInstance;

// --- INTEGRATED BACKEND LOGIC ---
function startIntegratedServer() {
    const serverApp = express();
    const port = 3001;

    serverApp.use(cors());
    serverApp.use(express.json());

    // Multi-platform writable directory
    const UPLOAD_BASE = path.join(os.tmpdir(), 'lipforge-uploads');
    if (!fs.existsSync(UPLOAD_BASE)) fs.mkdirSync(UPLOAD_BASE, { recursive: true });

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_BASE),
        filename: (req, file, cb) => cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
    });

    const upload = multer({ storage });

    serverApp.get('/', (req, res) => res.send('LipForge Local Engine Active'));

    // 1. Analysis Endpoint
    serverApp.post('/process', upload.fields([{ name: 'audio' }, { name: 'dialog' }]), async (req, res) => {
        const audioFile = req.files['audio']?.[0];
        const dialogFile = req.files['dialog']?.[0];
        const config = JSON.parse(req.body.config || '{}');

        if (!audioFile) return res.status(400).json({ error: 'No audio provided.' });

        const standardizedPath = audioFile.path + '_std.wav';
        const syncRecognizer = config.recognizer || 'pocketSphinx';

        // Resource path diagnostics
        let rhubarbPath, resPath;
        if (isProduction) {
            rhubarbPath = path.join(process.resourcesPath, 'bin', 'rhubarb.exe');
            resPath = path.join(process.resourcesPath, 'bin', 'res');
        } else {
            rhubarbPath = path.join(__dirname, '..', 'bin', 'rhubarb.exe');
            resPath = path.join(__dirname, '..', 'bin', 'res');
        }

        console.log(`[ENGINE] Path: ${rhubarbPath} | Mode: ${syncRecognizer}`);

        const runRhubarb = (targetPath, isFallback = false) => {
            return new Promise((resolve) => {
                // EXCEPTIONALLY IMPORTANT: Rhubarb must be run from its own directory to find /res folder
                const binDir = path.dirname(rhubarbPath);

                const args = [
                    '-f', 'json',
                    '--recognizer', syncRecognizer,
                    '--logLevel', 'Info',
                    targetPath
                ];
                if (dialogFile) args.push('--dialog', dialogFile.path);

                console.log(`[ENGINE] Exec in ${binDir}: ${rhubarbPath} ${args.join(' ')}`);

                const rhubarb = spawn(rhubarbPath, args, { cwd: binDir });
                let output = '';
                let errorOutput = '';
                let lastReportedProgress = -1;
                let watchdogTimer;

                const resetWatchdog = () => {
                    if (watchdogTimer) clearTimeout(watchdogTimer);
                    watchdogTimer = setTimeout(() => {
                        console.error("[WATCHDOG] Process Hanged.");
                        if (rhubarb && !rhubarb.killed) rhubarb.kill('SIGKILL');
                    }, 120000); // 2 mins
                };
                resetWatchdog();

                rhubarb.stderr.on('data', (d) => {
                    resetWatchdog();
                    const str = d.toString();
                    errorOutput += str;

                    // Progressive progress reporting
                    const matches = str.matchAll(/(\d+)%/g);
                    for (const match of matches) {
                        const p = parseInt(match[1]);
                        if (p > lastReportedProgress) {
                            lastReportedProgress = p;
                            const totalProgress = isFallback ? 0.5 + (p / 200) : (p / 200);
                            if (!res.writableEnded) res.write(JSON.stringify({ type: 'progress', value: totalProgress }) + '\n');
                        }
                    }
                });

                rhubarb.stdout.on('data', (d) => { resetWatchdog(); output += d.toString(); });
                rhubarb.on('error', (err) => { clearTimeout(watchdogTimer); resolve({ success: false, reason: `Binary Spawn failed: ${err.message}` }); });
                rhubarb.on('close', (code) => {
                    clearTimeout(watchdogTimer);
                    if (code === 0) resolve({ success: true, result: output });
                    else {
                        // Extract the most relevant error line
                        const cleanError = errorOutput.split('\n')
                            .filter(l => l.includes('Error') || l.includes('Fatal'))
                            .pop() || errorOutput.split('\n').pop();
                        resolve({ success: false, reason: cleanError || `Exit Code ${code}` });
                    }
                });
                req.on('close', () => { clearTimeout(watchdogTimer); if (rhubarb && !rhubarb.killed) rhubarb.kill('SIGKILL'); });
            });
        };

        const cleanup = () => {
            try {
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                if (fs.existsSync(standardizedPath)) fs.unlinkSync(standardizedPath);
                if (dialogFile && fs.existsSync(dialogFile.path)) fs.unlinkSync(dialogFile.path);
            } catch (e) { }
        };

        // Standardize Audio
        const ffmpeg = spawn('ffmpeg', [
            '-y', '-i', audioFile.path,
            '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav',
            standardizedPath
        ]);

        ffmpeg.on('error', async () => {
            const result = await runRhubarb(audioFile.path);
            if (result.success) res.write(JSON.stringify({ type: 'success', result: result.result }) + '\n');
            else {
                let msg = result.reason;
                if (!fs.existsSync(resPath)) msg = `MISSING ENGINE ASSETS: The 'res' folder is missing in the bin directory. Rhubarb cannot run without its acoustic models.`;
                res.write(JSON.stringify({ type: 'failure', reason: msg }) + '\n');
            }
            res.end(); cleanup();
        });

        ffmpeg.on('close', async (code) => {
            let result;
            if (code === 0) {
                if (!res.writableEnded) res.write(JSON.stringify({ type: 'progress', value: 0 }) + '\n');
                result = await runRhubarb(standardizedPath);
                if (!result.success) {
                    console.warn("[ENGINE] Standardized failed, retrying raw...");
                    result = await runRhubarb(audioFile.path, true);
                }
            } else {
                result = await runRhubarb(audioFile.path);
            }

            if (result.success) {
                res.write(JSON.stringify({ type: 'success', result: result.result }) + '\n');
            } else {
                let msg = result.reason;
                if (!fs.existsSync(resPath)) msg = `RESOURCE ERROR: The 'res' folder is missing in the application bin directory. Please ensure all folder contents are extracted.`;
                res.write(JSON.stringify({ type: 'failure', reason: msg }) + '\n');
            }
            res.end(); cleanup();
        });
    });

    // 2. High-Performance Render Endpoint
    serverApp.post('/render', upload.fields([
        { name: 'audio' },
        { name: 'frame_A' }, { name: 'frame_B' }, { name: 'frame_C' },
        { name: 'frame_D' }, { name: 'frame_E' }, { name: 'frame_F' },
        { name: 'frame_G' }, { name: 'frame_H' }, { name: 'frame_X' }
    ]), (req, res) => {
        const audioFile = req.file || req.files['audio']?.[0];
        const cues = JSON.parse(req.body.cues || '[]');
        const config = JSON.parse(req.body.config || '{}');

        if (!audioFile) return res.status(400).send('Audio asset missing');

        const sessionId = Date.now();
        const sessionDir = path.join(UPLOAD_BASE, `render-${sessionId}`);
        fs.mkdirSync(sessionDir);

        const scriptPath = path.join(sessionDir, 'script.txt');
        const outputPath = path.join(sessionDir, 'output.mp4');

        const frameMap = {};
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'].forEach(s => {
            const file = req.files[`frame_${s}`]?.[0];
            if (file) frameMap[s] = file.path.replace(/\\/g, '/');
        });

        let script = '';
        for (let i = 0; i < cues.length; i++) {
            const path = frameMap[cues[i].value] || frameMap['X'];
            const dur = Math.max(0.01, (cues[i + 1]?.start || cues[i].start + 0.5) - cues[i].start);
            script += `file '${path}'\nduration ${dur}\n`;
        }
        if (cues.length > 0) script += `file '${frameMap[cues[cues.length - 1].value] || frameMap['X']}'\n`;
        fs.writeFileSync(scriptPath, script);

        const ffmpegArgs = [
            '-y',
            '-f', 'lavfi', '-i', `color=c=${config.videoBgColor.replace('#', '0x')}:s=${config.videoRes}x${config.videoRes}:d=${cues[cues.length - 1].start + 1.5}`,
            '-f', 'concat', '-safe', '0', '-i', scriptPath,
            '-i', audioFile.path,
            '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2:shortest=1[v]',
            '-map', '[v]', '-map', '2:a',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', config.videoQuality === 'high' ? '18' : '23',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest',
            outputPath
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        const cleanup = () => {
            try {
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
                Object.values(frameMap).forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
            } catch (e) { }
        };

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                res.download(outputPath, `LipForge2D_Output_${Date.now()}.mp4`, (err) => {
                    cleanup();
                });
            } else {
                if (!res.headersSent) res.status(500).send('Render Failed');
                cleanup();
            }
        });
        req.on('close', () => { ffmpeg.kill(); cleanup(); });
    });

    serverInstance = serverApp.listen(port, () => console.log(`Integrated Engine ready on port ${port}`));
}

// --- APP LOGIC ---

ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 1000,
        minHeight: 700,
        title: "LipForge 2D",
        backgroundColor: "#0f172a",
        icon: path.join(__dirname, "../public/icon.ico"),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "preload.cjs"),
        },
    });

    if (isDev) {
        mainWindow.loadURL("http://localhost:5173");
    } else {
        mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
    }

    if (!isDev) {
        mainWindow.webContents.on("devtools-opened", () => {
            mainWindow.webContents.closeDevTools();
        });
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

function setupMenu() {
    const template = [
        { label: 'File', submenu: [{ role: 'quit' }] },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
        {
            label: 'Support',
            submenu: [
                { label: 'Patreon', click: () => shell.openExternal('https://www.patreon.com/c/emptyidea') },
                { label: 'Buy Me a Coffee', click: () => shell.openExternal('https://buymeacoffee.com/emptyidea') }
            ]
        }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
    setupMenu();
    startIntegratedServer();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
