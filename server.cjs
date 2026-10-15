var http = require('http');
var https = require('https');
var urlModule = require('url');
var fs = require('fs');
var fsp = fs.promises;
var path = require('path');
var os = require('os');
var child_process = require('child_process');

var PORT = process.env.PORT || 8000;
var BASE_DIR = __dirname;
var VIDEOS_DIR = path.join(BASE_DIR, "videos");
var THUMBS_DIR = path.join(BASE_DIR, ".thumbs");
var WORK_DIR = path.join(BASE_DIR, ".work");

var HD_BASE = "http://hdstudio.org";
var HD_EMBED = "https://apiplayers.insertunit.ws/embed/kp";
var HD_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var HD_CONCURRENCY = 10;

// Создаем нужные директории
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// Если в папке был test.mp4, скопируем в videos
var oldTestFile = path.join(BASE_DIR, "test.mp4");
var newTestFile = path.join(VIDEOS_DIR, "test.mp4");
if (fs.existsSync(oldTestFile) && !fs.existsSync(newTestFile)) {
  try {
    fs.copyFileSync(oldTestFile, newTestFile);
    console.log('[ИНФО] Старый test.mp4 автоматически скопирован в папку videos!');
  } catch(e) {}
}

function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function shortUrl(u) {
  try {
    var x = new URL(u);
    return x.hostname + (x.pathname.length > 50 ? x.pathname.slice(0, 47) + '...' : x.pathname);
  } catch(e) {
    return u;
  }
}

function getLocalIP() {
  var interfaces = os.networkInterfaces();
  for (var name in interfaces) {
    for (var i = 0; i < interfaces[name].length; i++) {
      var iface = interfaces[name][i];
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.indexOf('169.254.') !== 0) {
          return iface.address;
        }
      }
    }
  }
  return '127.0.0.1';
}

function getVideoList() {
  var supportedExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'];
  try {
    var files = fs.readdirSync(VIDEOS_DIR);
    var list = [];
    for (var i = 0; i < files.length; i++) {
      var ext = path.extname(files[i]).toLowerCase();
      if (supportedExts.indexOf(ext) !== -1) {
        var filePath = path.join(VIDEOS_DIR, files[i]);
        var stats = fs.statSync(filePath);
        var title = path.basename(files[i], ext);
        var mb = (stats.size / (1024 * 1024)).toFixed(1);
        list.push({
          filename: files[i],
          title: title,
          sizeMb: mb,
          ext: ext
        });
      }
    }
    return list;
  } catch(e) {
    return [];
  }
}

// Проверка наличия ffmpeg в системе
function checkFfmpeg() {
  var r = child_process.spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// -------------------------------------------------------------
// HTTP СЛОЙ ДЛЯ HDSTUDIO / HLS
// -------------------------------------------------------------
async function httpText(url, referer, timeoutMs, tries) {
  referer = referer || HD_BASE + "/";
  timeoutMs = timeoutMs || 30000;
  tries = tries || 4;
  var lastErr;
  for (var attempt = 1; attempt <= tries; attempt++) {
    try {
      var res = await fetch(url, {
        headers: {
          "user-agent": HD_UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
          referer: referer,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        var err = new Error("HTTP " + res.status + " for " + shortUrl(url));
        if (res.status === 404 || res.status === 403) throw err;
        lastErr = err;
      } else {
        return await res.text();
      }
    } catch (e) {
      if (e.message && (e.message.startsWith("HTTP 404") || e.message.startsWith("HTTP 403"))) throw e;
      lastErr = e;
    }
    if (attempt < tries) await sleep(400 * attempt + Math.floor(Math.random() * 300));
  }
  throw new Error("Запрос не удался после " + tries + " попыток: " + (lastErr ? lastErr.message : lastErr));
}

async function httpBuffer(url, referer, timeoutMs, tries) {
  referer = referer || HD_BASE + "/";
  timeoutMs = timeoutMs || 60000;
  tries = tries || 5;
  var lastErr;
  for (var attempt = 1; attempt <= tries; attempt++) {
    try {
      var res = await fetch(url, {
        headers: { "user-agent": HD_UA, referer: referer },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        if (res.status === 404 || res.status === 403) throw err;
        lastErr = err;
      } else {
        var buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error("empty body");
        return buf;
      }
    } catch (e) {
      if (e.message && (String(e.message).startsWith("HTTP 404") || String(e.message).startsWith("HTTP 403"))) throw e;
      lastErr = e;
    }
    if (attempt < tries) await sleep(500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400));
  }
  throw new Error("Сегмент не удалось загрузить: " + (lastErr ? lastErr.message : lastErr));
}

// -------------------------------------------------------------
// ПАРСИНГ HDSTUDIO И ПЛЕЕРА
// -------------------------------------------------------------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&laquo;/g, "«").replace(/&raquo;/g, "»")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, function(m) { return String.fromCharCode(parseInt(m.slice(2, -1), 10)); });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function matchBrace(str, openIdx) {
  var depth = 0, inStr = false, esc = false;
  for (var i = openIdx; i < str.length; i++) {
    var c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return str.slice(openIdx, i + 1);
    }
  }
  return null;
}

function extractJsonish(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    try {
      return Function('"use strict";return (' + text + ');')();
    } catch (e2) {
      return null;
    }
  }
}

function parseSerialPage(html, url) {
  var titleMatch = html.match(/<h1 class="head-title"[^>]*>\s*<span>(.*?)<\/span>/s);
  var title = (titleMatch && titleMatch[1]) ? titleMatch[1].trim() : "";
  if (!title) {
    var ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle ? ogTitle[1] : "";
  }
  title = stripTags(title);

  var dubMatch = html.match(/Перевод:\s*<a[^>]*>([\s\S]*?)<\/a>/);
  var siteDub = dubMatch ? stripTags(dubMatch[1]) : "—";

  var ogVideo = html.match(/<meta property="og:video" content="([^"]+)"/);
  var iframeMovies = html.match(/<iframe[^>]+id="moviess"[^>]+src="([^"]+)"/);
  var iframeGeneral = html.match(/<iframe[^>]+src="([^"]*\/(?:embed|player)[^"]*)"/);

  var embedSrc = (ogVideo && ogVideo[1]) || (iframeMovies && iframeMovies[1]) || (iframeGeneral && iframeGeneral[1]) || "";
  var kpMatch = embedSrc.match(/embed\/kp\/(\d+)/);
  var kpId = kpMatch ? kpMatch[1] : null;

  var slugMatch = url.match(/\/serial\/([^/]+)\//);
  var slug = slugMatch ? slugMatch[1] : null;

  return { title: title || "Сериал", siteDub: siteDub, kpId: kpId, slug: slug, url: url };
}

function parseEmbed(html) {
  var mkIdx = html.indexOf("makePlayer(");
  if (mkIdx === -1) throw new Error("На странице встроенного плеера не найден вызов makePlayer()");
  var plIdx = html.indexOf("playlist:", mkIdx);
  if (plIdx === -1) throw new Error("В плеере отсутствует плейлист (playlist)");
  var openIdx = html.indexOf("{", plIdx);
  var raw = matchBrace(html, openIdx);
  if (!raw) throw new Error("Не удалось прочитать JSON плейлиста");
  var playlist = extractJsonish(raw);
  if (!playlist || !Array.isArray(playlist.seasons)) throw new Error("Список сезонов отсутствует");

  var curIdx = html.indexOf("current:", mkIdx);
  var current = null;
  if (curIdx !== -1) {
    var cOpen = html.indexOf("{", curIdx);
    var cRaw = matchBrace(html, cOpen);
    if (cRaw) current = extractJsonish(cRaw);
  }
  return { playlist: playlist, current: current };
}

