/**
 * CCTV All Channels → Local HLS Server (Headless Chromium + ffmpeg fMP4 HLS)
 *
 * Captures decrypted fMP4 segments from CCTV player and pipes them
 * to ffmpeg for fMP4 HLS output (no TS conversion). Serves via Express HTTP.
 *
 * Usage:
 *   node local_hls.js                           # all 20 channels, port 8000
 *   node local_hls.js cctv1 cctv5plus           # specific channels
 *   node local_hls.js --port 9000               # custom port
 *   node local_hls.js --list                    # list channels
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const express = require('express');
const fs = require('fs');
const path = require('path');

// ---- Channel definitions ----
const CHANNELS = {};
for (let i = 1; i <= 17; i++) {
  CHANNELS['cctv' + i] = { name: 'CCTV-' + i, url: 'https://tv.cctv.com/live/cctv' + i + '/' };
}
CHANNELS['cctv5plus'] = { name: 'CCTV-5+', url: 'https://tv.cctv.com/live/cctv5plus/' };
CHANNELS['cctveurope'] = { name: 'CCTV-Europe', url: 'https://tv.cctv.com/live/cctveurope/index.shtml' };
CHANNELS['cctvamerica'] = { name: 'CCTV-America', url: 'https://tv.cctv.com/live/cctvamerica/' };

const HLS_BASE = path.join(__dirname, 'hls');

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 8000;

  if (args.includes('--list') || args.includes('-l')) {
    console.log('Available channels:');
    for (const [k, c] of Object.entries(CHANNELS))
      console.log('  ' + k.padEnd(14) + c.name);
    process.exit(0);
  }

  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
    args.splice(portIdx, 2);
  }

  const requested = args.filter(a => CHANNELS[a.toLowerCase()]);
  let selected = Object.entries(CHANNELS);
  if (requested.length > 0) selected = requested.map(c => [c, CHANNELS[c]]);
  return {
    port,
    channels: selected.map(([key, info]) => ({
      key, name: info.name, url: info.url,
      hlsDir: path.join(HLS_BASE, key),
      m3u8Path: path.join(HLS_BASE, key, 'playlist.m3u8'),
    })),
  };
}

// ---- Helpers ----
function ts() { return new Date().toISOString().split('T')[1].slice(0, 12); }
function kb(n) { return (n / 1024).toFixed(1) + 'KB'; }
function mb(n) { return (n / 1024 / 1024).toFixed(1) + 'MB'; }

// ---- fMP4 box parsing ----
function findBox(data, type) {
  let off = 0;
  while (off + 8 <= data.length) {
    const size = data.readUInt32BE(off);
    if (size < 8 || off + size > data.length) break;
    if (data.toString('ascii', off + 4, off + 8) === type)
      return { offset: off, size, data: data.slice(off, off + size) };
    off += size;
  }
  return null;
}
function findBoxes(data, type) {
  const r = []; let off = 0;
  while (off + 8 <= data.length) {
    const size = data.readUInt32BE(off);
    if (size < 8 || off + size > data.length) break;
    if (data.toString('ascii', off + 4, off + 8) === type)
      r.push({ offset: off, size, data: data.slice(off, off + size) });
    off += size;
  }
  return r;
}
function buildCombinedInit(audioInitBuf, videoInitBuf) {
  const vfTyp = findBox(videoInitBuf, 'ftyp');
  const aMoov = findBox(audioInitBuf, 'moov');
  const vMoov = findBox(videoInitBuf, 'moov');
  if (!vfTyp || !aMoov || !vMoov) return null;
  const aMC = audioInitBuf.slice(aMoov.offset + 8, aMoov.offset + aMoov.size);
  const vMC = videoInitBuf.slice(vMoov.offset + 8, vMoov.offset + vMoov.size);
  const mvhd = findBox(vMC, 'mvhd');
  const mvhdData = mvhd ? vMC.slice(mvhd.offset, mvhd.offset + mvhd.size) : null;
  const aTraks = findBoxes(aMC, 'trak').map(t => aMC.slice(t.offset, t.offset + t.size));
  const vTraks = findBoxes(vMC, 'trak').map(t => vMC.slice(t.offset, t.offset + t.size));
  const trexList = [];
  for (const c of [aMC, vMC]) {
    const mvex = findBox(c, 'mvex'); if (!mvex) continue;
    const mxC = c.slice(mvex.offset + 8, mvex.offset + mvex.size);
    for (const t of findBoxes(mxC, 'trex').map(t => mxC.slice(t.offset, t.offset + t.size))) trexList.push(t);
  }
  const seen = new Set(); const uniqueTrex = [];
  for (const t of trexList) { const tid = t.readUInt32BE(12); if (!seen.has(tid)) { seen.add(tid); uniqueTrex.push(t); } }
  const mvhdSize = mvhdData ? mvhdData.length : 0;
  const traksSize = [...vTraks, ...aTraks].reduce((s, t) => s + t.length, 0);
  const trexContentSize = uniqueTrex.reduce((s, t) => s + t.length, 0);
  const mvexSize = 8 + trexContentSize;
  const moovSize = 8 + mvhdSize + traksSize + mvexSize;
  const moov = Buffer.alloc(moovSize); let w = 0;
  moov.writeUInt32BE(moovSize, w); w += 4; moov.write('moov', w); w += 4;
  if (mvhdData) { mvhdData.copy(moov, w); w += mvhdSize; }
  for (const t of [...vTraks, ...aTraks]) { t.copy(moov, w); w += t.length; }
  moov.writeUInt32BE(mvexSize, w); w += 4; moov.write('mvex', w); w += 4;
  for (const t of uniqueTrex) { t.copy(moov, w); w += t.length; }
  return Buffer.concat([vfTyp.data, moov]);
}

// ---- Browser capture script ----
// Hooks MSE appendBuffer to capture decrypted fMP4 without interfering with
// the player's natural buffering. Tracks video element to auto-seek to live
// edge and detect genuine stalls.
const CAPTURE_SCRIPT = `
(function() {
  var segs = [], initSent = { audio: false, video: false }, initData = { audio: null, video: null };
  var lastAppendTime = Date.now(), stuckCount = 0, dataSent = false;
  var videoEl = null, lastCurrentTime = 0, timeStuckCount = 0;

  function uint8ToBase64(bytes) {
    var binary = '', chunk = 8192;
    for (var i = 0; i < bytes.length; i += chunk)
      binary += String.fromCharCode.apply(null, bytes.slice(i, Math.min(i + chunk, bytes.length)));
    return btoa(binary);
  }

  // Track video element and keep it at the live edge — no SourceBuffer tampering
  setInterval(function() {
    if (!videoEl) {
      videoEl = document.querySelector('video');
      if (videoEl) videoEl.muted = true;
    }
    if (!videoEl) return;
    // Keep playing
    if (videoEl.paused || videoEl.readyState < 2) {
      videoEl.play().catch(function(){});
    }
    // Seek to live edge if fallen behind more than 8 seconds
    if (videoEl.buffered && videoEl.buffered.length > 0) {
      var liveEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
      var drift = liveEnd - videoEl.currentTime;
      if (drift > 8) {
        videoEl.currentTime = liveEnd - 2;
      }
      // Detect time stuck (currentTime not advancing despite buffered data)
      if (Math.abs(videoEl.currentTime - lastCurrentTime) < 0.1 && drift > 2) {
        timeStuckCount++;
        if (timeStuckCount > 4) {
          videoEl.currentTime = liveEnd - 1;
          timeStuckCount = 0;
        }
      } else {
        timeStuckCount = 0;
      }
      lastCurrentTime = videoEl.currentTime;
    }
  }, 4000);

  var OrigMS = window.MediaSource;
  if (OrigMS) {
    var origAddSB = OrigMS.prototype.addSourceBuffer;
    OrigMS.prototype.addSourceBuffer = function(mime) {
      var sb = origAddSB.call(this, mime);
      var origAppend = sb.appendBuffer.bind(sb);

      sb.appendBuffer = function(data) {
        var copy;
        try {
          copy = new Uint8Array(data.byteLength);
          copy.set(new Uint8Array(data));
        } catch(e) { return origAppend(data); }

        var hdr = copy.length > 12 ? String.fromCharCode(copy[4], copy[5], copy[6], copy[7]) : '';
        var isInit = hdr === 'ftyp', isMedia = hdr === 'moof';

        if (isInit) {
          var isAudio = mime.indexOf('audio') !== -1;
          if (isAudio && !initSent.audio) {
            initSent.audio = true; initData.audio = copy;
          } else if (!isAudio && !initSent.video) {
            initSent.video = true; initData.video = copy;
          }
        } else if (isMedia) {
          segs.push(copy);
          lastAppendTime = Date.now();
        }

        try {
          return origAppend(data);
        } catch(e) {
          if (e.name === 'QuotaExceededError') {
            try {
              if (sb.buffered && sb.buffered.length > 0) {
                var bs = sb.buffered.start(0), be = sb.buffered.end(sb.buffered.length - 1);
                if (be - bs > 10) sb.remove(bs, be - 8);
              }
            } catch(e2) {}
            try { return origAppend(data); } catch(e3) {}
          }
          throw e;
        }
      };
      return sb;
    };
  }

  window.__getFmp4Data = function() {
    var result = { segments: [], audioInit: null, videoInit: null, stuck: false,
                   video: { currentTime: 0, liveEnd: 0, paused: true, readyState: 0 } };
    if (videoEl) {
      var liveEnd = videoEl.buffered && videoEl.buffered.length > 0
        ? videoEl.buffered.end(videoEl.buffered.length - 1) : 0;
      result.video = {
        currentTime: videoEl.currentTime,
        liveEnd: liveEnd,
        paused: videoEl.paused,
        readyState: videoEl.readyState,
        drift: liveEnd - videoEl.currentTime
      };
    }
    var now = Date.now();
    // Only declare stuck if NO new segments AND video time isn't advancing for > 90s
    if (segs.length === 0 && (now - lastAppendTime) > 90000) {
      stuckCount++;
      if (stuckCount > 5) result.stuck = true;
    } else if (segs.length > 0) {
      stuckCount = 0;
    }
    if (!dataSent) {
      if (initData.audio) result.audioInit = uint8ToBase64(initData.audio);
      if (initData.video) result.videoInit = uint8ToBase64(initData.video);
      if (result.audioInit || result.videoInit) dataSent = true;
    }
    var take = segs.splice(0, segs.length);
    for (var i = 0; i < take.length; i++) result.segments.push(uint8ToBase64(take[i]));
    return result;
  };
})();
`;

// ---- Stream a single channel to ffmpeg HLS ----
async function streamChannel(browser, ch) {
  const L = ' [' + ch.name + '] ';
  let audioInit = null, videoInit = null, combinedInit = null;
  let ffmpegProc = null;
  let totalBytes = 0, segCount = 0;
  let lastStatsTime = Date.now(), startTime = Date.now();

  // Create HLS output directory
  fs.mkdirSync(ch.hlsDir, { recursive: true });

  const page = await browser.newPage();
  await page.setViewport({ width: 854, height: 480 });

  function startFFmpeg(initData) {
    if (ffmpegProc && !ffmpegProc.killed) {
      try { ffmpegProc.stdin.end(); } catch(e) {}
      ffmpegProc.kill();
    }
    console.log(L + '[FFmpeg] Start → TS HLS  dir:', ch.hlsDir, '  init:', kb(initData.length));

    ffmpegProc = spawn(ffmpegPath, [
      '-loglevel', 'warning',
      '-f', 'mp4', '-i', 'pipe:0',
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '3',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(ch.hlsDir, '%d.ts'),
      ch.m3u8Path,
    ]);

    ffmpegProc.stderr.on('data', d => {
      const s = d.toString();
      if (s.match(/Error|error|failed|refused|denied/))
        console.log(L + '[FFmpeg-ERR]', s.trim());
      else if (s.match(/segment/))
        console.log(L + '[FFmpeg]', s.trim());
    });

    ffmpegProc.on('close', code => {
      ffmpegProc = null;
      if (combinedInit && code !== 0)
        setTimeout(() => { if (combinedInit) startFFmpeg(combinedInit); }, 3000);
    });
    ffmpegProc.on('error', err => console.error(L + '[FFmpeg] Error:', err.message));
    ffmpegProc.stdin.on('error', () => {});
    if (ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
      try { ffmpegProc.stdin.write(initData); totalBytes += initData.length; } catch(e) {}
    }
  }

  function resetState() {
    audioInit = null; videoInit = null; combinedInit = null;
    if (ffmpegProc && !ffmpegProc.killed) {
      try { ffmpegProc.stdin.end(); } catch(e) {}
      ffmpegProc.kill();
      ffmpegProc = null;
    }
    // Clean HLS files
    try {
      for (const f of fs.readdirSync(ch.hlsDir))
        fs.unlinkSync(path.join(ch.hlsDir, f));
    } catch(e) {}
    console.log(L + '[STATE] Reset for reload');
  }

  function logStats() {
    const now = Date.now();
    if (now - lastStatsTime < 15000) return;
    const elapsed = ((now - startTime) / 1000).toFixed(0);
    const rate = ((totalBytes * 8) / ((now - startTime) / 1000) / 1000000).toFixed(2);
    console.log(L + '[STATS]', ts(), '| up:', elapsed + 's', '| segs:', segCount, '| piped:', mb(totalBytes), '|', rate, 'Mbps');
    lastStatsTime = now;
  }

  await page.evaluateOnNewDocument(CAPTURE_SCRIPT);

  async function loadChannel() {
    await page.goto(ch.url, { waitUntil: 'networkidle2', timeout: 60000 });
    try {
      await page.waitForSelector('video', { timeout: 30000 });
      await page.evaluate(() => {
        var v = document.querySelector('video');
        if (v) { v.muted = true; v.play().catch(function(){}); }
      });
      console.log(L + '[PAGE] Player ready, capturing fMP4...');
    } catch(e) {
      console.log(L + '[PAGE] No video, retrying...');
    }
  }

  await loadChannel();

  const interval = setInterval(async () => {
    try {
      const data = await page.evaluate(() => window.__getFmp4Data());

      // Log video state periodically when no segments
      if (data.segments.length === 0 && data.video) {
        console.log(L + '[VIDEO] cur:', data.video.currentTime.toFixed(1) + 's',
          'live:', data.video.liveEnd.toFixed(1) + 's',
          'drift:', data.video.drift.toFixed(1) + 's',
          'paused:', data.video.paused,
          'ready:', data.video.readyState);
      }

      if (data.stuck) {
        console.log(L + '[WARN] STUCK — no data >90s! Reloading...');
        resetState();
        try { await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }); }
        catch(e) { await loadChannel(); }
        return;
      }

      if (data.audioInit && !audioInit) audioInit = Buffer.from(data.audioInit, 'base64');
      if (data.videoInit && !videoInit) videoInit = Buffer.from(data.videoInit, 'base64');

      if (audioInit && videoInit && !combinedInit) {
        combinedInit = buildCombinedInit(audioInit, videoInit);
        if (combinedInit) {
          console.log(L + '[INIT] Combined fMP4:', kb(combinedInit.length),
            '(A:' + kb(audioInit.length), 'V:' + kb(videoInit.length) + ')');
          startFFmpeg(combinedInit);
        }
      }

      if (data.segments.length > 0) {
        for (const b64 of data.segments) {
          const buf = Buffer.from(b64, 'base64');
          if (combinedInit && ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
            try { ffmpegProc.stdin.write(buf); totalBytes += buf.length; }
            catch (e) { break; }
          }
        }
        segCount += data.segments.length;
        if (segCount % 30 === 0 || segCount <= 3) {
          console.log(L + '[PUSH]', data.segments.length, 'segs, total:', segCount, '| piped:', mb(totalBytes));
        }
      }

      logStats();
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('Execution context was destroyed') || msg.includes('Target closed')) {
        console.log(L + '[WARN] Page crashed! Reloading...');
        resetState();
        try { await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }); }
        catch(e2) { await loadChannel(); }
      }
    }
  }, 1000);

  return {
    key: ch.key,
    stop: () => {
      clearInterval(interval);
      if (ffmpegProc && !ffmpegProc.killed) {
        ffmpegProc.stdin.end();
        setTimeout(() => { if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill(); }, 2000);
      }
    }
  };
}

// ---- HTTP Server ----
function createServer(port, channelKeys) {
  const app = express();

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    next();
  });

  // Serve HLS files with correct MIME types
  app.use(express.static(HLS_BASE, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8'))
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      else if (filePath.endsWith('.ts'))
        res.setHeader('Content-Type', 'video/mp2t');
      else if (filePath.endsWith('.m4s'))
        res.setHeader('Content-Type', 'video/iso.segment');
      else if (filePath.endsWith('.mp4'))
        res.setHeader('Content-Type', 'video/mp4');
    }
  }));

  // Master playlist
  app.get('/master.m3u8', (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    const channels = channelKeys.filter(c => {
      const playlist = path.join(HLS_BASE, c, 'playlist.m3u8');
      return fs.existsSync(playlist);
    });
    if (channels.length === 0) {
      res.send('#EXTM3U\n#EXT-X-VERSION:7\n');
      return;
    }
    let m3u8 = '#EXTM3U\n#EXT-X-VERSION:7\n';
    for (const c of channels.sort()) {
      const name = CHANNELS[c] ? CHANNELS[c].name : c;
      m3u8 += '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=854x480,NAME="' + name + '"\n';
      m3u8 += c + '/playlist.m3u8\n';
    }
    res.send(m3u8);
  });

  // Index page
  app.get('/', (req, res) => {
    let html = '<!DOCTYPE html><html><head><meta charset="utf-8">';
    html += '<meta http-equiv="refresh" content="5">';
    html += '<title>CCTV HLS Streams</title>';
    html += '<style>body{font-family:monospace;background:#111;color:#0f0;padding:20px}';
    html += 'h2{color:#0ff}a{color:#ff0}li{margin:6px 0}.note{color:#888}.live{color:#0f0}.waiting{color:#ff0}</style></head><body>';
    html += '<h2>CCTV HLS Streams (' + channelKeys.length + ' channels)</h2>';
    html += '<p class="note">Format: TS HLS (ffmpeg remux — works in all players)</p>';
    html += '<ul>';
    for (const c of channelKeys.sort()) {
      const name = CHANNELS[c] ? CHANNELS[c].name : c;
      const hasPlaylist = fs.existsSync(path.join(HLS_BASE, c, 'playlist.m3u8'));
      const status = hasPlaylist ? '<span class="live">● LIVE</span>' : '<span class="waiting">○ loading...</span>';
      html += '<li><b>' + name + '</b> ' + status;
      if (hasPlaylist)
        html += ' → <a href="/' + c + '/playlist.m3u8">/' + c + '/playlist.m3u8</a>';
      html += '</li>';
    }
    html += '</ul>';
    html += '<p><a href="/master.m3u8">Master playlist</a></p>';
    html += '<p>VLC: <code>vlc http://localhost:' + port + '/cctv1/playlist.m3u8</code></p>';
    html += '</body></html>';
    res.send(html);
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log('  [HTTP] Server listening on http://localhost:' + port);
      resolve(server);
    });
  });
}

// ---- Main ----
async function main() {
  const { port, channels } = parseArgs();

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  CCTV → TS HLS Server (ffmpeg remux)');
  console.log('  Channels:', channels.length, ' | Port:', port);
  console.log('══════════════════════════════════════════════');
  for (const c of channels)
    console.log('  ' + c.name.padEnd(14) + '→ http://localhost:' + port + '/' + c.key + '/playlist.m3u8');
  console.log('');

  fs.mkdirSync(HLS_BASE, { recursive: true });

  const server = await createServer(port, channels.map(c => c.key));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--disable-dev-shm-usage', '--mute-audio',
    ]
  });
  console.log('  [BROWSER] Headless Chromium launched\n');

  const streams = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    try {
      const stream = await streamChannel(browser, ch);
      streams.push(stream);
      console.log('  [MAIN] ' + ch.name + ' started (' + (i + 1) + '/' + channels.length + ')');
    } catch (e) {
      console.error('  [MAIN] FAILED to start ' + ch.name + ':', e.message);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  ' + streams.length + '/' + channels.length + ' channels streaming');
  console.log('  http://localhost:' + port);
  console.log('  Press Ctrl+C to stop');
  console.log('══════════════════════════════════════════════\n');

  setInterval(() => {
    console.log('  [SUMMARY]', ts(), '|', streams.length, 'channels');
  }, 60000);

  process.on('SIGINT', async () => {
    console.log('\n  Shutting down...');
    for (const s of streams) s.stop();
    await new Promise(r => setTimeout(r, 3000));
    await browser.close();
    server.close();
    console.log('  Done.');
    process.exit(0);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
