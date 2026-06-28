# ce Windows 安装器(irm | iex 用法,等同 Unix 的 curl|sh):
#   irm https://你的中继/install.ps1 | iex
# 自定义下载源/安装目录:
#   $env:CE_DOWNLOAD_BASE='http://host:port'; $env:CE_INSTALL_DIR='C:\tools\ce'; irm ./install.ps1 | iex
$ErrorActionPreference = 'Stop'

$base = if ($env:CE_DOWNLOAD_BASE) { $env:CE_DOWNLOAD_BASE } else { 'https://relay.example.com/dl' }
$installDir = if ($env:CE_INSTALL_DIR) { $env:CE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\ce' }
$url = "$base/ce-windows-x64.exe"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Write-Host "[install] $url -> $installDir\ce.exe"
Invoke-WebRequest -Uri $url -OutFile (Join-Path $installDir 'ce.exe')

# 加到用户 PATH(重开终端生效)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$installDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
  Write-Host "[install] 已加到用户 PATH(重开终端生效)"
}
Write-Host "[install] 完成。运行: ce --relay=wss://your-relay [--insecure]"