function parseMaster(text) {
  var lines = text.split(/\r?\n/);
  var audios = [];
  var videos = [];
  var pendingStreamInf = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO")) {
      var uriMatch = line.match(/URI="([^"]+)"/);
      var nameMatch = line.match(/NAME="([^"]+)"/);
      var groupMatch = line.match(/GROUP-ID="([^"]+)"/);
      var uri = uriMatch ? uriMatch[1] : null;
      var name = nameMatch ? nameMatch[1] : "";
      var group = groupMatch ? groupMatch[1] : "";
      if (uri) audios.push({ name: name, group: group, uri: uri });
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      var res = line.match(/RESOLUTION=(\d+)x(\d+)/);
      var bw = line.match(/BANDWIDTH=(\d+)/);
      var audioGroup = line.match(/AUDIO="([^"]+)"/);
      pendingStreamInf = {
        width: res ? parseInt(res[1], 10) : 0,
        height: res ? parseInt(res[2], 10) : 0,
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        audioGroup: audioGroup ? audioGroup[1] : null,
      };
    } else if (line && !line.startsWith("#") && pendingStreamInf) {
      videos.push(Object.assign({}, pendingStreamInf, { uri: line.trim() }));
      pendingStreamInf = null;
    }
  }
  var primary = audios.filter(function(a) { return a.group === "audio0"; });
  return { audios: primary.length ? primary : audios, videos: videos };
}

function parseMediaPlaylist(text, playlistUrl) {
  var out = [];
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.startsWith("#")) continue;
    out.push(new URL(line.trim(), playlistUrl).href);
  }
  return out;
}

async function loadSerial(url) {
  var html = await httpText(url);
  var meta = parseSerialPage(html, url);
  if (!meta.kpId) throw new Error("Не удалось найти ID плеера (embed/kp/<id>) на странице сериала");
  var embedHtml = await httpText(HD_EMBED + "/" + meta.kpId, url);
  var parsed = parseEmbed(embedHtml);
  return Object.assign({}, meta, { playlist: parsed.playlist, current: parsed.current });
}

function seasonsOf(playlist) {
  return playlist.seasons
    .map(function(s) {
      return {
        season: parseInt(s.season, 10),
        episodes: (s.episodes || []).slice().sort(function(a, b) {
          return parseInt(a.episode, 10) - parseInt(b.episode, 10);
        })
      };
    })
    .sort(function(a, b) { return a.season - b.season; });
}

function findEpisode(playlist, season, episode) {
  var se = seasonsOf(playlist).find(function(s) { return s.season === parseInt(season, 10); });
  if (!se) throw new Error("Сезон " + season + " не найден");
  var ep = se.episodes.find(function(e) { return parseInt(e.episode, 10) === parseInt(episode, 10); });
  if (!ep) throw new Error("Серия S" + season + "E" + episode + " не найдена");
  return Object.assign({}, ep, { season: parseInt(season, 10) });
}

function pickDubMasterAudio(master, epAudio, dubName) {
  var names = (epAudio && epAudio.names) ? epAudio.names : [];
  var order = (epAudio && epAudio.order) ? epAudio.order : names.map(function(_, i) { return i; });
  var idx = -1;
  if (dubName) {
    idx = names.findIndex(function(n) { return n.toLowerCase() === String(dubName).toLowerCase(); });
  }
  if (idx === -1) idx = 0;

  var streamIdx = (order[idx] !== undefined) ? order[idx] : idx;
  var byUriOrder = master.audios
    .map(function(a, i) { return { a: a, i: i }; })
    .sort(function(x, y) {
      var mx = x.a.uri.match(/index-a(\d+)\.m3u8/);
      var my = y.a.uri.match(/index-a(\d+)\.m3u8/);
      var nx = mx ? parseInt(mx[1], 10) : 99;
      var ny = my ? parseInt(my[1], 10) : 99;
      return nx - ny;
    });

  var picked = byUriOrder[streamIdx] || byUriOrder[0] || (master.audios.length ? { a: master.audios[0] } : null);
  if (!picked) throw new Error("Аудиодорожки не найдены в master playlist");
  return { name: names[idx] || picked.a.name || "Original", index: streamIdx, uri: picked.a.uri };
}

function pickVideo(master, wantHeight) {
  if (!master.videos || !master.videos.length) throw new Error("В master playlist нет видеодорожек");
  var sorted = master.videos.slice().sort(function(a, b) { return b.height - a.height; });
  if (!wantHeight || wantHeight <= 0) return sorted[0];
  var best = sorted.find(function(v) { return v.height <= wantHeight; });
  if (!best) best = sorted[sorted.length - 1];
  return best;
}

async function downloadTrack(segments, dir, concurrency, onProgress) {
  await fsp.mkdir(dir, { recursive: true });
  var total = segments.length;
  var done = 0;
  var bytes = 0;
  var cursor = 0;

  async function worker() {
    while (cursor < total) {
      var i = cursor++;
      var dest = path.join(dir, "seg-" + String(i).padStart(5, "0") + ".ts");
      try {
        var st = await fsp.stat(dest);
        if (st.size > 0) {
          done++;
          bytes += st.size;
          onProgress(done, total, bytes);
          continue;
        }
      } catch(e) {}

      var buf = await httpBuffer(segments[i], segments[i]);
      await fsp.writeFile(dest, buf);
      done++;
      bytes += buf.length;
      onProgress(done, total, bytes);
    }
  }

  var workers = [];
  var count = Math.min(concurrency || HD_CONCURRENCY, total);
  for (var w = 0; w < count; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return { total: total, done: done, bytes: bytes };
}

function runFfmpegConcat(vListPath, aListPath, outPath) {
  return new Promise(function(resolve, reject) {
    var proc = child_process.spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", vListPath,
      "-f", "concat", "-safe", "0", "-i", aListPath,
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
      outPath
    ]);
    var stderr = "";
    proc.stderr.on("data", function(d) { stderr += d.toString(); });
    proc.on("error", function(err) { reject(err); });
    proc.on("close", function(code) {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg завершился с ошибкой (код " + code + "): " + stderr));
    });
  });
}

// -------------------------------------------------------------
// СОСТОЯНИЕ ЗАГРУЗКИ (ОБЩЕЕ ДЛЯ ВСЕХ ЗАГРУЗОК)
// -------------------------------------------------------------
var dlState = {
  active: false,
  status: 'idle', // 'idle' | 'downloading' | 'done' | 'error'
  percent: 0,
  receivedMb: '0',
  totalMb: '0',
  speed: '0 KB/s',
  filename: '',
  errorMsg: ''
};

