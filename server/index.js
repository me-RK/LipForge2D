import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Multi-platform writable directory
const UPLOAD_BASE = path.join(os.tmpdir(), 'lipforge-uploads');
if (!fs.existsSync(UPLOAD_BASE)) fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_BASE),
    filename: (req, file, cb) => cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
});

const upload = multer({ storage });

// Health check
app.get('/', (req, res) => res.send('Rhubarb Studio Server is active and ready.'));

// 1. Analysis Endpoint
app.post('/process', upload.fields([{ name: 'audio' }, { name: 'dialog' }]), (req, res) => {
    const audioFile = req.files['audio']?.[0];
    const dialogFile = req.files['dialog']?.[0];
    const config = JSON.parse(req.body.config || '{}');

    if (!audioFile) return res.status(400).json({ error: 'No audio provided.' });

    const isProduction = process.env.NODE_ENV === 'production';

    // When running as extraResource, the server is at resources/server/index.js
    // rhubarb.exe is at resources/bin/rhubarb.exe
    // So we go up one level from __dirname (resources/server) to resources/
    const resourcesPath = isProduction
        ? path.join(__dirname, '..')
        : path.join(__dirname, '..');

    const rhubarbPath = isProduction
        ? path.join(resourcesPath, 'bin', 'rhubarb.exe')
        : path.join(resourcesPath, 'bin', 'rhubarb.exe');

    console.log("Server looking for Rhubarb at:", rhubarbPath);

    const args = ['-f', 'json', '--recognizer', config.recognizer || 'pocketSphinx', audioFile.path];
    if (dialogFile) args.push('--dialog', dialogFile.path);

    const rhubarb = spawn(rhubarbPath, args);
    let output = '';

    rhubarb.stderr.on('data', (d) => {
        const m = d.toString().match(/(\d+)%/);
        if (m) res.write(JSON.stringify({ type: 'progress', value: parseInt(m[1]) / 100 }) + '\n');
    });

    rhubarb.stdout.on('data', (d) => output += d.toString());
    rhubarb.on('close', (code) => {
        if (code === 0) res.write(JSON.stringify({ type: 'success', result: output }) + '\n');
        else res.write(JSON.stringify({ type: 'failure', reason: `Rhubarb failed (code ${code})` }) + '\n');
        res.end();
        try { fs.unlinkSync(audioFile.path); if (dialogFile) fs.unlinkSync(dialogFile.path); } catch (e) { }
    });
    req.on('close', () => rhubarb.kill());
});

// 2. High-Performance Render Endpoint
app.post('/render', upload.fields([
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
            if (!res.headersSent) res.status(500).send('FFmpeg Render Failed');
            cleanup();
        }
    });
    req.on('close', () => { ffmpeg.kill(); cleanup(); });
});

app.listen(port, () => console.log(`Studio Server running at http://localhost:${port}`))
    .on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use. Please close other instances.`);
            process.exit(1);
        } else {
            console.error('Server failed to start:', err);
            process.exit(1);
        }
    });
