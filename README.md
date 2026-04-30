# CCTV Live → Local HLS Server

> Decrypts CCTV live streams in real-time via headless Chromium and serves them as standard TS HLS over HTTP — no browser window, no external dependencies beyond Node.js.

**20 channels supported:** `cctv1`–`cctv17`, `cctv5plus`, `cctveurope`, `cctvamerica`

---

## ⚠️ Legal Disclaimer / 免责声明

**English**

This project was built **purely as a personal learning exercise** to explore and better understand the following technologies:

- **WebAssembly (WASM)** — how browsers compile and execute native-speed binary modules
- **FFmpeg** — video container remuxing, HLS segmentation, and codec pipelines
- **Media Source Extensions (MSE)** — how browsers feed encrypted/decrypted fMP4 chunks to the media engine
- **Puppeteer / Headless Chromium** — browser automation and JavaScript hooking
- **HLS (HTTP Live Streaming)** — playlist formats, segment management, and live stream architecture
- **Node.js streams & Express** — piping binary data between processes and serving files over HTTP

There is **no intent to harm, infringe, profit, or facilitate piracy** of any kind. This is a hobbyist proof-of-concept, shared openly so others learning the same technologies can reference real-world usage.

> **⏱️ Maintenance Notice:** This project was verified as working as of its release date. However, as it was built purely for learning purposes, **no ongoing maintenance, bug fixes, or updates are guaranteed**. If CCTV changes their player infrastructure, stream encryption, or MSE implementation, this tool may break without warning and will likely **not** be patched. Use it as a reference, not a production dependency.

Additionally:

- This project does **not** host, store, redistribute, or monetize any media content. All streams originate from CCTV's official public web player (`cctv.com`) and are processed locally on your own machine only.
- The authors claim **no ownership** of any audio, video, or broadcast content accessed through this tool.
- This tool does **not** circumvent DRM for the purpose of piracy. It captures already-decrypted frames from the browser's native MSE pipeline, in the same way any screen recorder or browser DevTools would.
- **You are solely responsible** for ensuring your use of this tool complies with the laws and regulations of your jurisdiction, including but not limited to copyright law, broadcast law, and the content provider's terms of service.
- Streaming or redistributing CCTV content without authorization may constitute **copyright infringement**. Do **not** re-stream, publish, or commercially exploit content captured with this tool.
- This project is **not affiliated with, endorsed by, or connected to** China Central Television (CCTV), China Media Group (CMG), or any of their subsidiaries.

If you are a rights holder and believe this project facilitates infringement of your content, please open an issue or contact the repository maintainer. Legitimate DMCA takedown requests will be honored promptly.

---

**中文（免责声明）**

本项目纯属**个人学习项目**，旨在通过实践深入理解以下技术：

- **WebAssembly（WASM）**：浏览器如何编译与执行原生性能的二进制模块
- **FFmpeg**：视频容器重封装、HLS 切片及编解码流水线
- **媒体源扩展（MSE）**：浏览器如何将加密/解密后的 fMP4 数据块送入媒体引擎
- **Puppeteer / 无头 Chromium**：浏览器自动化与 JavaScript 钩子注入
- **HLS（HTTP 直播流）**：播放列表格式、分片管理与直播流架构
- **Node.js 流与 Express**：进程间二进制数据管道传输与 HTTP 文件服务

本项目**无意伤害任何人、侵犯任何权益、谋取商业利益或协助盗版**，仅为业余技术验证，公开分享是为了方便学习相同技术的开发者参考。

> **⏱️ 维护说明：** 本项目在发布时已验证可正常运行。但由于本项目纯属学习目的，**不保证持续维护、修复 Bug 或更新迭代**。若 CCTV 日后更改播放器架构、流加密方式或 MSE 实现，本工具可能随时失效，且大概率**不会**发布补丁修复。请将其作为学习参考，而非生产环境依赖。

此外：

- 本项目**不托管、不存储、不转发**任何媒体内容，亦不对其进行商业化。所有流媒体均来源于中央广播电视总台（CCTV）官方公开播放页面（`cctv.com`），且仅在用户本地设备上处理。
- 本项目作者对通过本工具访问的任何音视频或广播内容**不主张任何所有权**。
- 本工具**不以盗版为目的**破解数字版权保护（DRM）。其原理与屏幕录像或浏览器开发者工具完全一致，均是在浏览器原生 MSE 解码流程中捕获已解密的帧数据。
- 使用本工具所产生的一切法律责任，包括但不限于版权法、广播法及内容提供商服务条款，**由使用者自行承担**。
- 未经授权转播或分发 CCTV 内容可能构成**版权侵权**，请勿将本工具捕获的内容进行二次传播、公开发布或商业利用。
- 本项目与中央广播电视总台（CCTV）、中国广播电视集团（CMG）及其下属机构**无任何关联**，亦未获其授权或背书。

如您是版权持有人并认为本项目侵犯了您的合法权益，欢迎提交 Issue 或联系仓库维护者。对于合规的 DMCA 投诉，我们将及时予以处理。

---

## How It Works

```
CCTV player page (headless Chromium)
  → MSE appendBuffer hook captures decrypted fMP4
  → combined init + moof/mdat piped to ffmpeg
  → ffmpeg remuxes to TS HLS (copy codecs, no re-encode)
  → Express serves .m3u8 + .ts files over HTTP
```

---

## Dependencies