// 1. Скачивание одиночного файла по прямой ссылке
function startFileDownload(targetUrl, customTitle) {
  if (dlState.active) {
    return { success: false, msg: 'Загрузка уже идет!' };
  }

  var parsed = urlModule.parse(targetUrl);
  var rawName = path.basename(parsed.pathname || 'video.mp4');
  var ext = path.extname(rawName) || '.mp4';

  var finalName = '';
  if (customTitle && customTitle.trim().length > 0) {
    var clean = sanitizeName(customTitle);
    finalName = clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext;
  } else {
    if (rawName.toLowerCase() === '1080.mp4' || rawName.toLowerCase() === 'video.mp4') {
      finalName = 'Movie_' + Date.now() + '_' + rawName;
    } else {
      finalName = sanitizeName(rawName);
    }
  }

  var destPath = path.join(VIDEOS_DIR, finalName);

  dlState.active = true;
  dlState.status = 'downloading';
  dlState.percent = 0;
  dlState.receivedMb = '0';
  dlState.totalMb = '0';
  dlState.speed = '0 KB/s';
  dlState.filename = finalName;
  dlState.errorMsg = '';

  console.log('[ЗАГРУЗКА] Старт скачивания: ' + targetUrl + ' -> ' + finalName);

  function executeRequest(currentUrl, redirectsLeft) {
    if (redirectsLeft <= 0) {
      dlState.status = 'error';
      dlState.active = false;
      dlState.errorMsg = 'Слишком много перенаправлений (редиректов)';
      return;
    }

    var u = urlModule.parse(currentUrl);
    var client = u.protocol === 'https:' ? https : http;
    var reqOptions = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.path,
      headers: { 'User-Agent': HD_UA }
    };

    var req = client.get(reqOptions, function(res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        var nextUrl = urlModule.resolve(currentUrl, res.headers.location);
        return executeRequest(nextUrl, redirectsLeft - 1);
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        dlState.status = 'error';
        dlState.active = false;
        dlState.errorMsg = 'Сервер вернул статус ' + res.statusCode;
        return;
      }

      var totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      var receivedBytes = 0;
      var lastTime = Date.now();
      var lastReceived = 0;

      var fileStream = fs.createWriteStream(destPath);

      res.on('data', function(chunk) {
        receivedBytes += chunk.length;
        var now = Date.now();
        if (now - lastTime >= 800) {
          var diff = receivedBytes - lastReceived;
          var bps = diff / ((now - lastTime) / 1000);
          dlState.speed = (bps / (1024 * 1024)).toFixed(2) + ' MB/s';
          lastTime = now;
          lastReceived = receivedBytes;
        }

        dlState.receivedMb = (receivedBytes / (1024 * 1024)).toFixed(1);
        dlState.totalMb = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
        dlState.percent = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
      });

      res.pipe(fileStream);

      fileStream.on('finish', function() {
        fileStream.close(function() {
          dlState.status = 'done';
          dlState.active = false;
          dlState.percent = 100;
          console.log('[ЗАГРУЗКА] Файл успешно скачан: ' + finalName);
        });
      });

      fileStream.on('error', function(err) {
        dlState.status = 'error';
        dlState.active = false;
        dlState.errorMsg = err.message;
        try { fs.unlinkSync(destPath); } catch(e) {}
      });
    });

    req.on('error', function(err) {
      dlState.status = 'error';
      dlState.active = false;
      dlState.errorMsg = err.message;
      try { fs.unlinkSync(destPath); } catch(e) {}
    });
  }

  executeRequest(targetUrl, 5);
  return { success: true };
}

// 2. Скачивание серии с hdstudio
async function startSerialDownload(serialUrl, season, episode, dubName, quality) {
  if (dlState.active) {
    return { success: false, msg: 'Загрузка уже идет!' };
  }
  if (!checkFfmpeg()) {
    return { success: false, msg: 'ffmpeg не найден на сервере в PATH! Установите ffmpeg для склейки HLS сегментов.' };
  }

  dlState.active = true;
  dlState.status = 'downloading';
  dlState.percent = 0;
  dlState.receivedMb = '0';
  dlState.totalMb = '0';
  dlState.speed = 'Инициализация...';
  dlState.filename = 'Сезон ' + season + ', Серия ' + episode;
  dlState.errorMsg = '';

  var workDir = path.join(WORK_DIR, 'hd_' + Date.now());

  (async function() {
    try {
      console.log('[HDSTUDIO] Загрузка метаданных: ' + serialUrl);
      var data = await loadSerial(serialUrl);
      var ep = findEpisode(data.playlist, season, episode);

      if (ep.blocked) {
        throw new Error('Серия заблокирована правообладателем в плеере!');
      }
      if (!ep.hls) {
        throw new Error('У серии нет потока HLS (доступен только DASH)');
      }

      var masterText = await httpText(ep.hls);
      var master = parseMaster(masterText);
      var chosenDub = dubName || (ep.audio && ep.audio.names && ep.audio.names[0]);
      var audio = pickDubMasterAudio(master, ep.audio, chosenDub);
      var video = pickVideo(master, parseInt(quality, 10) || 0);

      var vPlaylistUrl = new URL(video.uri, ep.hls).href;
      var aPlaylistUrl = new URL(audio.uri, ep.hls).href;

      var vSeg = parseMediaPlaylist(await httpText(vPlaylistUrl), vPlaylistUrl);
      var aSeg = parseMediaPlaylist(await httpText(aPlaylistUrl), aPlaylistUrl);

      var serialTitle = sanitizeName(data.title);
      var epTitle = 'S' + String(ep.season).padStart(2, '0') + 'E' + String(ep.episode).padStart(2, '0');
      var dubTitle = sanitizeName(audio.name);
      var finalName = serialTitle + ' - ' + epTitle + ' - ' + dubTitle + '.mkv';
      var destPath = path.join(VIDEOS_DIR, finalName);

      dlState.filename = finalName;
      console.log('[HDSTUDIO] Начало скачивания сегментов: ' + finalName);

      var vDir = path.join(workDir, 'v');
      var aDir = path.join(workDir, 'a');
      await fsp.mkdir(vDir, { recursive: true });
      await fsp.mkdir(aDir, { recursive: true });

      var prog = { vDone: 0, aDone: 0, vBytes: 0, aBytes: 0 };
      var totalSegments = vSeg.length + aSeg.length;
      var lastBytes = 0;
      var lastTime = Date.now();

      var speedTimer = setInterval(function() {
        var now = Date.now();
        var dt = (now - lastTime) / 1000;
        if (dt >= 0.7) {
          var curBytes = prog.vBytes + prog.aBytes;
          var bps = (curBytes - lastBytes) / dt;
          dlState.speed = (bps / (1024 * 1024)).toFixed(2) + ' MB/s';
          lastBytes = curBytes;
          lastTime = now;
        }
      }, 700);

      function updateProgress() {
        var curDone = prog.vDone + prog.aDone;
        var curBytes = prog.vBytes + prog.aBytes;
        dlState.percent = totalSegments > 0 ? Math.min(99, Math.round((curDone / totalSegments) * 100)) : 0;
        dlState.receivedMb = (curBytes / (1024 * 1024)).toFixed(1);
        dlState.totalMb = '?';
      }

      await Promise.all([
        downloadTrack(vSeg, vDir, HD_CONCURRENCY, function(d, t, b) {
          prog.vDone = d;
          prog.vBytes = b;
          updateProgress();
        }),
        downloadTrack(aSeg, aDir, HD_CONCURRENCY, function(d, t, b) {
          prog.aDone = d;
          prog.aBytes = b;
          updateProgress();
        })
      ]);

      clearInterval(speedTimer);
      dlState.speed = 'Сборка MKV (ffmpeg)...';
      console.log('[HDSTUDIO] Сегменты скачаны. Сборка MKV...');

      // Генерируем абсолютные списки для concat без сбоев путей в Windows
      var vLines = [];
      for (var vi = 0; vi < vSeg.length; vi++) {
        var vAbs = path.join(vDir, "seg-" + String(vi).padStart(5, "0") + ".ts").replace(/\\/g, "/");
        vLines.push("file '" + vAbs + "'");
      }
      var aLines = [];
      for (var ai = 0; ai < aSeg.length; ai++) {
        var aAbs = path.join(aDir, "seg-" + String(ai).padStart(5, "0") + ".ts").replace(/\\/g, "/");
        aLines.push("file '" + aAbs + "'");
      }

      var vListFile = path.join(workDir, 'v.list');
      var aListFile = path.join(workDir, 'a.list');
      await fsp.writeFile(vListFile, vLines.join("\n") + "\n", 'utf8');
      await fsp.writeFile(aListFile, aLines.join("\n") + "\n", 'utf8');

      await runFfmpegConcat(vListFile, aListFile, destPath);

      // Очистка временных файлов
      try {
        await fsp.rm(workDir, { recursive: true, force: true });
      } catch(e) {}

      dlState.status = 'done';
      dlState.active = false;
      dlState.percent = 100;
      dlState.speed = '0 MB/s';
      console.log('[HDSTUDIO] Успешно готов файл: ' + finalName);
    } catch (err) {
      console.error('[HDSTUDIO] Ошибка:', err.message);
      dlState.status = 'error';
      dlState.active = false;
      dlState.errorMsg = err.message;
      try {
        await fsp.rm(workDir, { recursive: true, force: true });
      } catch(e) {}
    }
  })();

  return { success: true };
}

