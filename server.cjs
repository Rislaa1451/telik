var http = require('http');
var https = require('https');
var urlModule = require('url');
var fs = require('fs');
var path = require('path');
var os = require('os');
var child_process = require('child_process');

var PORT = process.env.PORT || 8000;
var BASE_DIR = __dirname;
var VIDEOS_DIR = path.join(BASE_DIR, "videos");
var THUMBS_DIR = path.join(BASE_DIR, ".thumbs");

// Создаем нужные директории, если их еще нет
if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}
if (!fs.existsSync(THUMBS_DIR)) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
}

// Если в папке tvv был test.mp4, а в videos пусто — скопируем его для удобства
var oldTestFile = path.join(BASE_DIR, "test.mp4");
var newTestFile = path.join(VIDEOS_DIR, "test.mp4");
if (fs.existsSync(oldTestFile) && !fs.existsSync(newTestFile)) {
  try {
    fs.copyFileSync(oldTestFile, newTestFile);
    console.log('[ИНФО] Старый test.mp4 автоматически скопирован в папку videos!');
  } catch(e) {}
}

// Получение реального локального IP (без APIPA 169.254.*)
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

// Список видеофайлов
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

// Стриминг видео с Range 206
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
      'Content-Type': 'video/mp4'
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// Генерация / отдача постера (превью)
function serveThumbnail(videoFile, res) {
  var safeName = path.basename(videoFile);
  var ext = path.extname(safeName);
  var baseName = path.basename(safeName, ext);

  // 1. Проверяем, положил ли пользователь рядом свой jpg/png (например movie.jpg)
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

  // 2. Проверяем кэш нарезок ffmpeg
  var cachedThumb = path.join(THUMBS_DIR, baseName + '.jpg');
  if (fs.existsSync(cachedThumb)) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(cachedThumb).pipe(res);
    return;
  }

  // 3. Пытаемся нарезать кадр через ffmpeg (если установлен)
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
      // 4. Запасной стильный SVG-постер (работает всегда без программ)
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
        '<text x="320" y="260" font-family="sans-serif" font-size="22" font-weight="bold" fill="#f0f0f0" text-anchor="middle">' +
        baseName.substring(0, 30) +
        '</text>' +
        '</svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(svg);
    }
  });
}

// -------------------------------------------------------------
// ДВИЖОК СКАЧИВАНИЯ ФАЙЛОВ ПО ССЫЛКЕ
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

