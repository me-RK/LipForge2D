import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
    Upload, Settings, Play, CheckCircle, FileText, AudioWaveform,
    Download, Loader2, Volume2, Pause, Video, Monitor, Zap,
    RotateCcw, Square, Sparkles, Coffee, Heart, ExternalLink,
    FolderCheck, Folder
} from 'lucide-react'

const PreviewMouth = ({ cues, currentTime, duration, onSeek }) => {
    const [currentShape, setCurrentShape] = useState('X');
    const shapeRef = useRef('X');

    useEffect(() => {
        const currentCue = [...cues].reverse().find(c => currentTime >= (c.start || 0));
        const newShape = currentCue ? currentCue.value : 'X';
        if (newShape !== shapeRef.current) {
            shapeRef.current = newShape;
            setCurrentShape(newShape);
        }
    }, [currentTime, cues]);

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="mouth-visualizer">
                <img
                    src={`mouths/mouth_${currentShape}.png`}
                    alt={`Mouth ${currentShape}`}
                    className="mouth-img"
                    onError={(e) => {
                        if (!e.target.src.endsWith('.svg')) e.target.src = `mouths/mouth_${currentShape}.svg`;
                    }}
                />
                <div style={{ position: 'absolute', bottom: '12px', right: '16px', fontWeight: '700', fontSize: '0.8rem', color: '#fff', opacity: 0.5, letterSpacing: '0.1em' }}>
                    PHONEME: {currentShape}
                </div>
            </div>
            <div className="playback-controls">
                <input
                    type="range"
                    className="playback-bar"
                    min="0"
                    max={duration || 0}
                    step="0.01"
                    value={currentTime}
                    onChange={(e) => onSeek(parseFloat(e.target.value))}
                />
            </div>
        </div>
    );
};