- **Node.js** ≥ 18
- **ffmpeg** (in your `PATH`, or auto-installed via `@ffmpeg-installer/ffmpeg`)

| Package | Purpose |
|---------|---------|
| `puppeteer` | Headless Chromium for in-browser decryption |
| `@ffmpeg-installer/ffmpeg` | Bundled ffmpeg binary (fallback) |
| `express` | HTTP server for HLS files |

---

## Setup

### Windows

```bash
git clone https://github.com/osscv/CCTVcom-Live.git
cd CCTVcom-Live
npm install
```

### Ubuntu / Debian

```bash
# Install Chromium system dependencies (one-time)
sudo apt-get update
sudo apt-get install -y \
  ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libx11-xcb1 \
  libxcomposite1 libxdamage1 libxrandr2 \
  xdg-utils

# Clone and install
git clone https://github.com/osscv/CCTVcom-Live.git
cd CCTVcom-Live
npm install
```

---

## Usage

### Start all channels (default port 8000)

```bash
node local_hls.js
```

### Start specific channels

```bash
node local_hls.js cctv1 cctv5plus cctveurope
```

### Custom port

```bash
node local_hls.js --port 9000 cctv1
```

### List available channels

```bash
node local_hls.js --list
```

---

## Playback

Once running, open any HLS-compatible player:

```bash
# Single channel
vlc http://localhost:8000/cctv1/playlist.m3u8

# All active channels via master playlist
vlc http://localhost:8000/master.m3u8
```

Or visit `http://localhost:8000/` in a browser for the full channel index.

---

## Output Structure

```
hls/
├── cctv1/
│   ├── playlist.m3u8    # live HLS playlist (last 10 segments)
│   ├── 0.ts
│   ├── 1.ts
│   └── ...
├── cctv2/
│   └── ...
└── ...
```

---

## Channel List

| Key | Name | M3U8 Path |
|-----|------|-----------|
| `cctv1` | CCTV-1 综合 | `/cctv1/playlist.m3u8` |
| `cctv2` | CCTV-2 财经 | `/cctv2/playlist.m3u8` |
| `cctv3` | CCTV-3 综艺 | `/cctv3/playlist.m3u8` |
| `cctv4` | CCTV-4 中文国际 | `/cctv4/playlist.m3u8` |
| `cctv5` | CCTV-5 体育 | `/cctv5/playlist.m3u8` |
| `cctv6` | CCTV-6 电影 | `/cctv6/playlist.m3u8` |
| `cctv7` | CCTV-7 国防军事 | `/cctv7/playlist.m3u8` |
| `cctv8` | CCTV-8 电视剧 | `/cctv8/playlist.m3u8` |
| `cctv9` | CCTV-9 纪录 | `/cctv9/playlist.m3u8` |
| `cctv10` | CCTV-10 科教 | `/cctv10/playlist.m3u8` |
| `cctv11` | CCTV-11 戏曲 | `/cctv11/playlist.m3u8` |
| `cctv12` | CCTV-12 社会与法 | `/cctv12/playlist.m3u8` |
| `cctv13` | CCTV-13 新闻 | `/cctv13/playlist.m3u8` |
| `cctv14` | CCTV-14 少儿 | `/cctv14/playlist.m3u8` |
| `cctv15` | CCTV-15 音乐 | `/cctv15/playlist.m3u8` |
| `cctv16` | CCTV-16 奥林匹克 | `/cctv16/playlist.m3u8` |
| `cctv17` | CCTV-17 农业农村 | `/cctv17/playlist.m3u8` |
| `cctv5plus` | CCTV-5+ 体育赛事 | `/cctv5plus/playlist.m3u8` |
| `cctveurope` | CCTV-Europe | `/cctveurope/playlist.m3u8` |
| `cctvamerica` | CCTV-America | `/cctvamerica/playlist.m3u8` |

---

## Related Scripts

| File | Purpose |
|------|---------|
| `local_hls.js` | [CCTV.com](https://cctv.com) Local HLS server (this project) |
| `package.json` | Project dependencies |

---

## License

This repository contains **no copyrighted broadcast content**. The source code itself is released under the [MIT License](LICENSE). All third-party packages retain their respective licenses.

**Secondary Development / 二次开发**

You are welcome to reference, fork, or build upon this project's code and approach, provided that:

- ✅ It remains **non-commercial** — do not use this codebase or its derived works to generate revenue, sell a product/service, or monetize streams in any form.
- ✅ It carries **no unlawful intent** — do not use it to facilitate piracy, unauthorized redistribution, or any activity that violates applicable law.
- ✅ **Credit is appreciated** — if you reference the core idea, stream-capture pipeline, or algorithm design in your own project, a mention or link back to this repository is encouraged.

> **📌 请注意 / Note:** 本项目的流捕获思路、MSE hook 方式及 HLS 处理算法均为**本项目原创首发**。如需二次开发或参考使用，请确保**无商业用途**且**无违法意图**。若您的项目基于本项目思路进行了延伸，欢迎注明出处并附上本仓库链接。

<p align="center">
  <a href="https://linux.do">
    <img
      alt="LINUX DO"
      src="https://wiki.linux.do/linuxdo_light.png"
    />
  </a>
  &nbsp;&nbsp;
  <a href="https://www.dkly.net">
    <img
      alt="DKLY Blog"
      src="https://www.dkly.net/image/e6d8e7b607d3ac82a4894570997d152a.png"
    />
  </a>
</p>