function startFileDownload(targetUrl, customTitle) {
  if (dlState.active) {
    return { success: false, msg: 'Загрузка уже идет!' };
  }

  // Определяем расширение и имя файла
  var parsed = urlModule.parse(targetUrl);
  var rawName = path.basename(parsed.pathname || 'video.mp4');
  var ext = path.extname(rawName) || '.mp4';

  var finalName = '';
  if (customTitle && customTitle.trim().length > 0) {
    var clean = customTitle.trim().replace(/[\\/:*?"<>|]/g, '_');
    finalName = clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext;
  } else {
    // Если имя типовое (например 1080.mp4), добавим таймстемп, чтобы не перезатирать
    if (rawName.toLowerCase() === '1080.mp4' || rawName.toLowerCase() === 'video.mp4') {
      finalName = 'Movie_' + Date.now() + '_' + rawName;
    } else {
      finalName = rawName;
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    var req = client.get(reqOptions, function(res) {
      // Поддержка CDN-редиректов (301, 302, 307, 308)
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

// -------------------------------------------------------------
// HTML ГЛАВНОЙ СТРАНИЦЫ (КАТАЛОГ ВИДЕО + СКАЧИВАНИЕ)
// -------------------------------------------------------------
function renderCatalogHTML(videos) {
  var cardsHtml = '';
  if (videos.length === 0) {
    cardsHtml = '<div class="empty-msg">' +
      '<h2>Видеофайлы не найдены</h2>' +
      '<p>Вставьте ссылку внизу, чтобы скачать фильм прямо на сервер.</p>' +
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
  '      padding: 30px 45px 140px 45px;\n' +
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
  '    .top-pill svg { margin-right: 8px; }\n' +
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
  '    /* НИЖНЯЯ ПАНЕЛЬ СКАЧИВАНИЯ */\n' +
  '    .dl-bar {\n' +
  '      position: fixed; bottom: 0; left: 0; right: 0; background: rgba(18, 18, 23, 0.95);\n' +
  '      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);\n' +
  '      border-top: 1px solid rgba(255,255,255,0.1); padding: 14px 35px; z-index: 100;\n' +
  '      display: flex; flex-direction: column; gap: 8px;\n' +
  '      box-shadow: 0 -8px 25px rgba(0,0,0,0.5);\n' +
  '    }\n' +
  '    .dl-form { display: flex; gap: 10px; align-items: center; width: 100%; }\n' +
  '    .dl-input {\n' +
  '      background: #0f0f13; border: 1px solid #2d2d38; color: #fff;\n' +
  '      padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none;\n' +
  '      transition: border-color 0.2s;\n' +
  '    }\n' +
  '    .dl-input:focus { border-color: #0084ff; }\n' +
  '    .dl-url { flex: 2; }\n' +
  '    .dl-name { flex: 1; min-width: 180px; }\n' +
  '    .dl-btn {\n' +
  '      background: #0084ff; color: #fff; border: none; padding: 10px 22px;\n' +
  '      border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px;\n' +
  '      display: flex; align-items: center; gap: 6px; transition: background 0.2s, transform 0.1s;\n' +
  '    }\n' +
  '    .dl-btn:hover { background: #0070d6; }\n' +
  '    .dl-btn:active { transform: scale(0.97); }\n' +
  '    .dl-btn:disabled { background: #444; cursor: not-allowed; }\n' +
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
  '    <div class="top-pill">\n' +
  '      <svg width="15" height="15" viewBox="0 0 24 24" fill="#0084ff"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/></svg>\n' +
  '      Каталог фильмов\n' +
  '    </div>\n' +
  '    <div class="top-pill">Всего файлов: ' + videos.length + '</div>\n' +
  '  </header>\n' +
  '  <div class="grid" id="grid">\n' +
  '    ' + cardsHtml + '\n' +
  '  </div>\n' +
  '  \n' +
  '  <div class="dl-bar">\n' +
  '    <div class="dl-form">\n' +
  '      <input class="dl-input dl-url" id="inp-url" type="text" placeholder="Вставьте прямую ссылку на видео (https://.../1080.mp4)">\n' +
  '      <input class="dl-input dl-name" id="inp-name" type="text" placeholder="Название (например: Интерстеллар)">\n' +
  '      <button class="dl-btn" id="btn-dl" onclick="triggerDownload()">\n' +
  '        <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>\n' +
  '        Скачать\n' +
  '      </button>\n' +
  '    </div>\n' +
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
  '    var pollTimer = null;\n' +
  '    var btnDl = document.getElementById("btn-dl");\n' +
  '    var pBox = document.getElementById("p-box");\n' +
  '    var pFill = document.getElementById("p-fill");\n' +
  '    var pFile = document.getElementById("p-file");\n' +
  '    var pMeta = document.getElementById("p-meta");\n' +
  '    \n' +
  '    function checkStatus() {\n' +
  '      fetch("/api/download-status")\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(data) {\n' +
  '          if (data.status === "downloading") {\n' +
  '            btnDl.disabled = true;\n' +
  '            pBox.style.display = "flex";\n' +
  '            pFill.style.width = data.percent + "%";\n' +
  '            pFile.textContent = "Скачивается: " + data.filename;\n' +
  '            pMeta.textContent = data.percent + "% • " + data.receivedMb + " / " + data.totalMb + " MB • " + data.speed;\n' +
  '          } else if (data.status === "done") {\n' +
  '            btnDl.disabled = false;\n' +
  '            pFill.style.width = "100%";\n' +
  '            pFile.textContent = "✅ Скачано: " + data.filename;\n' +
  '            pMeta.textContent = "Обновление страницы...";\n' +
  '            setTimeout(function() { window.location.reload(); }, 1200);\n' +
  '          } else if (data.status === "error") {\n' +
  '            btnDl.disabled = false;\n' +
  '            pFile.textContent = "❌ Ошибка: " + data.errorMsg;\n' +
  '          } else {\n' +
  '            pBox.style.display = "none";\n' +
  '            btnDl.disabled = false;\n' +
  '          }\n' +
  '        });\n' +
  '    }\n' +
  '    \n' +
  '    function triggerDownload() {\n' +
  '      var urlVal = document.getElementById("inp-url").value.trim();\n' +
  '      var nameVal = document.getElementById("inp-name").value.trim();\n' +
  '      if (!urlVal) { alert("Вставьте ссылку на видео!"); return; }\n' +
  '      \n' +
  '      btnDl.disabled = true;\n' +
  '      fetch("/api/download-start?url=" + encodeURIComponent(urlVal) + "&name=" + encodeURIComponent(nameVal))\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(res) {\n' +
  '          if (!res.success) { alert(res.msg); btnDl.disabled = false; }\n' +
  '          else {\n' +
  '            document.getElementById("inp-url").value = "";\n' +
  '            document.getElementById("inp-name").value = "";\n' +
  '          }\n' +
  '        });\n' +
  '    }\n' +
  '    \n' +
  '    pollTimer = setInterval(checkStatus, 1000);\n' +
  '    checkStatus();\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}

// -------------------------------------------------------------
// HTML СТРАНИЦЫ ПЛЕЕРА
// -------------------------------------------------------------
function renderPlayerHTML(videoFilename) {
  var ext = path.extname(videoFilename);
  var title = path.basename(videoFilename, ext);

  return '<!DOCTYPE html>\n' +
  '<html lang="ru">\n' +
  '<head>\n' +
  '  <meta charset="utf-8">\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
  '  <title>' + title + '</title>\n' +
  '  <style>\n' +
  '    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-box-sizing: border-box; }\n' +
  '    body, html { width: 100%; height: 100%; overflow: hidden; background: #000; font-family: sans-serif; }\n' +
  '    .player-root { position: relative; width: 100%; height: 100%; background: #000; display: -webkit-flex; display: flex; -webkit-align-items: center; align-items: center; -webkit-justify-content: center; justify-content: center; cursor: none; }\n' +
  '    .player-root.show-ui { cursor: default; }\n' +
  '    video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }\n' +
  '    \n' +
  '    /* Спиннер загрузки */\n' +
  '    .spinner { position: absolute; width: 60px; height: 60px; border: 4px solid rgba(255,255,255,0.15); border-top-color: #0084ff; border-radius: 50%; -webkit-animation: spin 0.9s infinite linear; animation: spin 0.9s infinite linear; pointer-events: none; z-index: 20; display: none; }\n' +
  '    @-webkit-keyframes spin { 0% { -webkit-transform: rotate(0deg); } 100% { -webkit-transform: rotate(360deg); } }\n' +
  '    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }\n' +
  '    \n' +
  '    /* Верхняя панель */\n' +
  '    .top-bar { position: absolute; top: 0; left: 0; right: 0; height: 85px; background: -webkit-linear-gradient(top, rgba(0,0,0,0.85), transparent); background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent); display: -webkit-flex; display: flex; -webkit-align-items: center; align-items: center; padding: 0 35px; z-index: 30; opacity: 0; transition: opacity 0.3s ease; }\n' +
  '    \n' +
  '    /* Кнопка Назад (жесткое центрирование круга и иконки) */\n' +
  '    .back-btn {\n' +
  '      width: 46px;\n' +
  '      height: 46px;\n' +
  '      padding: 0 !important;\n' +
  '      margin: 0 20px 0 0;\n' +
  '      border: 0;\n' +
  '      border-radius: 50%;\n' +
  '      background: rgba(255,255,255,0.12);\n' +
  '      cursor: pointer;\n' +
  '      outline: none;\n' +
  '      display: -webkit-flex;\n' +
  '      display: flex;\n' +
  '      -webkit-align-items: center;\n' +
  '      align-items: center;\n' +
  '      -webkit-justify-content: center;\n' +
  '      justify-content: center;\n' +
  '      line-height: 0;\n' +
  '      font-size: 0;\n' +
  '      transition: background 0.15s, -webkit-transform 0.15s;\n' +
  '    }\n' +
  '    .back-btn svg { display: block; margin: 0 auto; pointer-events: none; }\n' +
  '    .back-btn:focus, .back-btn:hover { background: #0084ff; -webkit-transform: scale(1.1); transform: scale(1.1); }\n' +
  '    \n' +
  '    .video-title { color: #fff; font-size: 19px; font-weight: 600; text-shadow: 0 2px 5px rgba(0,0,0,0.9); }\n' +
  '    \n' +
  '    /* Нижняя панель */\n' +
  '    .bottom-bar { position: absolute; bottom: 0; left: 0; right: 0; background: -webkit-linear-gradient(bottom, rgba(0,0,0,0.92), transparent); background: linear-gradient(to top, rgba(0,0,0,0.92), transparent); padding: 20px 35px 25px 35px; z-index: 30; opacity: 0; transition: opacity 0.3s ease; }\n' +
  '    .show-ui .top-bar, .show-ui .bottom-bar { opacity: 1; }\n' +
  '    \n' +
  '    /* Таймлайн */\n' +
  '    .timeline-container { position: relative; width: 100%; height: 16px; cursor: pointer; display: -webkit-flex; display: flex; -webkit-align-items: center; align-items: center; margin-bottom: 12px; outline: none; }\n' +
  '    .timeline-track { width: 100%; height: 5px; background: rgba(255,255,255,0.22); border-radius: 4px; position: relative; overflow: hidden; transition: height 0.15s ease; }\n' +
  '    .timeline-container:hover .timeline-track, .timeline-container:focus .timeline-track { height: 7px; }\n' +
  '    .timeline-progress { height: 100%; width: 0%; background: #0084ff; position: absolute; top: 0; left: 0; }\n' +
  '    \n' +
  '    /* Кнопки управления (ровная центровка подсветки вокруг иконок) */\n' +
  '    .controls-row { display: -webkit-flex; display: flex; -webkit-align-items: center; align-items: center; -webkit-justify-content: space-between; justify-content: space-between; }\n' +
  '    .left-controls, .right-controls { display: -webkit-flex; display: flex; -webkit-align-items: center; align-items: center; }\n' +
  '    \n' +
  '    .ctrl-btn {\n' +
  '      width: 44px;\n' +
  '      height: 44px;\n' +
  '      padding: 0 !important;\n' +
  '      margin: 0 4px;\n' +
  '      border: 0;\n' +
  '      border-radius: 50%;\n' +
  '      background: transparent;\n' +
  '      cursor: pointer;\n' +
  '      outline: none;\n' +
  '      display: -webkit-flex;\n' +
  '      display: flex;\n' +
  '      -webkit-align-items: center;\n' +
  '      align-items: center;\n' +
  '      -webkit-justify-content: center;\n' +
  '      justify-content: center;\n' +
  '      line-height: 0;\n' +
  '      font-size: 0;\n' +
  '      transition: background 0.15s, -webkit-transform 0.15s;\n' +
  '    }\n' +
  '    .ctrl-btn svg { display: block; margin: 0 auto; pointer-events: none; }\n' +
  '    .ctrl-btn:focus, .ctrl-btn:hover {\n' +
  '      background: rgba(255, 255, 255, 0.22);\n' +
  '      -webkit-transform: scale(1.12);\n' +
  '      transform: scale(1.12);\n' +
  '    }\n' +
  '    \n' +
  '    .time-display { color: #aaa; font-size: 14px; margin-left: 12px; font-weight: 500; letter-spacing: 0.5px; }\n' +
  '    .quality-badge { background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25); color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; outline: none; margin-right: 12px; }\n' +
  '    .quality-badge:focus, .quality-badge:hover { background: #0084ff; border-color: #0084ff; }\n' +
  '    \n' +
  '    .quality-menu { position: absolute; bottom: 85px; right: 40px; background: #16161c; border: 1px solid #2c2c34; border-radius: 8px; padding: 6px 0; display: none; z-index: 40; min-width: 170px; box-shadow: 0 8px 25px rgba(0,0,0,0.7); }\n' +
  '    .q-item { padding: 10px 16px; font-size: 13px; color: #ccc; cursor: pointer; display: block; text-decoration: none; outline: none; }\n' +
  '    .q-item:focus, .q-item:hover, .q-item.active { background: #0084ff; color: #fff; }\n' +
  '  </style>\n' +
  '</head>\n' +
  '<body>\n' +
  '  <div class="player-root show-ui" id="player-root">\n' +
  '    <video id="vid" preload="auto">\n' +
  '      <source src="/stream?v=' + encodeURIComponent(videoFilename) + '" type="video/mp4">\n' +
  '    </video>\n' +
  '    <div class="spinner" id="spinner"></div>\n' +
  '    \n' +
  '    <div class="top-bar">\n' +
  '      <button class="back-btn" id="btn-back" onclick="goBack()" title="Назад">\n' +
  '        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>\n' +
  '      </button>\n' +
  '      <div class="video-title">' + title + '</div>\n' +
  '    </div>\n' +
  '    \n' +
  '    <div class="bottom-bar">\n' +
  '      <div class="timeline-container" id="timeline" tabindex="0" onclick="handleSeekClick(event)">\n' +
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
  '          <button class="ctrl-btn" onclick="seek(-10)" title="Назад на 10 сек">\n' +
  '            <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="15" font-size="7" font-weight="bold" fill="#fff" text-anchor="middle">10</text></svg>\n' +
  '          </button>\n' +
  '          <button class="ctrl-btn" onclick="seek(10)" title="Вперед на 10 сек">\n' +
  '            <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="15" font-size="7" font-weight="bold" fill="#fff" text-anchor="middle">10</text></svg>\n' +
  '          </button>\n' +
  '          <div class="time-display" id="time-display">00:00 / 00:00</div>\n' +
  '        </div>\n' +
  '        <div class="right-controls">\n' +
  '          <button class="quality-badge" id="btn-quality" onclick="toggleQualityMenu()">1080p HD</button>\n' +
  '          <button class="ctrl-btn" onclick="toggleFullscreen()" title="Полный экран">\n' +
  '            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>\n' +
  '          </button>\n' +
  '        </div>\n' +
  '      </div>\n' +
  '    </div>\n' +
  '    \n' +
  '    <div class="quality-menu" id="q-menu">\n' +
  '      <div class="q-item active" onclick="selectQuality(\'1080p HD\')">1080p (Оригинал)</div>\n' +
  '      <div class="q-item" onclick="selectQuality(\'720p\')">720p (Авто)</div>\n' +
  '    </div>\n' +
  '  </div>\n' +
  '  \n' +
  '  <script>\n' +
  '    var vid = document.getElementById("vid");\n' +
  '    var root = document.getElementById("player-root");\n' +
  '    var spinner = document.getElementById("spinner");\n' +
  '    var progress = document.getElementById("progress");\n' +
  '    var timeDisplay = document.getElementById("time-display");\n' +
  '    var iconPlay = document.getElementById("icon-play");\n' +
  '    var iconPause = document.getElementById("icon-pause");\n' +
  '    var qMenu = document.getElementById("q-menu");\n' +
  '    var qBadge = document.getElementById("btn-quality");\n' +
  '    var hideTimer = null;\n' +
  '    \n' +
  '    function sendLog(level, msg) {\n' +
  '      try {\n' +
  '        var img = new Image();\n' +
  '        img.src = "/api/log?lvl=" + encodeURIComponent(level) + "&msg=" + encodeURIComponent(msg) + "&t=" + new Date().getTime();\n' +
  '      } catch(e) {}\n' +
  '    }\n' +
  '    \n' +
  '    window.onerror = function(msg, url, line) {\n' +
  '      sendLog("ERROR", msg + " (строка: " + line + ")");\n' +
  '    };\n' +
  '    \n' +
  '    function goBack() { window.location.href = "/"; }\n' +
  '    \n' +
  '    function showUI() {\n' +
  '      root.className = "player-root show-ui";\n' +
  '      clearTimeout(hideTimer);\n' +
  '      if (!vid.paused) {\n' +
  '        hideTimer = setTimeout(function() {\n' +
  '          root.className = "player-root";\n' +
  '          qMenu.style.display = "none";\n' +
  '        }, 3500);\n' +
  '      }\n' +
  '    }\n' +
  '    \n' +
  '    window.addEventListener("mousemove", showUI);\n' +
  '    \n' +
  '    function togglePlay() {\n' +
  '      if (vid.paused) {\n' +
  '        vid.play();\n' +
  '      } else {\n' +
  '        vid.pause();\n' +
  '      }\n' +
  '      showUI();\n' +
  '    }\n' +
  '    \n' +
  '    function seek(sec) {\n' +
  '      vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + sec));\n' +
  '      showUI();\n' +
  '    }\n' +
  '    \n' +
  '    function handleSeekClick(e) {\n' +
  '      var rect = e.currentTarget.getBoundingClientRect();\n' +
  '      var pos = (e.clientX - rect.left) / rect.width;\n' +
  '      if (vid.duration) {\n' +
  '        vid.currentTime = pos * vid.duration;\n' +
  '      }\n' +
  '      showUI();\n' +
  '    }\n' +
  '    \n' +
  '    function formatTime(s) {\n' +
  '      if (isNaN(s)) return "00:00";\n' +
  '      var m = Math.floor(s / 60);\n' +
  '      var sec = Math.floor(s % 60);\n' +
  '      return (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;\n' +
  '    }\n' +
  '    \n' +
  '    function toggleFullscreen() {\n' +
  '      if (root.requestFullscreen) root.requestFullscreen();\n' +
  '      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();\n' +
  '      else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();\n' +
  '      showUI();\n' +
  '    }\n' +
  '    \n' +
  '    function toggleQualityMenu() {\n' +
  '      qMenu.style.display = qMenu.style.display === "block" ? "none" : "block";\n' +
  '      showUI();\n' +
  '    }\n' +
  '    \n' +
  '    function selectQuality(q) {\n' +
  '      qBadge.textContent = q;\n' +
  '      qMenu.style.display = "none";\n' +
  '      showUI();\n' +
  '    }\n' +
  '    \n' +
  '    vid.addEventListener("play", function() {\n' +
  '      iconPlay.style.display = "none";\n' +
  '      iconPause.style.display = "block";\n' +
  '      showUI();\n' +
  '    });\n' +
  '    \n' +
  '    vid.addEventListener("pause", function() {\n' +
  '      iconPlay.style.display = "block";\n' +
  '      iconPause.style.display = "none";\n' +
  '      showUI();\n' +
  '    });\n' +
  '    \n' +
  '    vid.addEventListener("timeupdate", function() {\n' +
  '      if (vid.duration) {\n' +
  '        var pct = (vid.currentTime / vid.duration) * 100;\n' +
  '        progress.style.width = pct + "%";\n' +
  '        timeDisplay.textContent = formatTime(vid.currentTime) + " / " + formatTime(vid.duration);\n' +
  '      }\n' +
  '    });\n' +
  '    \n' +
  '    vid.addEventListener("waiting", function() { spinner.style.display = "block"; });\n' +
  '    vid.addEventListener("canplay", function() { spinner.style.display = "none"; });\n' +
  '    vid.addEventListener("playing", function() { spinner.style.display = "none"; });\n' +
  '    \n' +
  '    vid.addEventListener("loadedmetadata", function() {\n' +
  '      if (vid.videoHeight >= 1080) qBadge.textContent = "1080p FHD";\n' +
  '      else if (vid.videoHeight >= 720) qBadge.textContent = "720p HD";\n' +
  '      else qBadge.textContent = "SD";\n' +
  '    });\n' +
  '    \n' +
  '    vid.addEventListener("error", function() {\n' +
  '      spinner.style.display = "none";\n' +
  '      var code = vid.error ? vid.error.code : "неизвестно";\n' +
  '      sendLog("ERROR", "Сбой воспроизведения видео (код " + code + ")");\n' +
  '    });\n' +
  '    \n' +
  '    window.addEventListener("keydown", function(e) {\n' +
  '      var k = e.keyCode || e.which;\n' +
  '      showUI();\n' +
  '      if (k === 13 || k === 32 || k === 415 || k === 19 || k === 10252) {\n' +
  '        togglePlay();\n' +
  '      } else if (k === 37 || k === 412) {\n' +
  '        seek(-10);\n' +
  '      } else if (k === 39 || k === 417) {\n' +
  '        seek(10);\n' +
  '      } else if (k === 10009 || k === 27) {\n' +
  '        goBack();\n' +
  '      }\n' +
  '    });\n' +
  '    \n' +
  '    vid.play();\n' +
  '    showUI();\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}

// -------------------------------------------------------------
// HTTP СЕРВЕР
// -------------------------------------------------------------
var server = http.createServer(function(req, res) {
  var urlParts = req.url.split('?');
  var pathname = urlParts[0];
  var queryStr = urlParts[1] || '';

  // Парсинг GET параметров
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

  // API: Запуск скачивания фильма по ссылке
  if (pathname === '/api/download-start') {
    var dlUrl = query.url;
    var dlTitle = query.name;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!dlUrl) {
      res.end(JSON.stringify({ success: false, msg: 'URL не передан' }));
      return;
    }
    var result = startFileDownload(dlUrl, dlTitle);
    res.end(JSON.stringify(result));
    return;
  }

  // API: Получение прогресса загрузки
  if (pathname === '/api/download-status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dlState));
    return;
  }

  // 1. Прием логов с телика в консоль ПК
  if (pathname === '/api/log') {
    var lvl = query.lvl || 'INFO';
    var msg = query.msg || '';
    var time = new Date().toLocaleTimeString();
    var tag = '[ТВ ' + time + '] [' + lvl + ']';
    if (lvl === 'ERROR') {
      console.log('\x1b[31m%s %s\x1b[0m', tag, msg);
    } else {
      console.log('\x1b[36m%s %s\x1b[0m', tag, msg);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // 2. Фавикон (пустой ответ)
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 3. Главная страница (Каталог)
  if (pathname === '/' || pathname === '/index.html') {
    var videos = getVideoList();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(renderCatalogHTML(videos));
    return;
  }

  // 4. Страница плеера
  if (pathname === '/player') {
    var targetVideo = query.v;
    if (!targetVideo) {
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(renderPlayerHTML(targetVideo));
    return;
  }

  // 5. Превью (постер)
  if (pathname === '/thumb') {
    if (!query.v) {
      res.writeHead(400);
      res.end();
      return;
    }
    serveThumbnail(query.v, res);
    return;
  }

  // 6. Потоковая отдача видеофайла
  if (pathname === '/stream') {
    if (!query.v) {
      res.writeHead(400);
      res.end();
      return;
    }
    streamVideo(query.v, req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

// Запуск
server.listen(PORT, '0.0.0.0', function() {
  console.log(' Server started on port: ' + PORT);
  console.log(' Videos dir: ' + VIDEOS_DIR);
  console.log(' Files found: ' + getVideoList().length);
}); 