<#
  小冉学长 · 离线三维模型查看器 —— 本地静态服务（免 Python 版）
  =================================================
  给没有 Python 的电脑用，行为与 serve.py 对齐：同样的 MIME（.b3dm/.glb/.wasm 等）、
  同样的 no-store 策略、同样提供 /__model_status 探测接口。

  为什么不能直接双击 index.html：Cesium 用 fetch / Worker 读 3DTiles 瓦片，
  file:// 协议下会被跨域拦死，模型一定加载不出来。

  两条通道，自动选能用的那条：
    1) HttpListener（Windows 自带 http.sys）—— 支持并发连接与 keep-alive，
       几百个瓦片请求几秒就过完，这是首选；
    2) TcpListener 手写最小 HTTP/1.1 —— 少数被组策略限制 http.sys 的电脑上兜底，
       慢一些但一定能起。
  两者都不用管理员权限，也都不联网。

  用法（一般由 启动查看器.bat 自动调用）：
      powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -Port 8765
      powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -NoBrowser
#>

param(
    [int]$Port = 0,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 基本设置

$Root = $PSScriptRoot
if ([string]::IsNullOrEmpty($Root)) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
$RootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'

# 出错时把原因写进日志，现场电脑上直接看这个文件就知道卡在哪一步
$LogPath = Join-Path $Root '启动日志.txt'
# U 盘写保护 / 目录只读时改写到系统临时目录，保证一定留得下痕迹
try {
    [IO.File]::AppendAllText($LogPath, '', (New-Object Text.UTF8Encoding($false)))
} catch {
    $LogPath = Join-Path $env:TEMP '查看器_serve日志.txt'
}
# 把窗口里打印的一切也录进日志（老版本 PowerShell 没有 Start-Transcript 就跳过）
try { Start-Transcript -Path $LogPath -Append -Force | Out-Null } catch { }
function Write-Log([string]$msg) {
    try {
        $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
        [IO.File]::AppendAllText($LogPath, $line + "`r`n", (New-Object Text.UTF8Encoding($false)))
    } catch { }
}
Write-Log ("启动 serve.ps1｜PowerShell " + $PSVersionTable.PSVersion.ToString() + "｜目录 " + $RootFull)

# 任何没被 catch 到的错误都落到日志里，别让窗口一闪就没
trap {
    Write-Log ('脚本异常：' + $_.Exception.GetType().FullName + ' ' + $_.Exception.Message)
    Write-Host ''
    Write-Host ('  [启动失败] ' + $_.Exception.Message)
    Write-Host '  详情见本目录“启动日志.txt”，把它发过来就能定位。'
    exit 1
}

# Windows 自带 MIME 表里没有这些，缺了会白屏或 Draco 解码失败
$MimeMap = @{
    '.html'    = 'text/html; charset=utf-8'
    '.htm'     = 'text/html; charset=utf-8'
    '.js'      = 'application/javascript; charset=utf-8'
    '.mjs'     = 'application/javascript; charset=utf-8'
    '.css'     = 'text/css; charset=utf-8'
    '.json'    = 'application/json; charset=utf-8'
    '.geojson' = 'application/json; charset=utf-8'
    '.md'      = 'text/markdown; charset=utf-8'
    '.txt'     = 'text/plain; charset=utf-8'
    '.kml'     = 'application/vnd.google-earth.kml+xml; charset=utf-8'
    '.kmz'     = 'application/vnd.google-earth.kmz'
    '.b3dm'    = 'application/octet-stream'
    '.pnts'    = 'application/octet-stream'
    '.i3dm'    = 'application/octet-stream'
    '.cmpt'    = 'application/octet-stream'
    '.bin'     = 'application/octet-stream'
    '.terrain' = 'application/vnd.quantized-mesh'
    '.glb'     = 'model/gltf-binary'
    '.gltf'    = 'model/gltf+json'
    '.wasm'    = 'application/wasm'
    '.png'     = 'image/png'
    '.jpg'     = 'image/jpeg'
    '.jpeg'    = 'image/jpeg'
    '.gif'     = 'image/gif'
    '.svg'     = 'image/svg+xml'
    '.webp'    = 'image/webp'
    '.ktx2'    = 'image/ktx2'
    '.ico'     = 'image/x-icon'
    '.woff'    = 'font/woff'
    '.woff2'   = 'font/woff2'
    '.ttf'     = 'font/ttf'
}

$NoStoreExt = @('.json', '.kml', '.js', '.css', '.html', '.htm')

# 司空2 的 3DTiles 是「797 个子 tileset.json + 5 万个 b3dm」的树，
# Cesium 只能一层层往下发现子节点，这些 2 KB 的小 JSON 是串行请求的；
# 单线程服务每个请求十来毫秒，累起来要二三十秒才出第一块瓦片。
# 所以启动时把 model 目录下所有 .json 读进内存（一共不到 2 MB），请求直接命中缓存。
$JsonCache = @{}

function Load-JsonCache {
    $dir = Join-Path $RootFull 'data\model\tileset'
    if (-not [IO.Directory]::Exists($dir)) { return 0 }
    $n = 0
    $rootLen = $RootFull.Length
    # 不用 -File 参数（PS 2.0 没有），改用 PSIsContainer 过滤，老机器也能跑
    Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { -not $_.PSIsContainer } |
        ForEach-Object {
            $key = $_.FullName.Substring($rootLen).ToLower()
            try {
                $JsonCache[$key] = [IO.File]::ReadAllBytes($_.FullName)
                $n++
            } catch { }
        }
    return $n
}

function Get-Body([string]$urlPath, [string]$full) {
    # 缓存键统一成小写 + 反斜杠，否则 URL 里的 / 和磁盘上的 \ 对不上
    $key = ($urlPath -replace '/', '\').ToLower()
    if ($JsonCache.ContainsKey($key)) { return $JsonCache[$key] }
    return [IO.File]::ReadAllBytes($full)
}

$Ascii = [Text.Encoding]::ASCII
$Utf8  = [Text.Encoding]::UTF8

function Get-Mime([string]$path) {
    $ext = [IO.Path]::GetExtension($path).ToLower()
    if ($MimeMap.ContainsKey($ext)) { return $MimeMap[$ext] }
    return 'application/octet-stream'
}

function Get-CacheHeader([string]$urlPath) {
    $ext = [IO.Path]::GetExtension($urlPath).ToLower()
    if ($NoStoreExt -contains $ext) { return 'no-store' }
    return 'public, max-age=3600'
}

# 把相对路径解析成磁盘绝对路径，越界（../）一律拒绝
function Resolve-Inside([string]$rel) {
    $rel = $rel.TrimStart('/')
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
    $rel = $rel -replace '/', '\'
    $full = [IO.Path]::GetFullPath((Join-Path $RootFull $rel))
    if (-not $full.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    return $full
}

# /__model_status?path=data/model/tileset/tileset.json  -> {"exists":true,...}
function Get-ModelStatusJson([string]$rawQuery) {
    $rel = ''
    if (-not [string]::IsNullOrEmpty($rawQuery)) {
        foreach ($pair in ($rawQuery.TrimStart('?') -split '&')) {
            if ($pair -match '^path=(.*)$') {
                $rel = [Uri]::UnescapeDataString($Matches[1])
            }
        }
    }
    $rel = $rel.TrimStart('/')
    $exists = $false
    $size = 0
    if (-not [string]::IsNullOrEmpty($rel)) {
        $full = Resolve-Inside $rel
        if ($null -ne $full -and [IO.File]::Exists($full)) {
            $exists = $true
            try { $size = (Get-Item -LiteralPath $full).Length } catch { $size = 0 }
        }
    }
    $safeRel = $rel.Replace('\', '\\').Replace('"', '\"')
    if ($exists) { $flag = 'true' } else { $flag = 'false' }
    return '{"exists":' + $flag + ',"path":"' + $safeRel + '","size":' + $size + '}'
}

# ---------------------------------------------------------------- 通道 1：HttpListener（首选）

function Start-HttpListener([int]$startPort) {
    if ($startPort -gt 0) { $ports = @($startPort) } else { $ports = 8765..8824 }
    foreach ($p in $ports) {
        $l = $null
        try {
            $l = New-Object System.Net.HttpListener
            $l.Prefixes.Add("http://127.0.0.1:$p/")
            $l.Start()
            return @{ Listener = $l; Port = $p }
        } catch {
            if ($null -ne $l) { try { $l.Close() } catch { } }
            continue
        }
    }
    return $null
}

function Handle-Context($ctx) {
    $res = $ctx.Response
    try {
        $req = $ctx.Request
        $method = $req.HttpMethod.ToUpper()
        if ($method -ne 'GET' -and $method -ne 'HEAD') {
            $res.StatusCode = 405
            $res.ContentType = 'text/plain; charset=utf-8'
            $body = $Utf8.GetBytes('only GET/HEAD')
            $res.ContentLength64 = $body.Length
            if ($method -ne 'HEAD') { $res.OutputStream.Write($body, 0, $body.Length) }
            $res.Close()
            return
        }
        $sendBody = ($method -ne 'HEAD')

        $urlPath = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
        if ($urlPath.Length -gt 0 -and $urlPath[0] -eq '/') { $urlPath = $urlPath.Substring(1) }

        if ($urlPath -eq '__model_status') {
            $body = $Utf8.GetBytes((Get-ModelStatusJson $req.Url.Query))
            $res.StatusCode = 200
            $res.ContentType = 'application/json; charset=utf-8'
            $res.Headers.Add('Cache-Control', 'no-store')
            $res.ContentLength64 = $body.Length
            if ($sendBody) { $res.OutputStream.Write($body, 0, $body.Length) }
            $res.Close()
            return
        }

        $full = Resolve-Inside $urlPath
        if ($null -eq $full) {
            $res.StatusCode = 403
            $res.ContentType = 'text/plain; charset=utf-8'
            $body = $Utf8.GetBytes('forbidden')
            $res.ContentLength64 = $body.Length
            if ($sendBody) { $res.OutputStream.Write($body, 0, $body.Length) }
            $res.Close()
            return
        }

        if ([IO.Directory]::Exists($full)) {
            $idx = Join-Path $full 'index.html'
            if ([IO.File]::Exists($idx)) { $full = $idx }
        }

        if (-not [IO.File]::Exists($full)) {
            $res.StatusCode = 404
            $res.ContentType = 'text/plain; charset=utf-8'
            $body = $Utf8.GetBytes('not found: ' + $urlPath)
            $res.ContentLength64 = $body.Length
            if ($sendBody) { $res.OutputStream.Write($body, 0, $body.Length) }
            $res.Close()
            return
        }

        $bytes = Get-Body $urlPath $full
        $res.StatusCode = 200
        $res.ContentType = Get-Mime $full
        $res.Headers.Add('Cache-Control', (Get-CacheHeader $urlPath))
        $res.ContentLength64 = $bytes.Length
        if ($sendBody) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
        $res.Close()
    } catch {
        try { $res.Abort() } catch { }
    }
}

# ---------------------------------------------------------------- 通道 2：TcpListener（兜底）

function Write-Response($stream, [int]$code, [string]$reason, [string]$contentType,
                         [byte[]]$body, [string]$cache, [bool]$sendBody) {
    if ($null -eq $body) { $body = New-Object 'byte[]' 0 }
    $head = New-Object System.Text.StringBuilder
    [void]$head.Append("HTTP/1.1 $code $reason`r`n")
    [void]$head.Append("Content-Type: $contentType`r`n")
    [void]$head.Append("Content-Length: $($body.Length)`r`n")
    if ($cache) { [void]$head.Append("Cache-Control: $cache`r`n") }
    [void]$head.Append("Connection: close`r`n")
    [void]$head.Append("`r`n")
    $headBytes = $Ascii.GetBytes($head.ToString())
    $stream.Write($headBytes, 0, $headBytes.Length)
    if ($sendBody -and $body.Length -gt 0) {
        $stream.Write($body, 0, $body.Length)
    }
    $stream.Flush()
}

function Write-Plain($stream, [int]$code, [string]$reason, [string]$text, [bool]$sendBody) {
    $body = $Utf8.GetBytes($text)
    Write-Response $stream $code $reason 'text/plain; charset=utf-8' $body 'no-store' $sendBody
}

function Handle-Client($client) {
    $stream = $null
    try {
        $client.NoDelay = $true
        $stream = $client.GetStream()
        # 浏览器会先开空连接（preconnect）不发数据；读超时设短，免得把服务卡住
        $stream.ReadTimeout = 800
        $stream.WriteTimeout = 20000

        $buf = New-Object byte[] 1024
        $ms = New-Object System.IO.MemoryStream
        $headEnd = -1
        try {
            while ($ms.Length -lt 8192) {
                $n = $stream.Read($buf, 0, $buf.Length)
                if ($n -le 0) { break }
                $ms.Write($buf, 0, $n)
                $arr = $ms.ToArray()
                for ($i = 0; $i -lt $arr.Length - 3; $i++) {
                    if ($arr[$i] -eq 13 -and $arr[$i + 1] -eq 10 -and $arr[$i + 2] -eq 13 -and $arr[$i + 3] -eq 10) {
                        $headEnd = $i
                        break
                    }
                }
                if ($headEnd -ge 0) { break }
            }
        } catch {
            return
        }
        if ($headEnd -lt 0) {
            Write-Plain $stream 400 'Bad Request' 'bad request' $true
            return
        }

        $headText = $Ascii.GetString($ms.ToArray(), 0, $headEnd)
        $parts = ($headText -split "`r`n")[0] -split ' '
        if ($parts.Length -lt 3) {
            Write-Plain $stream 400 'Bad Request' 'bad request' $true
            return
        }
        $method = $parts[0].ToUpper()
        $target = $parts[1]
        if ($method -ne 'GET' -and $method -ne 'HEAD') {
            Write-Plain $stream 405 'Method Not Allowed' 'only GET/HEAD' $true
            return
        }
        $sendBody = ($method -ne 'HEAD')

        $qIndex = $target.IndexOf('?')
        if ($qIndex -ge 0) {
            $urlPath = $target.Substring(0, $qIndex)
            $query = $target.Substring($qIndex + 1)
        } else {
            $urlPath = $target
            $query = ''
        }
        if ($urlPath.Length -gt 0 -and $urlPath[0] -eq '/') { $urlPath = $urlPath.Substring(1) }
        $urlPath = [Uri]::UnescapeDataString($urlPath)

        if ($urlPath -eq '__model_status') {
            $body = $Utf8.GetBytes((Get-ModelStatusJson $query))
            Write-Response $stream 200 'OK' 'application/json; charset=utf-8' $body 'no-store' $sendBody
            return
        }

        $full = Resolve-Inside $urlPath
        if ($null -eq $full) {
            Write-Plain $stream 403 'Forbidden' 'forbidden' $sendBody
            return
        }
        if ([IO.Directory]::Exists($full)) {
            $idx = Join-Path $full 'index.html'
            if ([IO.File]::Exists($idx)) { $full = $idx }
        }
        if (-not [IO.File]::Exists($full)) {
            Write-Plain $stream 404 'Not Found' ('not found: ' + $urlPath) $sendBody
            return
        }

        $bytes = Get-Body $urlPath $full
        Write-Response $stream 200 'OK' (Get-Mime $full) $bytes (Get-CacheHeader $urlPath) $sendBody
    } catch {
        try { Write-Plain $stream 500 'Internal Server Error' ($_.Exception.Message) $true } catch { }
    }
}

function Start-TcpListener([int]$startPort) {
    if ($startPort -gt 0) { $ports = @($startPort) } else { $ports = 8765..8824 }
    foreach ($p in $ports) {
        try {
            $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
            $l.Start()
            return @{ Listener = $l; Port = $p }
        } catch {
            continue
        }
    }
    return $null
}

# ---------------------------------------------------------------- 起服务

$via = 'HttpListener'
$svc = $null
if ($env:XZ3D_FORCE_TCP -ne '1') {
    # 调试用：XZ3D_FORCE_TCP=1 可强制走兜底通道，验证手写 HTTP 实现没坏
    $svc = Start-HttpListener $Port
    Write-Log ("HttpListener：" + $(if ($null -eq $svc) { '起不来（被组策略/URL 预留挡了，或端口全占）' } else { '已绑定端口 ' + $svc.Port }))
}
if ($null -eq $svc) {
    $via = 'TcpListener'
    $svc = Start-TcpListener $Port
    Write-Log ("TcpListener：" + $(if ($null -eq $svc) { '也起不来' } else { '已绑定端口 ' + $svc.Port }))
}
if ($null -eq $svc) {
    Write-Log '两个通道都失败，退出。'
    Write-Host ''
    Write-Host '  [失败] 8765~8824 端口都起不来服务。'
    Write-Host '         原因已写入同目录的“启动日志.txt”。'
    Write-Host '         常见原因：这些端口被别的程序占用；或被组策略限制。'
    Write-Host '         可试：serve.ps1 -Port 8888，挑一个空闲端口。'
    Write-Host ''
    exit 1
}

$listener = $svc.Listener
$usedPort = $svc.Port
$url = "http://127.0.0.1:$usedPort/index.html"

# 启动时顺手看一眼模型到没到（只看 tileset.json，不去数 5 万个瓦片，免得启动卡住）
$ts = Join-Path $RootFull 'data\model\tileset\tileset.json'
if ([IO.File]::Exists($ts)) {
    $cacheN = Load-JsonCache
    $cacheMB = [math]::Round((($JsonCache.Values | ForEach-Object { $_.Length } | Measure-Object -Sum).Sum) / 1MB, 1)
    $tsSize = (Get-Item -LiteralPath $ts).Length
    $modelLine = "已检测到 tileset.json（$([math]::Round($tsSize / 1KB, 0)) KB），层级 JSON 预载 $cacheN 个 / $cacheMB MB"
} else {
    $modelLine = "未检测到模型（data\model\tileset\tileset.json 不存在）—— 查看器会每 5 秒自动检测"
}

Write-Host ''
Write-Host ('=' * 62)
Write-Host '  小冉学长 · 离线三维模型查看器'
Write-Host ('=' * 62)
Write-Host "  服务地址 : $url"
Write-Host "  工作目录 : $RootFull"
Write-Host "  模型状态 : $modelLine"
Write-Host "  运行方式 : Windows 内置组件 $via（无需 Python，PowerShell $($PSVersionTable.PSVersion.ToString())）"
Write-Host "  运行日志 : $LogPath"
Write-Host ('-' * 62)
Write-Host '  关闭这个窗口 = 停止服务。演示时不联网也能正常用。'
Write-Host ('=' * 62)
Write-Host ''

if (-not $NoBrowser -and -not $env:XZ3D_NO_BROWSER) {
    Start-Process $url | Out-Null
}

try {
    if ($via -eq 'HttpListener') {
        while ($listener.IsListening) {
            $ctx = $listener.GetContext()
            Handle-Context $ctx
        }
    } else {
        while ($true) {
            $client = $listener.AcceptTcpClient()
            Handle-Client $client
            try { $client.Close() } catch { }
        }
    }
} catch {
    Write-Log ('服务循环异常：' + $_.Exception.GetType().FullName + ' ' + $_.Exception.Message)
    Write-Host ''
    Write-Host ('  [服务异常] ' + $_.Exception.Message)
    Write-Host '  详情见同目录“启动日志.txt”，把这行连同上面几行发过来即可定位。'
} finally {
    Write-Log '服务循环结束（停止服务）'
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
    Write-Host ''
    Write-Host '已停止服务。'
    try { Stop-Transcript | Out-Null } catch { }
}
