<#
.SYNOPSIS
  개발 PC(Windows 11) 환경 점검 스크립트. 아무것도 설치하거나 변경하지 않습니다.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\check_environment.ps1
#>
$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$failures = 0

function Write-Result([string]$Name, [bool]$Ok, [string]$Detail, [bool]$Required = $true) {
    if ($Ok) {
        Write-Host ("[ OK ] {0,-22} {1}" -f $Name, $Detail) -ForegroundColor Green
    } elseif ($Required) {
        Write-Host ("[FAIL] {0,-22} {1}" -f $Name, $Detail) -ForegroundColor Red
        $script:failures++
    } else {
        Write-Host ("[WARN] {0,-22} {1}" -f $Name, $Detail) -ForegroundColor Yellow
    }
}

function Get-ToolVersion([string]$Command, [string[]]$Arguments) {
    $cmd = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $out = & $cmd.Source @Arguments 2>$null | Select-Object -First 1
        if ($out) { return "$out".Trim() } else { return 'installed' }
    } catch {
        return 'installed'
    }
}

Write-Host "== 도서관 좌석 시스템 개발 환경 점검 ==" -ForegroundColor Cyan
Write-Host "프로젝트: $ProjectRoot`n"

# Node.js (20 이상)
$node = Get-ToolVersion 'node' @('--version')
$nodeOk = $false
if ($node -match 'v(\d+)\.') { $nodeOk = [int]$Matches[1] -ge 20 }
Write-Result 'Node.js (>=20)' $nodeOk ($(if ($node) { $node } else { '없음' }))

$npm = Get-ToolVersion 'npm.cmd' @('--version')
if (-not $npm) { $npm = Get-ToolVersion 'npm' @('--version') }
Write-Result 'npm' ([bool]$npm) ($(if ($npm) { $npm } else { '없음' }))

# Python (3.12 이상, 서버는 3.13)
$py = Get-ToolVersion 'python' @('--version')
$pyOk = $false
if ($py -match 'Python (\d+)\.(\d+)') { $pyOk = ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 12) }
Write-Result 'Python (>=3.12)' $pyOk ($(if ($py) { $py } else { '없음' }))

$git = Get-ToolVersion 'git' @('--version')
Write-Result 'Git' ([bool]$git) ($(if ($git) { $git } else { '없음' })) $false

$ssh = Get-Command ssh -ErrorAction SilentlyContinue
Write-Result 'OpenSSH client' ([bool]$ssh) ($(if ($ssh) { $ssh.Source } else { '없음 (Pi 접속에 필요)' })) $false

$arduino = Get-ToolVersion 'arduino-cli' @('version')
Write-Result 'arduino-cli' ([bool]$arduino) ($(if ($arduino) { $arduino } else { '없음 (Arduino IDE 사용 시 무시)' })) $false

# wrangler (로컬 node_modules 또는 npx 사용 가능 여부만 확인, 실행하지 않음)
$wranglerLocal = Test-Path (Join-Path $ProjectRoot 'cloudflare\node_modules\.bin\wrangler.cmd')
Write-Result 'wrangler' $wranglerLocal ($(if ($wranglerLocal) { 'cloudflare/node_modules' } else { '미설치 - npx wrangler 로 실행 가능' })) $false

# 프로젝트 파일
Write-Host ''
$required = @(
    'CLAUDE.md', 'README.md', '.gitignore',
    'cloudflare\workers\index.js', 'cloudflare\database\schema.sql',
    'raspberry-pi\agent\main.py', 'web\kiosk\package.json',
    'arduino\firmware\library_controller\library_controller.ino'
)
foreach ($rel in $required) {
    Write-Result $rel (Test-Path (Join-Path $ProjectRoot $rel)) ''
}

# 비밀 파일이 커밋 대상에 섞이지 않았는지 확인
$secretFiles = @('.env', 'raspberry-pi\.env', 'cloudflare\.dev.vars', 'cloudflare\wrangler.toml') |
    Where-Object { Test-Path (Join-Path $ProjectRoot $_) }
if ($secretFiles) {
    Write-Result '비밀 파일' $true ("존재(.gitignore 대상): " + ($secretFiles -join ', '))
} else {
    Write-Result '비밀 파일' $true '없음'
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host "필수 항목 $failures 개 실패" -ForegroundColor Red
    exit 1
}
Write-Host '필수 항목 모두 통과' -ForegroundColor Green
exit 0
