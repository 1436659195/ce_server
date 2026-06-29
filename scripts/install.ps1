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
try { python --version | Out-Null; $needPython = $false } catch {}
if ($needPython) {
  Write-Host "[install] 未检测到 Python"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "[install] 没有 winget。请手动装 Python 3.12(python.org,勾 'Add to PATH')后重跑本命令" -ForegroundColor Red
    return
  }
  if (-not (Ask-Yes("[install] 将用 winget 安装 Python 3.12,是否继续?"))) { Write-Host "[install] 已取消"; return }
  winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}

# ② 下 ce.exe(中继 /dl 路由;ws:// → http://)
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\ce'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$exe = Join-Path $installDir 'ce.exe'
$dlBase = $relay -replace '^ws','http'
Write-Host "[install] 下载 $dlBase/dl/ce-windows-x64.exe"
Invoke-WebRequest -Uri "$dlBase/dl/ce-windows-x64.exe" -OutFile $exe

# ③ 写 config.json(ce 启动读它,不必每次带 --relay)
$ceDir = Join-Path $env:USERPROFILE '.ce'
New-Item -ItemType Directory -Force -Path $ceDir | Out-Null
@{ relay = $relay } | ConvertTo-Json | Set-Content (Join-Path $ceDir 'config.json')

# ④ 注册 ce 到用户 PATH(新终端里 ce 命令生效)
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($userPath -notlike "*$installDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
  Write-Host "[install] 已加到用户 PATH(新终端里 ce 命令生效)"
}

# ⑤ 开机自启?(写 HKCU Run,免 UAC)
if (Ask-Yes("[install] 是否开机自动启动 ce?")) {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-Item -Path $runKey -Force | Out-Null
  Set-ItemProperty -Path $runKey -Name 'CodingEverywhere' -Value $exe
  Write-Host "[install] 已设置开机自启"
}

# ⑥ 直接前台启动 ce → 二维码出现在本窗口(窗口保持 = ce 在跑)
Write-Host "[install] 启动 ce..."
& $exe
