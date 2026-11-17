# verify.ps1 — one-shot self check for cloudsea-v2
#
#   1. build the single-file release (unless -SkipBuild)
#   2. serve it over http on a local port
#   3. render 8 deterministic screenshots (4 themes + 4 weathers) with headless Edge
#   4. fail if the browser console reports shader / JS errors
#
# Usage:
#   pwsh tools/verify.ps1
#   pwsh tools/verify.ps1 -Port 8801 -SkipBuild
#
# Notes:
#   - ASCII only on purpose: PowerShell 5.1 mis-decodes UTF-8 scripts without BOM.
#   - Set EDGE_PATH / PYTHON_PATH to override auto-detection.

param(
  [int]$Port = 8799,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "shots\verify"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Find-Edge {
  if ($env:EDGE_PATH -and (Test-Path $env:EDGE_PATH)) { return $env:EDGE_PATH }
  $candidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  throw "No Chromium browser found. Set EDGE_PATH."
}

function Find-Python {
  if ($env:PYTHON_PATH -and (Test-Path $env:PYTHON_PATH)) { return $env:PYTHON_PATH }
  $candidates = @()
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $candidates += "C:\Users\$env:USERNAME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
  foreach ($p in $candidates) {
    if (-not (Test-Path $p)) { continue }
    $ok = $false
    try { & $p -c "print(1)" *> $null; $ok = ($LASTEXITCODE -eq 0) } catch { $ok = $false }
    if ($ok) { return $p }
  }
  throw "python not found. Set PYTHON_PATH."
}

$edge = Find-Edge
$python = Find-Python
Write-Host "[1/4] browser: $edge"
Write-Host "      python : $python"

# ---------------------------------------------------------------- build
if (-not $SkipBuild) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "node not found (needed for the single-file build)." }
  Write-Host "[2/4] build single file"
  & $node.Source (Join-Path $root "tools\build-singlefile.mjs")
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
} else {
  Write-Host "[2/4] build skipped"
}

$dist = Join-Path $root "dist\cloudsea.html"
if (-not (Test-Path $dist)) { throw "missing dist/cloudsea.html" }

# ---------------------------------------------------------------- server
Write-Host "[3/4] serve on http://127.0.0.1:$Port"
$server = Start-Process -FilePath $python -ArgumentList @("-m", "http.server", "$Port", "--bind", "127.0.0.1") `
  -WorkingDirectory $root -PassThru -WindowStyle Hidden

try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $resp = Invoke-WebRequest "http://127.0.0.1:$Port/index.html" -UseBasicParsing -TimeoutSec 2 -Method Head
      if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "local server did not come up" }

  # ---------------------------------------------------------------- shots
  $cases = @(
    @{ name = "theme-classic"; query = "theme=classic" },
    @{ name = "theme-cyber";   query = "theme=cyber" },
    @{ name = "theme-ruins";   query = "theme=ruins" },
    @{ name = "theme-polar";   query = "theme=polar" },
    @{ name = "weather-sunny"; query = "theme=cyber&weather=sunny" },
    @{ name = "weather-rain";  query = "theme=cyber&weather=rain" },
    @{ name = "weather-snow";  query = "theme=cyber&weather=snow" },
    @{ name = "weather-storm"; query = "theme=cyber&weather=storm&flash=0.9" }
  )

  Write-Host "[4/4] render $($cases.Count) screenshots"
  $failures = @()
  foreach ($case in $cases) {
    $png = Join-Path $outDir "$($case.name).png"
    $log = Join-Path $outDir "$($case.name).log"
    $profile = Join-Path $outDir "profile-$($case.name)"
    $url = "http://127.0.0.1:$Port/index.html?freeze=1&t=20&$($case.query)"

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & $edge --headless=new --no-sandbox --disable-crash-reporter --disable-breakpad `
        --use-angle=d3d11 --hide-scrollbars --window-size=1600,900 `
        --user-data-dir="$profile" --enable-logging=stderr --v=0 `
        --virtual-time-budget=12000 --screenshot="$png" $url 2> $log | Out-Null
    } finally {
      $ErrorActionPreference = $prevEap
    }

    $errors = Select-String -Path $log -Pattern "Uncaught|SyntaxError|着色器编译失败|program 链接失败|WebGL: INVALID" -Encoding UTF8
    $size = if (Test-Path $png) { (Get-Item $png).Length } else { 0 }
    if ($errors -or $size -lt 20000) {
      $failures += $case.name
      Write-Host ("  FAIL {0}  (png {1} bytes)" -f $case.name, $size)
      if ($errors) { $errors | Select-Object -First 3 | ForEach-Object { Write-Host "       $($_.Line)" } }
    } else {
      Write-Host ("  ok   {0}  ({1} KB)" -f $case.name, [int]($size / 1024))
    }
    Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host ""
  if ($failures.Count -gt 0) {
    Write-Host "RESULT: FAIL -> $($failures -join ', ')"
    exit 1
  }
  Write-Host "RESULT: PASS (8/8 screenshots, no console errors)"
  Write-Host "artifacts: shots/verify/"
  exit 0
}
finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