// -------------------------------------------------------------
// СТРИМИНГ И ПОСТЕРЫ
// -------------------------------------------------------------
function streamVideo(videoFile, req, res) {
  var safeName = path.basename(videoFile);
  var filePath = path.join(VIDEOS_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Видеофайл не найден: ' + safeName);
    return;
  }

  var stats = fs.statSync(filePath);
  var fileSize = stats.size;
  var range = req.headers.range;
  var ext = path.extname(filePath).toLowerCase();

  var mimeMap = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4'
  };
  var contentType = mimeMap[ext] || 'video/mp4';

  if (range) {
    var parts = range.replace(/bytes=/, '').split('-');
    var start = parseInt(parts[0], 10);
    var end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + fileSize });
      return res.end();
    }

    var chunksize = (end - start) + 1;
    var file = fs.createReadStream(filePath, { start: start, end: end });

    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

function serveThumbnail(videoFile, res) {
  var safeName = path.basename(videoFile);
  var ext = path.extname(safeName);
  var baseName = path.basename(safeName, ext);

  var customJpg = path.join(VIDEOS_DIR, baseName + '.jpg');
  var customPng = path.join(VIDEOS_DIR, baseName + '.png');
  if (fs.existsSync(customJpg)) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(customJpg).pipe(res);
    return;
  }
  if (fs.existsSync(customPng)) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fs.createReadStream(customPng).pipe(res);
    return;
  }

  var cachedThumb = path.join(THUMBS_DIR, baseName + '.jpg');
  if (fs.existsSync(cachedThumb)) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(cachedThumb).pipe(res);
    return;
  }

  var fullVideoPath = path.join(VIDEOS_DIR, safeName);
  child_process.execFile('ffmpeg', [
    '-ss', '00:00:05',
    '-i', fullVideoPath,
    '-vframes', '1',
    '-q:v', '4',
    '-y',
    cachedThumb
  ], function(err) {
    if (!err && fs.existsSync(cachedThumb)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      fs.createReadStream(cachedThumb).pipe(res);
    } else {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">' +
        '<defs>' +
        '  <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">' +
        '    <stop offset="0%" stop-color="#18181c"/>' +
        '    <stop offset="100%" stop-color="#0a0a0c"/>' +
        '  </linearGradient>' +
        '</defs>' +
        '<rect width="100%" height="100%" fill="url(#bg)"/>' +
        '<circle cx="320" cy="160" r="50" fill="#25252b"/>' +
        '<polygon points="310,140 340,160 310,180" fill="#0084ff"/>' +
        '<text x="320" y="260" font-family="sans-serif" font-size="20" font-weight="bold" fill="#f0f0f0" text-anchor="middle">' +
        baseName.substring(0, 32) +
        '</text>' +
        '</svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(svg);
    }
  });
}