function App() {
    const [audioFile, setAudioFile] = useState(null)
    const [usageCount, setUsageCount] = useState(0)
    const [showSupportReminder, setShowSupportReminder] = useState(false)
    const [config, setConfig] = useState({
        recognizer: 'pocketSphinx',
        datFrameRate: 30,
        videoRes: 1080,
        videoFPS: 30,
        videoBgType: 'greenscreen',
        videoBgColor: '#10b981',
        videoQuality: 'high'
    })

    const [isProcessing, setIsProcessing] = useState(false)
    const [isExporting, setIsExporting] = useState(false)
    const [hasExported, setHasExported] = useState(false)
    const [isDirty, setIsDirty] = useState(true)
    const [progress, setProgress] = useState(0)
    const [status, setStatus] = useState('System Ready')
    const [output, setOutput] = useState(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [audioUrl, setAudioUrl] = useState(null)

    const audioRef = useRef(null)
    const abortControllerRef = useRef(null)

    const openExternal = (url) => {
        if (window.electron) window.electron.openExternal(url);
        else window.open(url, '_blank');
    };

    const cues = useMemo(() => {
        if (!output) return []
        try {
            const trimmed = typeof output === 'string' ? output.trim() : ''
            const tsvLines = trimmed.split('\n').filter(l => l.includes('\t'))
            if (tsvLines.length > 0) return tsvLines.map(line => {
                const [t, v] = line.split('\t'); return { start: parseFloat(t), value: v.trim() }
            });
            return JSON.parse(trimmed).mouthCues || []
        } catch (e) { return [] }
    }, [output])

    const currentStage = useMemo(() => {
        if (status.includes('Waking')) return 0;
        if (status.includes('Analyzing')) return 1;
        if (status.includes('Preparing')) return 2;
        if (status.includes('Rendering')) return 3;
        if (status.includes('Finalizing')) return 4;
        if (status.includes('Complete') || status.includes('Ready')) return -1;
        return -1;
    }, [status]);

    const handleAudioChange = (e) => {
        if (e.target.files?.[0]) {
            const file = e.target.files[0];
            setAudioFile(file);
            setIsDirty(true);
            setHasExported(false);
            if (audioUrl) URL.revokeObjectURL(audioUrl);
            setAudioUrl(URL.createObjectURL(file));
            setCurrentTime(0);
        }
    }

    const handleRun = async () => {
        if (!audioFile) return
        setIsProcessing(true);
        setProgress(0);
        setStatus('Waking Engine...');
        setOutput(null);
        setUsageCount(prev => prev + 1);
        setShowSupportReminder(true);
        setTimeout(() => setShowSupportReminder(false), 5000);

        abortControllerRef.current = new AbortController();
        const timeoutId = setTimeout(() => {
            if (isProcessing) {
                console.warn("Connection timeout. Aborting.");
                abortControllerRef.current?.abort();
            }
        }, 300000);

        try {
            const formData = new FormData()
            formData.append('audio', audioFile)
            formData.append('config', JSON.stringify(config))

            const response = await fetch('http://127.0.0.1:3001/process', {
                method: 'POST',
                body: formData,
                signal: abortControllerRef.current.signal
            })

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `Engine Error (${response.status})`);
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()

            let buffer = '';
            while (true) {
                const { value, done } = await reader.read()
                if (done) {
                    if (buffer.trim()) processLine(buffer.trim());
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) processLine(line.trim());
                }
            }

            function processLine(line) {
                try {
                    const data = JSON.parse(line)
                    if (data.type === 'progress') {
                        const p = Math.round(data.value * 100);
                        setProgress(p);
                        setStatus(`Analyzing: ${p}%`);
                    }
                    if (data.type === 'success') {
                        setOutput(data.result);
                        setStatus('Process Completed');
                        setProgress(100);
                        setIsDirty(false);
                    }
                    if (data.type === 'failure') throw new Error(data.reason);
                } catch (e) {
                    if (e instanceof SyntaxError) return;
                    throw e;
                }
            }
        } catch (error) {
            const msg = error.name === 'AbortError' ? 'Process Halted.' : `Error: ${error.message}`;
            setStatus(msg);
            setProgress(0);
        } finally {
            clearTimeout(timeoutId);
            setIsProcessing(false);
            abortControllerRef.current = null;
        }
    }

    const exportVideo = async () => {
        if (!output || !audioFile) return
        setIsExporting(true); setProgress(0); setStatus('Preparing Export...');

        try {
            const formData = new FormData()
            formData.append('audio', audioFile);
            formData.append('cues', JSON.stringify(cues));
            formData.append('config', JSON.stringify(config));

            const shapes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'];
            for (const s of shapes) {
                const img = new Image(); img.src = `mouths/mouth_${s}.svg`;
                await new Promise(res => img.onload = res);
                const canvas = document.createElement('canvas');
                canvas.width = config.videoRes; canvas.height = config.videoRes;
                const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, config.videoRes, config.videoRes);
                const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
                formData.append(`frame_${s}`, blob, `frame_${s}.png`);
            }

            setStatus('Rendering Output...'); setProgress(40);
            const response = await fetch('http://127.0.0.1:3001/render', { method: 'POST', body: formData });
            if (!response.ok) throw new Error('Render Failed');

            setStatus('Finalizing File...'); setProgress(90);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `LipForge2D_Output_${Date.now()}.mp4`;
            a.click();
            setStatus('Export Ready.'); setProgress(100);
            setHasExported(true);
        } catch (err) {
            setStatus(`Error: ${err.message}`);
        } finally {
            setIsExporting(false);
        }
    }

    useEffect(() => {
        if (!isPlaying) return;
        let animFrame;
        const update = () => {
            if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
            animFrame = requestAnimationFrame(update);
        };
        animFrame = requestAnimationFrame(update);
        return () => cancelAnimationFrame(animFrame);
    }, [isPlaying]);

    const stages = [
        'Initialize',
        'Analyze',
        'Extract',
        'Render',
        'Encode'
    ];

    return (
        <div className="app-container">
            <header>
                <div className="header-left">
                    <div className="logo-text">LipForge Pro</div>
                    <div className="badge">Engine</div>
                </div>
                <div className="header-right">
                    <div className="usage-badge" title="Total Runs">
                        <Zap size={14} fill="currentColor" color="var(--primary)" />
                        <span>{usageCount}</span>
                    </div>
                    <button className="support-btn" onClick={() => openExternal('https://www.patreon.com/c/emptyidea')}>
                        <Heart size={14} fill="currentColor" /> Patreon
                    </button>
                    <button className="support-btn" onClick={() => openExternal('https://buymeacoffee.com/emptyidea')}>
                        <Coffee size={14} /> coffee
                    </button>
                </div>
            </header>

            <div className="main-layout">
                <aside className="panel">
                    <div className="panel-title"><AudioWaveform size={20} color="var(--primary)" /> Media Input</div>
                    <div className="panel-content">
                        <label className="label">Speech Track</label>
                        <div
                            className="drop-zone"
                            onClick={() => !isProcessing && document.getElementById('audio-in').click()}
                            style={{ opacity: isProcessing ? 0.4 : 1, cursor: isProcessing ? 'not-allowed' : 'pointer' }}
                        >
                            <input id="audio-in" type="file" accept=".wav,.ogg" className="hidden" onChange={handleAudioChange} disabled={isProcessing} />
                            <div style={{ background: 'var(--primary-glow)', padding: '12px', borderRadius: '50%', color: 'var(--primary)' }}>
                                <Upload size={24} />
                            </div>
                            <div style={{ fontSize: '0.8rem', fontWeight: '600', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {audioFile ? audioFile.name : 'Click to Upload Audio'}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Supported: .wav, .ogg</div>
                        </div>

                        <div className="field-group">
                            <label className="label">Phoneme Engine</label>
                            <select className="select" value={config.recognizer} onChange={(e) => setConfig({ ...config, recognizer: e.target.value })}>
                                <option value="pocketSphinx">Neural Model (English)</option>
                                <option value="phonetic">Universal Model (Hybrid)</option>
                            </select>
                        </div>

                        <div className="field-group">
                            <label className="label">Output Frame Rate</label>
                            <select className="select" value={config.datFrameRate} onChange={(e) => setConfig({ ...config, datFrameRate: parseInt(e.target.value), videoFPS: parseInt(e.target.value) })}>
                                <option value={24}>24 FPS</option>
                                <option value={25}>25 FPS</option>
                                <option value={30}>30 FPS</option>
                                <option value={50}>50 FPS</option>
                                <option value={60}>60 FPS</option>
                            </select>
                        </div>

                        <div style={{ marginTop: 'auto', paddingTop: '20px' }}>
                            {!isProcessing ? (
                                <button className="btn-primary" disabled={!audioFile || !isDirty} onClick={handleRun}>
                                    <Zap size={18} fill="currentColor" /> {output && !isDirty ? 'Processed' : 'Analyze Speech'}
                                </button>
                            ) : (
                                <button className="btn-primary" style={{ background: '#ef4444' }} onClick={() => abortControllerRef.current?.abort()}>
                                    <Square size={16} fill="currentColor" /> Abort
                                </button>
                            )}
                        </div>
                    </div>
                </aside>

                <main className="panel">
                    <div className="panel-title"><Monitor size={20} color="var(--primary)" /> Studio Monitor</div>
                    <div className="panel-content" style={{ display: 'flex', flexDirection: 'column' }}>
                        {output ? (
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                                <PreviewMouth
                                    cues={cues}
                                    currentTime={currentTime}
                                    duration={audioRef.current?.duration || 0}
                                    onSeek={(t) => { if (audioRef.current) { audioRef.current.currentTime = t; setCurrentTime(t); } }}
                                />

                                <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                                    <button className="btn-secondary" style={{ flex: 1 }} onClick={() => { isPlaying ? audioRef.current.pause() : audioRef.current.play(); setIsPlaying(!isPlaying) }}>
                                        {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                                    </button>
                                    <button className="btn-secondary" style={{ width: '56px' }} onClick={() => { if (audioRef.current) { audioRef.current.currentTime = 0; setIsPlaying(false); setCurrentTime(0); } }}>
                                        <RotateCcw size={18} />
                                    </button>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '20px' }}>
                                    <div>
                                        <label className="label">Render Resolution</label>
                                        <select className="select" value={config.videoRes} onChange={(e) => setConfig({ ...config, videoRes: parseInt(e.target.value) })}>
                                            <option value={720}>720p HD</option>
                                            <option value={1080}>1080p FHD</option>
                                            <option value={2160}>4K UHD</option>
                                        </select>
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', justifyContent: 'flex-end' }}>
                                        {hasExported && <div title="File Saved" style={{ color: 'var(--primary)', padding: '10px' }}><FolderCheck size={20} /></div>}
                                        <button className="btn-primary" onClick={exportVideo} disabled={isExporting}>
                                            {isExporting ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
                                            {isExporting ? 'Encoding...' : 'Render Video'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0.2 }}>
                                <Video size={64} strokeWidth={1} />
                                <p style={{ marginTop: '16px', fontSize: '0.9rem', fontWeight: '500' }}>Waiting for Synthesis Data</p>
                            </div>
                        )}
                    </div>
                </main>
            </div>

            <div className="status-container">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="status-label">{status}</div>
                    <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--primary)' }}>{progress}%</div>
                </div>
                <div className="advanced-progress">
                    {stages.map((_, i) => (
                        <div
                            key={i}
                            className={`progress-step ${currentStage >= i ? 'active' : ''} ${currentStage === i ? 'loading' : ''}`}
                        />
                    ))}
                </div>
                <div className="stage-labels">
                    {stages.map((label, i) => (
                        <div key={i} className={`stage-label ${currentStage >= i ? 'active' : ''}`}>{label}</div>
                    ))}
                </div>
            </div>

            <footer className="app-footer">
                <div>v0.0.1 Studio • EmptyIdea All Rights Reserved</div>
            </footer>

            {showSupportReminder && (
                <div className="support-reminder">
                    <Heart size={16} fill="#ef4444" color="#ef4444" />
                    If this tool helps you, consider supporting the project ❤️
                </div>
            )}

            <audio ref={audioRef} src={audioUrl} onEnded={() => setIsPlaying(false)} className="hidden" />
        </div>
    )
}

export default App
