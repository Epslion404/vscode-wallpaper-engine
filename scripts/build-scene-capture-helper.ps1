param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $repoRoot 'native\scene-capture-helper'
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCommand) {
    throw '未找到 Cargo。请安装 Rust stable 工具链后重试。'
}

# Rust 的 panic 位置信息会嵌入源码绝对路径；发布构建统一重映射，避免泄露构建机目录。
$cargoHome = Split-Path -Parent (Split-Path -Parent $cargoCommand.Source)
$flagSeparator = [char]0x1f
$env:CARGO_ENCODED_RUSTFLAGS = @(
    "--remap-path-prefix=$cargoHome=cargo-home",
    "--remap-path-prefix=$repoRoot=workspace"
) -join $flagSeparator

$arguments = @('build', '--locked')
if ($Configuration -eq 'Release') {
    $arguments += '--release'
}

Write-Host "[Scene Helper] Building $Configuration binary..."
& $cargoCommand.Source @arguments --manifest-path (Join-Path $nativeRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0) {
    throw "Scene helper 构建失败，退出码 $LASTEXITCODE"
}

$profileDir = if ($Configuration -eq 'Release') { 'release' } else { 'debug' }
$sourceExe = Join-Path $nativeRoot "target\$profileDir\vwe-scene-capture-helper.exe"
$binDir = Join-Path $repoRoot 'bin'
$targetExe = Join-Path $binDir 'vwe-scene-capture-helper.exe'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -LiteralPath $sourceExe -Destination $targetExe -Force
Write-Host "[Scene Helper] Output: $targetExe"