// -------------------------------------------------------------
// HTML ГЛАВНОЙ СТРАНИЦЫ
// -------------------------------------------------------------
function renderCatalogHTML(videos) {
  var cardsHtml = '';
  if (videos.length === 0) {
    cardsHtml = '<div class="empty-msg">' +
      '<h2>Видеофайлы не найдены</h2>' +
      '<p>Используйте панель внизу, чтобы скачать видео или сериал прямо на сервер.</p>' +
      '</div>';
  } else {
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      var cleanExt = v.ext.replace('.', '').toUpperCase();
      cardsHtml += '<a class="card" tabindex="0" href="/player?v=' + encodeURIComponent(v.filename) + '">' +
        '  <div class="thumb-wrap">' +
        '    <img src="/thumb?v=' + encodeURIComponent(v.filename) + '" alt="' + v.title + '">' +
        '    <span class="fmt-badge">' + cleanExt + '</span>' +
        '    <span class="size-badge">' + v.sizeMb + ' MB</span>' +
        '    <div class="play-overlay">' +
        '      <svg width="34" height="34" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>' +
        '    </div>' +
        '  </div>' +
        '  <div class="card-info">' +
        '    <div class="title">' + v.title + '</div>' +
        '  </div>' +
        '</a>\n';
    }
  }

  return '<!DOCTYPE html>\n' +
  '<html lang="ru">\n' +
  '<head>\n' +
  '  <meta charset="utf-8">\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
  '  <title>Видеотека</title>\n' +
  '  <style>\n' +
  '    * { margin:0; padding:0; box-sizing:border-box; }\n' +
  '    body {\n' +
  '      background-color: #0b0b0e;\n' +
  '      background-image: radial-gradient(ellipse at 50% 0%, #181b26 0%, #0b0b0e 75%);\n' +
  '      color: #e5e5ea;\n' +
  '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
  '      padding: 30px 45px 190px 45px;\n' +
  '      min-height: 100vh;\n' +
  '    }\n' +
  '    header {\n' +
  '      display: flex;\n' +
  '      align-items: center;\n' +
  '      justify-content: space-between;\n' +
  '      margin-bottom: 25px;\n' +
  '      padding-bottom: 12px;\n' +
  '      border-bottom: 1px solid rgba(255,255,255,0.06);\n' +
  '    }\n' +
  '    .top-pill {\n' +
  '      display: inline-flex;\n' +
  '      align-items: center;\n' +
  '      background: rgba(255, 255, 255, 0.05);\n' +
  '      border: 1px solid rgba(255, 255, 255, 0.1);\n' +
  '      padding: 6px 14px;\n' +
  '      border-radius: 20px;\n' +
  '      font-size: 13px;\n' +
  '      color: #9d9da8;\n' +
  '      font-weight: 500;\n' +
  '    }\n' +
  '    .grid { display: flex; flex-wrap: wrap; margin: -12px; }\n' +
  '    .card {\n' +
  '      width: 270px; margin: 12px; background: #141418; border-radius: 12px; overflow: hidden;\n' +
  '      text-decoration: none; color: inherit; border: 2px solid transparent; display: block; outline: none;\n' +
  '      box-shadow: 0 4px 15px rgba(0,0,0,0.4); transition: all 0.2s ease;\n' +
  '    }\n' +
  '    .card:focus, .card:hover {\n' +
  '      border-color: #0084ff; transform: scale(1.05); background: #1c1c22;\n' +
  '      box-shadow: 0 12px 30px rgba(0, 132, 255, 0.35);\n' +
  '    }\n' +
  '    .thumb-wrap { width: 100%; height: 152px; position: relative; background: #000; overflow: hidden; }\n' +
  '    .thumb-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }\n' +
  '    .fmt-badge { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.75); border: 1px solid rgba(255,255,255,0.15); color: #00a8ff; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }\n' +
  '    .size-badge { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: #d1d1d6; font-size: 11px; padding: 2px 7px; border-radius: 4px; font-weight: 600; }\n' +
  '    .play-overlay { position: absolute; inset: 0; background: rgba(0, 132, 255, 0.45); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s; }\n' +
  '    .card:focus .play-overlay, .card:hover .play-overlay { opacity: 1; }\n' +
  '    .card-info { padding: 14px 16px; }\n' +
  '    .title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f2f2f7; }\n' +
  '    .empty-msg { text-align: center; width: 100%; padding: 70px 20px; color: #777; }\n' +
  '    \n' +
  '    /* ПАНЕЛЬ СКАЧИВАНИЯ С ВКЛАДКАМИ */\n' +
  '    .dl-bar {\n' +
  '      position: fixed; bottom: 0; left: 0; right: 0; background: rgba(18, 18, 23, 0.96);\n' +
  '      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);\n' +
  '      border-top: 1px solid rgba(255,255,255,0.1); padding: 12px 35px 16px 35px; z-index: 100;\n' +
  '      display: flex; flex-direction: column; gap: 10px;\n' +
  '      box-shadow: 0 -8px 30px rgba(0,0,0,0.6);\n' +
  '    }\n' +
  '    .dl-tabs { display: flex; gap: 8px; align-items: center; }\n' +
  '    .tab-btn {\n' +
  '      background: transparent; border: 1px solid rgba(255,255,255,0.12); color: #8e8e93;\n' +
  '      padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;\n' +
  '      transition: all 0.2s;\n' +
  '    }\n' +
  '    .tab-btn:hover { background: rgba(255,255,255,0.06); color: #fff; }\n' +
  '    .tab-btn.active {\n' +
  '      background: #0084ff; border-color: #0084ff; color: #fff;\n' +
  '    }\n' +
  '    .dl-form { display: flex; gap: 10px; align-items: center; width: 100%; }\n' +
  '    .dl-input {\n' +
  '      background: #0f0f13; border: 1px solid #2d2d38; color: #fff;\n' +
  '      padding: 9px 12px; border-radius: 8px; font-size: 13px; outline: none;\n' +
  '      transition: border-color 0.2s;\n' +
  '    }\n' +
  '    .dl-input:focus { border-color: #0084ff; }\n' +
  '    .dl-url { flex: 2; }\n' +
  '    .dl-name { flex: 1; min-width: 170px; }\n' +
  '    .dl-btn {\n' +
  '      background: #0084ff; color: #fff; border: none; padding: 9px 20px;\n' +
  '      border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 13px;\n' +
  '      display: flex; align-items: center; gap: 6px; transition: background 0.2s, transform 0.1s; white-space: nowrap;\n' +
  '    }\n' +
  '    .dl-btn:hover { background: #0070d6; }\n' +
  '    .dl-btn:active { transform: scale(0.97); }\n' +
  '    .dl-btn:disabled { background: #444; cursor: not-allowed; }\n' +
  '    .btn-secondary { background: #2c2c34; color: #e5e5ea; }\n' +
  '    .btn-secondary:hover { background: #383842; }\n' +
  '    \n' +
  '    /* HDSTUDIO ПАНЕЛЬ ВЫБОРА */\n' +
  '    .serial-box { display: flex; flex-direction: column; gap: 8px; width: 100%; }\n' +
  '    .serial-opts {\n' +
  '      display: none; flex-wrap: wrap; gap: 10px; align-items: center;\n' +
  '      background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);\n' +
  '    }\n' +
  '    .opt-item { display: flex; flex-direction: column; gap: 3px; }\n' +
  '    .opt-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #8e8e93; font-weight: 700; }\n' +
  '    .dl-select { min-width: 140px; cursor: pointer; }\n' +
  '    \n' +
  '    /* ПРОГРЕСС-БАР */\n' +
  '    .progress-box { display: none; width: 100%; flex-direction: column; gap: 4px; }\n' +
  '    .p-track { width: 100%; height: 7px; background: rgba(255,255,255,0.12); border-radius: 4px; overflow: hidden; }\n' +
  '    .p-fill { height: 100%; width: 0%; background: #0084ff; transition: width 0.3s linear; }\n' +
  '    .p-info { display: flex; justify-content: space-between; font-size: 12px; color: #aaa; }\n' +
  '  </style>\n' +
  '</head>\n' +
  '<body>\n' +
  '  <header>\n' +
  '    <div class="top-pill">🎬 Видеотека</div>\n' +
  '    <div class="top-pill">Всего видео: ' + videos.length + '</div>\n' +
  '  </header>\n' +
  '  <div class="grid" id="grid">\n' +
  '    ' + cardsHtml + '\n' +
  '  </div>\n' +
  '  \n' +
  '  <div class="dl-bar">\n' +
  '    <div class="dl-tabs">\n' +
  '      <button class="tab-btn active" id="tab-direct-btn" onclick="setDlTab(\'direct\')">🔗 Прямая ссылка (URL)</button>\n' +
  '      <button class="tab-btn" id="tab-hd-btn" onclick="setDlTab(\'hd\')">📺 Сериал (hdstudio.org)</button>\n' +
  '    </div>\n' +
  '    \n' +
  '    <!-- Режим 1: Обычный URL -->\n' +
  '    <div class="dl-form" id="form-direct">\n' +
  '      <input class="dl-input dl-url" id="inp-url" type="text" placeholder="Прямая ссылка на файл (https://.../video.mp4)">\n' +
  '      <input class="dl-input dl-name" id="inp-name" type="text" placeholder="Название (необязательно)">\n' +
  '      <button class="dl-btn" id="btn-dl-direct" onclick="triggerDirectDownload()">\n' +
  '        Скачать\n' +
  '      </button>\n' +
  '    </div>\n' +
  '    \n' +
  '    <!-- Режим 2: HDStudio Сериал -->\n' +
  '    <div class="serial-box" id="form-hd" style="display:none;">\n' +
  '      <div class="dl-form">\n' +
  '        <input class="dl-input dl-url" id="inp-hd-url" type="text" placeholder="Ссылка на сериал (http://hdstudio.org/serial/...)" oninput="checkAutoDetect(this.value)">\n' +
  '        <button class="dl-btn btn-secondary" id="btn-hd-parse" onclick="loadSerialData()">\n' +
  '          🔍 Получить серии\n' +
  '        </button>\n' +
  '      </div>\n' +
  '      <div class="serial-opts" id="hd-opts">\n' +
  '        <div class="opt-item">\n' +
  '          <span class="opt-label">Сезон</span>\n' +
  '          <select class="dl-input dl-select" id="sel-season" onchange="onSeasonChanged()"></select>\n' +
  '        </div>\n' +
  '        <div class="opt-item">\n' +
  '          <span class="opt-label">Серия</span>\n' +
  '          <select class="dl-input dl-select" id="sel-episode" onchange="onEpisodeChanged()"></select>\n' +
  '        </div>\n' +
  '        <div class="opt-item">\n' +
  '          <span class="opt-label">Озвучка (Дубляж)</span>\n' +
  '          <select class="dl-input dl-select" id="sel-dub"></select>\n' +
  '        </div>\n' +
  '        <div class="opt-item">\n' +
  '          <span class="opt-label">Качество</span>\n' +
  '          <select class="dl-input dl-select" id="sel-quality">\n' +
  '            <option value="0">Максимальное (Лучшее)</option>\n' +
  '            <option value="1080">1080p FHD</option>\n' +
  '            <option value="720">720p HD</option>\n' +
  '            <option value="480">480p SD</option>\n' +
  '            <option value="360">360p</option>\n' +
  '          </select>\n' +
  '        </div>\n' +
  '        <button class="dl-btn" id="btn-dl-hd" style="margin-top: 14px;" onclick="triggerSerialDownload()">\n' +
  '          ⬇ Скачать серию\n' +
  '        </button>\n' +
  '      </div>\n' +
  '    </div>\n' +
  '    \n' +
  '    <!-- Прогресс скачивания -->\n' +
  '    <div class="progress-box" id="p-box">\n' +
  '      <div class="p-track"><div class="p-fill" id="p-fill"></div></div>\n' +
  '      <div class="p-info">\n' +
  '        <span id="p-file">Загрузка...</span>\n' +
  '        <span id="p-meta">0% • 0 / 0 MB • 0 MB/s</span>\n' +
  '      </div>\n' +
  '    </div>\n' +
  '  </div>\n' +
  '  \n' +
  '  <script>\n' +
  '    var currentSeasons = [];\n' +
  '    var pBox = document.getElementById("p-box");\n' +
  '    var pFill = document.getElementById("p-fill");\n' +
  '    var pFile = document.getElementById("p-file");\n' +
  '    var pMeta = document.getElementById("p-meta");\n' +
  '    var btnDlDirect = document.getElementById("btn-dl-direct");\n' +
  '    var btnDlHd = document.getElementById("btn-dl-hd");\n' +
  '    var btnHdParse = document.getElementById("btn-hd-parse");\n' +
  '    \n' +
  '    function setDlTab(tab) {\n' +
  '      document.getElementById("tab-direct-btn").className = tab === "direct" ? "tab-btn active" : "tab-btn";\n' +
  '      document.getElementById("tab-hd-btn").className = tab === "hd" ? "tab-btn active" : "tab-btn";\n' +
  '      document.getElementById("form-direct").style.display = tab === "direct" ? "flex" : "none";\n' +
  '      document.getElementById("form-hd").style.display = tab === "hd" ? "flex" : "none";\n' +
  '    }\n' +
  '    \n' +
  '    function checkAutoDetect(val) {\n' +
  '      if (val.indexOf("hdstudio.org") !== -1 && document.getElementById("tab-hd-btn").className.indexOf("active") === -1) {\n' +
  '        setDlTab("hd");\n' +
  '      }\n' +
  '    }\n' +
  '    \n' +
  '    function loadSerialData() {\n' +
  '      var u = document.getElementById("inp-hd-url").value.trim();\n' +
  '      if (!u) { alert("Вставьте ссылку на страницу сериала hdstudio.org"); return; }\n' +
  '      btnHdParse.disabled = true;\n' +
  '      btnHdParse.textContent = "⏳ Анализ...";\n' +
  '      \n' +
  '      fetch("/api/serial-info?url=" + encodeURIComponent(u))\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(data) {\n' +
  '          btnHdParse.disabled = false;\n' +
  '          btnHdParse.textContent = "🔍 Получить серии";\n' +
  '          if (!data.success) {\n' +
  '            alert("Ошибка загрузки: " + data.msg);\n' +
  '            return;\n' +
  '          }\n' +
  '          currentSeasons = data.seasons || [];\n' +
  '          if (currentSeasons.length === 0) {\n' +
  '            alert("В сериале не найдены доступные сезоны/серии.");\n' +
  '            return;\n' +
  '          }\n' +
  '          \n' +
  '          var sSel = document.getElementById("sel-season");\n' +
  '          sSel.innerHTML = "";\n' +
  '          for (var i = 0; i < currentSeasons.length; i++) {\n' +
  '            var opt = document.createElement("option");\n' +
  '            opt.value = currentSeasons[i].season;\n' +
  '            opt.textContent = "Сезон " + currentSeasons[i].season + " (" + currentSeasons[i].episodes.length + " сер.)";\n' +
  '            sSel.appendChild(opt);\n' +
  '          }\n' +
  '          \n' +
  '          document.getElementById("hd-opts").style.display = "flex";\n' +
  '          onSeasonChanged();\n' +
  '        })\n' +
  '        .catch(function(err) {\n' +
  '          btnHdParse.disabled = false;\n' +
  '          btnHdParse.textContent = "🔍 Получить серии";\n' +
  '          alert("Сбой соединения: " + err.message);\n' +
  '        });\n' +
  '    }\n' +
  '    \n' +
  '    function onSeasonChanged() {\n' +
  '      var sVal = parseInt(document.getElementById("sel-season").value, 10);\n' +
  '      var seasonObj = currentSeasons.find(function(s) { return s.season === sVal; });\n' +
  '      var eSel = document.getElementById("sel-episode");\n' +
  '      eSel.innerHTML = "";\n' +
  '      if (!seasonObj) return;\n' +
  '      \n' +
  '      for (var i = 0; i < seasonObj.episodes.length; i++) {\n' +
  '        var ep = seasonObj.episodes[i];\n' +
  '        var opt = document.createElement("option");\n' +
  '        opt.value = ep.episode;\n' +
  '        opt.textContent = "Серия " + ep.episode + (ep.blocked ? " [Блок]" : "");\n' +
  '        eSel.appendChild(opt);\n' +
  '      }\n' +
  '      onEpisodeChanged();\n' +
  '    }\n' +
  '    \n' +
  '    function onEpisodeChanged() {\n' +
  '      var sVal = parseInt(document.getElementById("sel-season").value, 10);\n' +
  '      var eVal = parseInt(document.getElementById("sel-episode").value, 10);\n' +
  '      var seasonObj = currentSeasons.find(function(s) { return s.season === sVal; });\n' +
  '      if (!seasonObj) return;\n' +
  '      var epObj = seasonObj.episodes.find(function(e) { return e.episode === eVal; });\n' +
  '      \n' +
  '      var dSel = document.getElementById("sel-dub");\n' +
  '      dSel.innerHTML = "";\n' +
  '      var dubs = (epObj && epObj.dubs && epObj.dubs.length) ? epObj.dubs : ["Стандартная"];\n' +
  '      for (var i = 0; i < dubs.length; i++) {\n' +
  '        var opt = document.createElement("option");\n' +
  '        opt.value = dubs[i];\n' +
  '        opt.textContent = dubs[i];\n' +
  '        dSel.appendChild(opt);\n' +
  '      }\n' +
  '    }\n' +
  '    \n' +
  '    function triggerDirectDownload() {\n' +
  '      var urlVal = document.getElementById("inp-url").value.trim();\n' +
  '      var nameVal = document.getElementById("inp-name").value.trim();\n' +
  '      if (!urlVal) { alert("Вставьте ссылку на файл!"); return; }\n' +
  '      btnDlDirect.disabled = true;\n' +
  '      fetch("/api/download-start?url=" + encodeURIComponent(urlVal) + "&name=" + encodeURIComponent(nameVal))\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(res) {\n' +
  '          if (!res.success) { alert(res.msg); btnDlDirect.disabled = false; }\n' +
  '          else { document.getElementById("inp-url").value = ""; }\n' +
  '        });\n' +
  '    }\n' +
  '    \n' +
  '    function triggerSerialDownload() {\n' +
  '      var urlVal = document.getElementById("inp-hd-url").value.trim();\n' +
  '      var season = document.getElementById("sel-season").value;\n' +
  '      var episode = document.getElementById("sel-episode").value;\n' +
  '      var dub = document.getElementById("sel-dub").value;\n' +
  '      var quality = document.getElementById("sel-quality").value;\n' +
  '      \n' +
  '      if (!urlVal || !season || !episode) { alert("Выберите параметры серии!"); return; }\n' +
  '      btnDlHd.disabled = true;\n' +
  '      \n' +
  '      var qStr = "/api/download-serial?url=" + encodeURIComponent(urlVal) +\n' +
  '        "&season=" + encodeURIComponent(season) +\n' +
  '        "&episode=" + encodeURIComponent(episode) +\n' +
  '        "&dub=" + encodeURIComponent(dub) +\n' +
  '        "&quality=" + encodeURIComponent(quality);\n' +
  '        \n' +
  '      fetch(qStr)\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(res) {\n' +
  '          if (!res.success) { alert(res.msg); btnDlHd.disabled = false; }\n' +
  '        });\n' +
  '    }\n' +
  '    \n' +
  '    function checkStatus() {\n' +
  '      fetch("/api/download-status")\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(data) {\n' +
  '          if (data.status === "downloading") {\n' +
  '            btnDlDirect.disabled = true;\n' +
  '            btnDlHd.disabled = true;\n' +
  '            pBox.style.display = "flex";\n' +
  '            pFill.style.width = data.percent + "%";\n' +
  '            pFile.textContent = "Скачивается: " + data.filename;\n' +
  '            pMeta.textContent = data.percent + "% • " + data.receivedMb + " / " + data.totalMb + " MB • " + data.speed;\n' +
  '          } else if (data.status === "done") {\n' +
  '            btnDlDirect.disabled = false;\n' +
  '            btnDlHd.disabled = false;\n' +
  '            pFill.style.width = "100%";\n' +
  '            pFile.textContent = "✅ Скачано: " + data.filename;\n' +
  '            pMeta.textContent = "Обновление страницы...";\n' +
  '            setTimeout(function() { window.location.reload(); }, 1500);\n' +
  '          } else if (data.status === "error") {\n' +
  '            btnDlDirect.disabled = false;\n' +
  '            btnDlHd.disabled = false;\n' +
  '            pFile.textContent = "❌ Ошибка: " + data.errorMsg;\n' +
  '          } else {\n' +
  '            pBox.style.display = "none";\n' +
  '            btnDlDirect.disabled = false;\n' +
  '            btnDlHd.disabled = false;\n' +
  '          }\n' +
  '        });\n' +
  '    }\n' +
  '    \n' +
  '    setInterval(checkStatus, 1000);\n' +
  '    checkStatus();\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}

