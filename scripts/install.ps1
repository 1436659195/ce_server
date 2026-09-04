# Coding Everywhere —— Windows 一行命令安装器。
# 用户用法:  irm http://<中继>:8606/install.ps1 | iex
# 下方 $relay 变量由中继 serve 本脚本时按请求 Host 注入(如 ws://101.132.161.59:8606)。
$ErrorActionPreference = 'Stop'
$relay = '__RELAY_URL__'

function Ask-Yes($msg) {
  $a = Read-Host "$msg [y/N]"
  return $a -match '^[yY]'
}

# ① Python(没装则引导 winget 装,装完刷新本会话 PATH 让 ce 子进程拿到 python/pip)
$needPython = $true
try {
  # 必须查 $LASTEXITCODE:Windows 商店 stub 的 python 会让 `python --version` 不抛异常但返回
  # 非零 → 只用 try/catch 会假成功、跳过 winget(实测踩过)。2>$null 静音 stub 的英文提示。
  python --version 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $needPython = $false }
} catch {}
if ($needPython) {
  Write-Host "[install] 未检测到 Python"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "[install] 没有 winget。请手动装 Python 3.12(python.org,勾 'Add to PATH')后重跑本命令" -ForegroundColor Red
    return
  }
  if (-not (Ask-Yes("[install] 将用 winget 安装 Python 3.12,是否继续?"))) { Write-Host "[install] 已取消"; return }
  winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  $wingetExit = $LASTEXITCODE
  # winget 退出码不可靠(返回 0 也可能没真装上)+ Windows 商店 stub 会假成功 → 刷新 PATH 后
  # 实测 python(还查 $LASTEXITCODE 防 stub)。装失败就停在这、给手动安装指引,绝不闷头继续
  # 下载/启动 ce(否则 ce 会跑到 pip 才报"没有 pip",用户不知道根因是 Python 没装上)。
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $pythonInstalled = $false
  try { python --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $pythonInstalled = $true } } catch {}
  if (-not $pythonInstalled) {
    $httpRelay = $relay -replace '^ws','http'
    Write-Host "[install] winget 装 Python 失败(winget 退出码 $wingetExit,装完后仍检测不到 python)" -ForegroundColor Red
    Write-Host "[install] 请手动装 Python 3.12:" -ForegroundColor Red
    Write-Host "     到 https://www.python.org/downloads/ 下载(安装时勾 'Add to PATH')" -ForegroundColor Red
    Write-Host "[install] 装好后【重新打开】PowerShell,重新执行本命令:" -ForegroundColor Red
    Write-Host "     irm $httpRelay/install.ps1 | iex" -ForegroundColor Red
    return
  }
}

# ② ce.exe(已有且与中继 sha256 一致才跳过,否则下载/升级;hash 比 size 可靠:同 size 不同内容也检出)
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\ce'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$exe = Join-Path $installDir 'ce.exe'
$dlBase = $relay -replace '^ws','http'
$dlUrl = "$dlBase/dl/ce-windows-x64.exe"
$shaUrl = "$dlBase/dl/sha256.txt"
if (Test-Path $exe) {
  $remoteHash = $null
  try {
    # 解析 sha256.txt 取 ce-windows-x64.exe 的 hash(sha256sum 格式 "<hash>  <name>")
    $shaList = (Invoke-WebRequest $shaUrl -UseBasicParsing).Content
    $line = ($shaList -split "`n" | Where-Object { $_ -match 'ce-windows-x64\.exe\s*$' } | Select-Object -First 1)
    if ($line) { $remoteHash = ($line -split '\s+')[0].ToLower() }
  } catch {}
  $localHash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  if ($remoteHash -and $remoteHash -eq $localHash) {
    Write-Host "[install] ce.exe 已是最新($localHash),跳过下载"
  } else {
    # Windows 不允许覆盖运行中的 exe:更新前先停旧 ce(下方 ⑥ 会重新拉起)。
    # ce 重启带 cid 注册回同一 sid,配对码/白名单不丢 —— 停是安全的。
    $oldRunning = Get-Process -Name 'ce' -ErrorAction SilentlyContinue
    if ($oldRunning) {
      Write-Host "[install] 旧 ce 在跑(PID $($oldRunning.Id -join ',')),先停止再覆盖更新" -ForegroundColor Yellow
      $oldRunning | Stop-Process -Force
      $oldRunning | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    }
    Write-Host "[install] ce.exe 有更新(本地 $localHash / 远程 $remoteHash),重新下载"
    Invoke-WebRequest -Uri $dlUrl -OutFile $exe
  }
} else {
  Write-Host "[install] 下载 $dlUrl"
  Invoke-WebRequest -Uri $dlUrl -OutFile $exe
}

