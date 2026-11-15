# K1 keep-alive runtime probe (throwaway). Writes only under this directory's
# .out/ plus profile state under .out/home; never touches the real DSH profile.
param(
  [ValidateSet('followup', 'steer', 'followup-async', 'none')]
  [string]$Mode = 'followup'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$exe = if ($env:DSH_EXE) { $env:DSH_EXE } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
$bin = if ($env:DSH_BIN) { $env:DSH_BIN } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' }
if (-not (Test-Path $exe)) { throw "DeepSeek Harness.exe not found: $exe (override with DSH_EXE)" }
# The dsh entry lives inside app.asar; PowerShell's Test-Path cannot see it,
# but Electron-as-Node can resolve the virtual path.
if ($bin -eq '') { throw "dsh bin path is empty (override with DSH_BIN)" }

$out = Join-Path $here '.out'
$dshHome = Join-Path $out 'home'
New-Item -ItemType Directory -Force $out | Out-Null
New-Item -ItemType Directory -Force $dshHome | Out-Null
$log = Join-Path $out "k1-events.$Mode.jsonl"
Remove-Item $log -ErrorAction SilentlyContinue

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $dshHome
$env:K1_LOG = $log
$env:K1_MODE = $Mode

# Fresh disposable profile from the shipped headless template.
# Start-Process -Wait is required: the Electron GUI executable returns control
# to PowerShell before the Node-mode child exits when invoked with `&`.
$dumpOut = Join-Path $out 'dump-config.stdout.log'
$dumpErr = Join-Path $out 'dump-config.stderr.log'
$dumpArgs = "`"$bin`" --profile kp --from-default-profile headless --dump-config"
$dump = Start-Process -FilePath $exe -ArgumentList $dumpArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $dumpOut -RedirectStandardError $dumpErr
if (-not (Test-Path (Join-Path $dshHome 'profiles\kp\package.json'))) {
  Get-Content -LiteralPath $dumpErr -ErrorAction SilentlyContinue | Write-Output
  throw "profile creation failed, exit=$($dump.ExitCode)"
}

$profile = Join-Path $dshHome 'profiles\kp'
$plugin = Join-Path $profile 'node_modules\keepalive-probe'
New-Item -ItemType Directory -Force $plugin | Out-Null
Copy-Item (Join-Path $here 'index.js') $plugin -Force
Copy-Item (Join-Path $here 'package.json') $plugin -Force
Copy-Item (Join-Path $here 'cordis.patch.yml') (Join-Path $profile 'cordis.patch.yml') -Force

Write-Output "mode=$Mode profile=$profile"
Write-Output "log=$log"
$runArgs = "`"$bin`" --profile kp `"K1 probe: call probe_run, then answer done`""
$stdout = Join-Path $out "run.$Mode.stdout.log"
$stderr = Join-Path $out "run.$Mode.stderr.log"
$run = Start-Process -FilePath $exe -ArgumentList $runArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
if ($run.ExitCode -ne 0) {
  Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | Write-Output
  throw "headless probe failed, exit=$($run.ExitCode)"
}
# The Electron-as-Node process can release the log a moment after exit.
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  if ([System.IO.File]::Exists($log)) { $ready = $true; break }
  Start-Sleep -Milliseconds 100
}
if (-not $ready) { throw "probe log not found: $log" }
$lines = [System.IO.File]::ReadAllLines($log)
Write-Output "events=$($lines.Count)"
$lines