// -------------------------------------------------------------
// HTML ПЛЕЕРА
// -------------------------------------------------------------
function renderPlayerHTML(videoFilename) {
  var ext = path.extname(videoFilename);
  var title = path.basename(videoFilename, ext);
  var mimeType = ext.toLowerCase() === '.mkv' ? 'video/x-matroska' : 'video/mp4';

  return '<!DOCTYPE html>\n' +
  '<html lang="ru">\n' +
  '<head>\n' +
  '  <meta charset="utf-8">\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
  '  <title>' + title + '</title>\n' +
  '  <style>\n' +
  '    * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
  '    body, html { width: 100%; height: 100%; overflow: hidden; background: #000; font-family: sans-serif; }\n' +
  '    .player-root { position: relative; width: 100%; height: 100%; background: #000; display: flex; align-items: center; justify-content: center; cursor: none; }\n' +
  '    .player-root.show-ui { cursor: default; }\n' +
  '    video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }\n' +
  '    .spinner { position: absolute; width: 60px; height: 60px; border: 4px solid rgba(255,255,255,0.15); border-top-color: #0084ff; border-radius: 50%; animation: spin 0.9s infinite linear; pointer-events: none; z-index: 20; display: none; }\n' +
  '    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }\n' +
  '    .top-bar { position: absolute; top: 0; left: 0; right: 0; height: 85px; background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent); display: flex; align-items: center; padding: 0 35px; z-index: 30; opacity: 0; transition: opacity 0.3s ease; }\n' +
  '    .back-btn { width: 44px; height: 44px; border: 0; border-radius: 50%; background: rgba(255,255,255,0.15); cursor: pointer; display: flex; align-items: center; justify-content: center; margin-right: 18px; transition: background 0.2s; }\n' +
  '    .back-btn:hover { background: #0084ff; }\n' +
  '    .video-title { color: #fff; font-size: 18px; font-weight: 600; text-shadow: 0 2px 5px rgba(0,0,0,0.9); }\n' +
  '    .bottom-bar { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, rgba(0,0,0,0.92), transparent); padding: 20px 35px 25px 35px; z-index: 30; opacity: 0; transition: opacity 0.3s ease; }\n' +
  '    .show-ui .top-bar, .show-ui .bottom-bar { opacity: 1; }\n' +
  '    .timeline-container { position: relative; width: 100%; height: 16px; cursor: pointer; display: flex; align-items: center; margin-bottom: 12px; }\n' +
  '    .timeline-track { width: 100%; height: 5px; background: rgba(255,255,255,0.22); border-radius: 4px; position: relative; overflow: hidden; }\n' +
  '    .timeline-progress { height: 100%; width: 0%; background: #0084ff; position: absolute; top: 0; left: 0; }\n' +
  '    .controls-row { display: flex; align-items: center; justify-content: space-between; }\n' +
  '    .left-controls, .right-controls { display: flex; align-items: center; }\n' +
  '    .ctrl-btn { width: 42px; height: 42px; border: 0; border-radius: 50%; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; margin: 0 4px; }\n' +
  '    .ctrl-btn:hover { background: rgba(255,255,255,0.2); }\n' +
  '    .time-display { color: #aaa; font-size: 14px; margin-left: 12px; font-weight: 500; }\n' +
  '  </style>\n' +
  '</head>\n' +
  '<body>\n' +
  '  <div class="player-root show-ui" id="player-root">\n' +
  '    <video id="vid" preload="auto">\n' +
  '      <source src="/stream?v=' + encodeURIComponent(videoFilename) + '" type="' + mimeType + '">\n' +
  '    </video>\n' +
  '    <div class="spinner" id="spinner"></div>\n' +
  '    <div class="top-bar">\n' +
  '      <button class="back-btn" onclick="window.location.href=\'/\'" title="Назад">\n' +
  '        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>\n' +
  '      </button>\n' +
  '      <div class="video-title">' + title + '</div>\n' +
  '    </div>\n' +
  '    <div class="bottom-bar">\n' +
  '      <div class="timeline-container" id="timeline" onclick="handleSeek(event)">\n' +
  '        <div class="timeline-track">\n' +
  '          <div class="timeline-progress" id="progress"></div>\n' +
  '        </div>\n' +
  '      </div>\n' +
  '      <div class="controls-row">\n' +
  '        <div class="left-controls">\n' +
  '          <button class="ctrl-btn" id="btn-play" onclick="togglePlay()">\n' +
  '            <svg id="icon-play" width="26" height="26" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>\n' +
  '            <svg id="icon-pause" width="26" height="26" viewBox="0 0 24 24" fill="#fff" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>\n' +
  '          </button>\n' +
  '          <button class="ctrl-btn" onclick="seek(-10)" title="-10 сек">\n' +
  '            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="15" font-size="7" font-weight="bold" fill="#fff" text-anchor="middle">10</text></svg>\n' +
  '          </button>\n' +
  '          <button class="ctrl-btn" onclick="seek(10)" title="+10 сек">\n' +
  '            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="15" font-size="7" font-weight="bold" fill="#fff" text-anchor="middle">10</text></svg>\n' +
  '          </button>\n' +
  '          <div class="time-display" id="time-display">00:00 / 00:00</div>\n' +
  '        </div>\n' +
  '        <div class="right-controls">\n' +
  '          <button class="ctrl-btn" onclick="toggleFullscreen()">\n' +
  '            <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>\n' +
  '          </button>\n' +
  '        </div>\n' +
  '      </div>\n' +
  '    </div>\n' +
  '  </div>\n' +
  '  <script>\n' +
  '    var vid = document.getElementById("vid");\n' +
  '    var root = document.getElementById("player-root");\n' +
  '    var spinner = document.getElementById("spinner");\n' +
  '    var progress = document.getElementById("progress");\n' +
  '    var timeDisplay = document.getElementById("time-display");\n' +
  '    var iconPlay = document.getElementById("icon-play");\n' +
  '    var iconPause = document.getElementById("icon-pause");\n' +
  '    var hideTimer = null;\n' +
  '    \n' +
  '    function showUI() {\n' +
  '      root.className = "player-root show-ui";\n' +
  '      clearTimeout(hideTimer);\n' +
  '      if (!vid.paused) {\n' +
  '        hideTimer = setTimeout(function() { root.className = "player-root"; }, 3500);\n' +
  '      }\n' +
  '    }\n' +
  '    window.addEventListener("mousemove", showUI);\n' +
  '    function togglePlay() {\n' +
  '      if (vid.paused) vid.play(); else vid.pause();\n' +
  '      showUI();\n' +
  '    }\n' +
  '    function seek(sec) {\n' +
  '      vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + sec));\n' +
  '      showUI();\n' +
  '    }\n' +
  '    function handleSeek(e) {\n' +
  '      var rect = e.currentTarget.getBoundingClientRect();\n' +
  '      var pos = (e.clientX - rect.left) / rect.width;\n' +
  '      if (vid.duration) vid.currentTime = pos * vid.duration;\n' +
  '      showUI();\n' +
  '    }\n' +
  '    function fmt(s) {\n' +
  '      if (isNaN(s)) return "00:00";\n' +
  '      var m = Math.floor(s / 60); var sec = Math.floor(s % 60);\n' +
  '      return (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;\n' +
  '    }\n' +
  '    function toggleFullscreen() {\n' +
  '      if (root.requestFullscreen) root.requestFullscreen();\n' +
  '      else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();\n' +
  '    }\n' +
  '    vid.addEventListener("play", function() { iconPlay.style.display = "none"; iconPause.style.display = "block"; showUI(); });\n' +
  '    vid.addEventListener("pause", function() { iconPlay.style.display = "block"; iconPause.style.display = "none"; showUI(); });\n' +
  '    vid.addEventListener("timeupdate", function() {\n' +
  '      if (vid.duration) {\n' +
  '        progress.style.width = ((vid.currentTime / vid.duration) * 100) + "%";\n' +
  '        timeDisplay.textContent = fmt(vid.currentTime) + " / " + fmt(vid.duration);\n' +
  '      }\n' +
  '    });\n' +
  '    vid.addEventListener("waiting", function() { spinner.style.display = "block"; });\n' +
  '    vid.addEventListener("canplay", function() { spinner.style.display = "none"; });\n' +
  '    window.addEventListener("keydown", function(e) {\n' +
  '      var k = e.keyCode || e.which;\n' +
  '      showUI();\n' +
  '      if (k === 32 || k === 13) togglePlay();\n' +
  '      else if (k === 37) seek(-10);\n' +
  '      else if (k === 39) seek(10);\n' +
  '      else if (k === 27) window.location.href = "/";\n' +
  '    });\n' +
  '    vid.play();\n' +
  '    showUI();\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}

// -------------------------------------------------------------
// HTTP СЕРВЕР И РОУТЫ
// -------------------------------------------------------------
var server = http.createServer(async function(req, res) {
  var urlParts = req.url.split('?');
  var pathname = urlParts[0];
  var queryStr = urlParts[1] || '';

  var query = {};
  var pairs = queryStr.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var p = pairs[i].split('=');
    if (p.length === 2) {
      try {
        query[decodeURIComponent(p[0])] = decodeURIComponent(p[1].replace(/\+/g, ' '));
      } catch(e) {
        query[p[0]] = p[1];
      }
    }
  }

  // API: Парсинг структуры сериала с hdstudio
  if (pathname === '/api/serial-info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    var targetUrl = query.url;
    if (!targetUrl) {
      res.end(JSON.stringify({ success: false, msg: 'URL не передан' }));
      return;
    }
    try {
      var data = await loadSerial(targetUrl);
      var seasons = seasonsOf(data.playlist).map(function(s) {
        return {
          season: s.season,
          episodes: s.episodes.map(function(e) {
            return {
              episode: parseInt(e.episode, 10),
              title: e.title || ('Серия ' + e.episode),
              dubs: (e.audio && e.audio.names) ? e.audio.names : [],
              blocked: !!e.blocked
            };
          })
        };
      });

      res.end(JSON.stringify({
        success: true,
        title: data.title,
        siteDub: data.siteDub,
        seasons: seasons
      }));
    } catch(err) {
      res.end(JSON.stringify({ success: false, msg: err.message }));
    }
    return;
  }

  // API: Запуск скачивания серии сериала
  if (pathname === '/api/download-serial') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    var sUrl = query.url;
    var season = query.season;
    var episode = query.episode;
    var dub = query.dub;
    var quality = query.quality;

    if (!sUrl || !season || !episode) {
      res.end(JSON.stringify({ success: false, msg: 'Не все параметры переданы (url, season, episode)' }));
      return;
    }

    var result = await startSerialDownload(sUrl, season, episode, dub, quality);
    res.end(JSON.stringify(result));
    return;
  }

  // API: Запуск скачивания по прямой ссылке
  if (pathname === '/api/download-start') {
    var dlUrl = query.url;
    var dlTitle = query.name;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!dlUrl) {
      res.end(JSON.stringify({ success: false, msg: 'URL не передан' }));
      return;
    }
    var resStart = startFileDownload(dlUrl, dlTitle);
    res.end(JSON.stringify(resStart));
    return;
  }

  // API: Статус загрузки
  if (pathname === '/api/download-status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dlState));
    return;
  }

  // API: Логи
  if (pathname === '/api/log') {
    var lvl = query.lvl || 'INFO';
    var msg = query.msg || '';
    var tag = '[ТВ ' + new Date().toLocaleTimeString() + '] [' + lvl + ']';
    if (lvl === 'ERROR') console.log('\x1b[31m%s %s\x1b[0m', tag, msg);
    else console.log('\x1b[36m%s %s\x1b[0m', tag, msg);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Главная страница
  if (pathname === '/' || pathname === '/index.html') {
    var videos = getVideoList();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderCatalogHTML(videos));
    return;
  }

  // Плеер
  if (pathname === '/player') {
    var targetVideo = query.v;
    if (!targetVideo) {
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderPlayerHTML(targetVideo));
    return;
  }

  // Постер
  if (pathname === '/thumb') {
    if (!query.v) { res.writeHead(400); res.end(); return; }
    serveThumbnail(query.v, res);
    return;
  }

  // Стрим видео
  if (pathname === '/stream') {
    if (!query.v) { res.writeHead(400); res.end(); return; }
    streamVideo(query.v, req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

// Запуск сервера
server.listen(PORT, '0.0.0.0', function() {
  console.log('----------------------------------------------------');
  console.log(' Сервер запущен!');
  console.log(' Локальный адрес: http://127.0.0.1:' + PORT);
  console.log(' Сетевой адрес:   http://' + getLocalIP() + ':' + PORT);
  console.log(' Папка видео:     ' + VIDEOS_DIR);
  console.log(' Найдено файлов:  ' + getVideoList().length);
  console.log(' ffmpeg доступен: ' + (checkFfmpeg() ? 'ДА' : 'НЕТ (установите ffmpeg для сериалов!)'));
  console.log('----------------------------------------------------');
});