# ③ 选盘(= Jupyter root_dir,手机文件栏的浏览根;默认有 D: 用 D:、否则 C:)+ 写 config.json(ce 启动读它,不必每次带 --relay)
$ceDir = Join-Path $env:USERPROFILE '.ce'
New-Item -ItemType Directory -Force -Path $ceDir | Out-Null
$cfgPath = Join-Path $ceDir 'config.json'
$oldRoot = $null
if (Test-Path $cfgPath) {
  try { $oldRoot = (Get-Content $cfgPath -Raw | ConvertFrom-Json).root } catch {}
}

# 枚举本地盘:固定 + 可移动(排除 CD-ROM/网络盘);IsReady 滤掉未就绪的空卡槽
$drives = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and ($_.DriveType -eq 'Fixed' -or $_.DriveType -eq 'Removable') })
Write-Host "[install] 选择文件根盘(手机文件栏从它浏览):"
for ($i = 0; $i -lt $drives.Count; $i++) {
  $d = $drives[$i]
  $type = if ($d.DriveType -eq 'Fixed') { '固定盘' } else { '可移动' }
  $free = [math]::Round($d.TotalFreeSpace / 1GB, 1)
  Write-Host ("  [{0}] {1}  {2}  剩余 {3} GB" -f ($i + 1), $d.RootDirectory.Path, $type, $free)
}
function Find-DriveIdx([object[]]$ds, [string]$path) {
  for ($i = 0; $i -lt $ds.Count; $i++) { if ($ds[$i].RootDirectory.Path -ieq $path) { return $i } }
  return -1
}
# 默认:重跑时旧配置的根(回车保持)→ 首装 D:(有则)→ C: → 第 0 个
$defaultIdx = if ($oldRoot) { Find-DriveIdx $drives $oldRoot } else { Find-DriveIdx $drives 'D:\' }
if ($defaultIdx -lt 0) { $defaultIdx = Find-DriveIdx $drives 'C:\' }
if ($defaultIdx -lt 0) { $defaultIdx = 0 }
$sel = Read-Host ("[install] 输入编号(回车 = [{0}] {1})" -f ($defaultIdx + 1), $drives[$defaultIdx].RootDirectory.Path)
$idx = $defaultIdx
if ($sel -match '^\s*\d+\s*$') {
  $n = [int]$sel - 1
  if ($n -ge 0 -and $n -lt $drives.Count) { $idx = $n }
  else { Write-Host "[install] 编号超出范围,用默认" -ForegroundColor Yellow }
}
$root = $drives[$idx].RootDirectory.Path
$rootChanged = ($oldRoot -and ($oldRoot -ine $root))
@{ relay = $relay; root = $root } | ConvertTo-Json | Set-Content $cfgPath
if ($rootChanged) {
  Write-Host "[install] 文件根: $oldRoot → $root(下方重启 ce 后生效)" -ForegroundColor Yellow
} else {
  Write-Host "[install] 文件根: $root"
}

# ④ 注册 ce 到用户 PATH(新终端里 ce 命令生效)
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($userPath -notlike "*$installDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
  Write-Host "[install] 已加到用户 PATH(新终端里 ce 命令生效)"
}

# ⑤ 开机自启?(已设则跳过问,防呆;写 HKCU Run,免 UAC)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$alreadyAuto = (Get-ItemProperty -Path $runKey -Name 'CodingEverywhere' -ErrorAction SilentlyContinue).CodingEverywhere
if ($alreadyAuto) {
  Write-Host "[install] 开机自启已设置,跳过"
} elseif (Ask-Yes("[install] 是否开机自动启动 ce?")) {
  New-Item -Path $runKey -Force | Out-Null
  Set-ItemProperty -Path $runKey -Name 'CodingEverywhere' -Value $exe
  Write-Host "[install] 已设置开机自启"
}

# ⑥ 启动 ce(已在跑 = 本次未更新,复用其连接码;② 更新路径停了旧进程,此处查无进程 → 落到下方拉起新版)
$running = Get-Process -Name 'ce' -ErrorAction SilentlyContinue
# ③ 换了盘 → 停旧 ce 重启才生效(同 ② 更新逻辑;ce 重启带 cid 注册回同一 sid,配对码/白名单不丢)
if ($running -and $rootChanged) {
  Write-Host "[install] 文件根已改($oldRoot → $root),重启 ce 使其生效" -ForegroundColor Yellow
  $running | Stop-Process -Force
  $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  $running = $null
}
if ($running) {
  Write-Host "[install] ce 已在运行(PID $($running.Id -join ',')),不重复启动" -ForegroundColor Yellow
  $codeFile = Join-Path $ceDir 'connection-code.json'
  if (Test-Path $codeFile) {
    Write-Host "[install] 原 ce 的连接码(手机粘码用):"
    Write-Host (Get-Content $codeFile -Raw)
    Write-Host "[install] 二维码请到原 ce 窗口查看(它还在跑)" -ForegroundColor Yellow
  } else {
    Write-Host "[install] 未找到连接码文件,请到原 ce 窗口扫码" -ForegroundColor Yellow
  }
  return
}
Write-Host "[install] 启动 ce..."
& $exe
