# claude-pro installer for Windows (Windows PowerShell 5.1 or PowerShell 7):
#
#   irm https://7bit.fun/claude-pro/install.ps1 | iex
#
# With Node.js 22 or later already installed (and npm's global directory writable), it installs claude-pro with that
# npm. Otherwise it puts a portable Node.js 24 in %USERPROFILE%\.claude-pro\runtime (checked against the official
# SHA256 list) for claude-pro alone, and only the claude-pro command goes on PATH: another node is left as it is.
# claude-pro's Bash tool needs Git for Windows: installed with winget when missing. Run it again to update or repair.
# Where nodejs.org cannot be reached quickly (China), Node and the package come from npmmirror.
#
# Options, as environment variables:
#   CLAUDE_PRO_MIRROR=npmmirror|official   where to download from (default: decided by a quick probe)
#   CLAUDE_PRO_USE_RUNTIME=1               the portable Node even when a usable one is installed
#   CLAUDE_PRO_NO_MODIFY_PATH=1            do not add %USERPROFILE%\.claude-pro\bin to the user's PATH
#   CLAUDE_PRO_SKIP_GIT=1                  do not install Git for Windows
#   CLAUDE_PRO_CONFIG_DIR=<dir>            instead of %USERPROFILE%\.claude-pro (claude-pro reads it too)
#
# The source of this file is install.ps1 in https://github.com/yanzaocheng/copy-claude-code (7bit.fun serves a copy).
# Everything runs in a script block: run through `iex`, nothing is left in the user's session, and an error does not
# close their window (no `exit`).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # (Windows PowerShell's progress bar makes downloads many times slower)
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Pkg = '@yanzc/claude-pro'
  $NodeMajor = 24
  $MinMajor = 22
  $Root = if ($env:CLAUDE_PRO_CONFIG_DIR) { $env:CLAUDE_PRO_CONFIG_DIR } else { Join-Path $HOME '.claude-pro' }
  $Runtime = Join-Path $Root 'runtime'
  $BinDir = Join-Path $Root 'bin'
  $Mark = 'added by the claude-pro installer'

  function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
  function Note($m) { Write-Host "    $m" }
  function Fetch($url, $out) { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 900 }
  function Probe($url) { try { $null = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 4; $true } catch { $false } }
  function MajorOf($exe) { try { [int](& $exe -p "process.versions.node.split('.')[0]" 2>$null) } catch { 0 } }
  # npm can create the directory: the nearest one that exists is writable (%APPDATA%\npm appears at the first install)
  function Writable($dir) {
    while ($dir -and -not (Test-Path -LiteralPath $dir)) { $dir = Split-Path -Parent $dir }
    if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
    $probe = Join-Path $dir ('.claude-pro-write-test-' + [guid]::NewGuid())
    try { [IO.File]::WriteAllText($probe, ''); Remove-Item -LiteralPath $probe -Force; $true } catch { $false }
  }
  # A .cmd file is read in the console's OEM code page: the user's folder as %USERPROFILE% (it may hold Chinese).
  function CmdPath($p) { if ($p.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) { '%USERPROFILE%' + $p.Substring($HOME.Length) } else { $p } }
  function ShPath($p) { if ($p.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) { '$USERPROFILE' + $p.Substring($HOME.Length).Replace('\', '/') } else { $p.Replace('\', '/') } }

  try {
    $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $Arch = switch ($a) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "不支持这个处理器架构（$a）" } }

    $mirror = switch -Regex ("$env:CLAUDE_PRO_MIRROR") { '^(npmmirror|cn|china)$' { $true } '^official$' { $false } default { -not (Probe 'https://www.google.com') } }
    if ($mirror) { $NodeBase = 'https://npmmirror.com/mirrors/node'; $Registry = 'https://registry.npmmirror.com' }
    else { $NodeBase = 'https://nodejs.org/dist'; $Registry = 'https://registry.npmjs.org' }

    # ---------------------------------------------------------------- with the Node.js already installed
    $useSystem = $false
    if ($env:CLAUDE_PRO_USE_RUNTIME -ne '1' -and (Get-Command node.exe -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
      if ((MajorOf 'node.exe') -ge $MinMajor) {
        $prefix = "$(& npm.cmd prefix -g 2>$null)".Trim()
        if ($prefix -and (Writable $prefix)) { $useSystem = $true }
      }
    }

    if ($useSystem) {
      Step "用已安装的 Node.js $(& node.exe -v) 安装 claude-pro"
      & npm.cmd install -g $Pkg --registry $Registry --no-fund --no-audit --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
      # a portable install from before would come first on PATH: this one replaces it
      foreach ($f in 'claude-pro.cmd', 'claude-pro') {
        $p = Join-Path $BinDir $f
        if ((Test-Path -LiteralPath $p) -and (Select-String -LiteralPath $p -SimpleMatch $Mark -Quiet)) { Remove-Item -LiteralPath $p -Force }
      }
      $cmd = Join-Path $prefix 'claude-pro.cmd'
    } else {
      # ---------------------------------------------------------------- a portable Node.js for claude-pro alone
      $nodeDir = Join-Path $Runtime 'node'
      $nodeExe = Join-Path $nodeDir 'node.exe'
      if ((Test-Path -LiteralPath $nodeExe) -and ((MajorOf $nodeExe) -eq $NodeMajor)) {
        Step "使用已下载的 Node.js $(& $nodeExe -v)（$nodeDir）"
      } else {
        Step "下载 Node.js $NodeMajor（win-$Arch，来自 $(([uri]$NodeBase).Host)）"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('claude-pro-install-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $tmp | Out-Null
        try {
          Fetch "$NodeBase/index.json" (Join-Path $tmp 'index.json')
          $index = Get-Content -LiteralPath (Join-Path $tmp 'index.json') -Raw | ConvertFrom-Json
          $ver = ($index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version
          if (-not $ver) { throw "在 $NodeBase/index.json 里没有找到 Node.js $NodeMajor" }
          $file = "node-$ver-win-$Arch.zip"
          Fetch "$NodeBase/$ver/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
          $line = Get-Content -LiteralPath (Join-Path $tmp 'SHASUMS256.txt') | Where-Object { $_ -match ('\s' + [regex]::Escape($file) + '$') } | Select-Object -First 1
          if (-not $line) { throw "SHASUMS256.txt 里没有 $file" }
          $want = ($line -split '\s+')[0].ToLower()
          Note $file
          $zip = Join-Path $tmp $file
          Fetch "$NodeBase/$ver/$file" $zip
          $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
          if ($got -ne $want) { throw "下载的 $file 校验不通过（SHA256 不一致），请重试" }
          $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe' # (bsdtar, much faster than Expand-Archive)
          if (Test-Path -LiteralPath $tarExe) { & $tarExe -xf $zip -C $tmp; if ($LASTEXITCODE -ne 0) { throw '解压失败' } }
          else { Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp) }
          New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
          if (Test-Path -LiteralPath $nodeDir) {
            try { Remove-Item -LiteralPath $nodeDir -Recurse -Force } catch { throw "旧的 $nodeDir 删不掉：请先关闭正在运行的 claude-pro，再运行一次" }
          }
          Move-Item -LiteralPath (Join-Path $tmp "node-$ver-win-$Arch") -Destination $nodeDir
        } finally {
          Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
      # this Node's own npm settings (its built-in npmrc): the global directory is its own, the registry the one chosen;
      # /update uses them too. Nothing of the user's npm configuration is touched.
      [IO.File]::WriteAllText((Join-Path $nodeDir 'node_modules\npm\npmrc'), "prefix=$nodeDir`nregistry=$Registry/`nupdate-notifier=false`nfund=false`naudit=false`n")
      $npm = Join-Path $nodeDir 'npm.cmd'
      Step '安装 claude-pro'
      $savedPath = $env:Path
      $env:Path = "$nodeDir;$env:Path" # (npm's own scripts look for node on PATH)
      try {
        & $npm install -g $Pkg --prefix $nodeDir --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
      } finally { $env:Path = $savedPath }
      # (where the prefix puts it; not `npm root -g`, whose output npm masks where a path looks like a token)
      $entry = Join-Path $nodeDir "node_modules\$($Pkg.Replace('/', '\'))\bin\claude-pro.js"
      if (-not (Test-Path -LiteralPath $entry)) { throw "安装后没有找到 $entry" }
      # the command, for PowerShell and cmd (claude-pro.cmd) and Git Bash (claude-pro): this Node runs it
      New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
      $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
      [IO.File]::WriteAllText((Join-Path $BinDir 'claude-pro.cmd'), "@echo off`r`nrem $Mark`r`n`"$(CmdPath $nodeExe)`" `"$(CmdPath $entry)`" %*`r`n", $oem)
      [IO.File]::WriteAllText((Join-Path $BinDir 'claude-pro'), "#!/bin/sh`n# $Mark`nexec `"$(ShPath $nodeExe)`" `"$(ShPath $entry)`" `"`$@`"`n", (New-Object Text.UTF8Encoding $false))
      $cmd = Join-Path $BinDir 'claude-pro.cmd'

      # %USERPROFILE%\.claude-pro\bin first on the user's PATH (it holds only claude-pro), kept as an expandable string
      # so that the %VARIABLES% already in it still work
      if ($env:CLAUDE_PRO_NO_MODIFY_PATH -ne '1') {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = @($old -split ';' | Where-Object { $_ })
        $mine = @($BinDir, (CmdPath $BinDir))
        if (-not ($parts | Where-Object { $mine -contains $_ })) {
          $key.SetValue('Path', ((@(CmdPath $BinDir) + $parts) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
          # tell Explorer (and so the terminals opened from now on) that the environment changed
          Add-Type -Namespace ClaudePro -Name Env -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
          $r = [UIntPtr]::Zero
          $null = [ClaudePro.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
          Note "已把 $BinDir 加进你的 PATH"
        }
        $key.Close()
        if (-not (($env:Path -split ';') -contains $BinDir)) { $env:Path = "$BinDir;$env:Path" } # (this window too)
      }
    }

    $version = "$(& $cmd --version 2>$null)".Trim()
    if (-not $version) { throw "claude-pro 装好了但运行不起来：$cmd --version 没有输出" }

    # ---------------------------------------------------------------- Git for Windows (the Bash tool runs in Git Bash)
    $bash = @("$env:ProgramFiles\Git\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe") | Where-Object { Test-Path -LiteralPath $_ }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $bash -and -not $git -and $env:CLAUDE_PRO_SKIP_GIT -ne '1') {
      if ((Get-Command winget.exe -ErrorAction SilentlyContinue) -and -not $mirror) {
        Step '安装 Git for Windows（claude-pro 的 Bash 工具要用它；可能会弹出管理员确认）'
        & winget.exe install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent
        if ($LASTEXITCODE -ne 0) { Note '没装成，请手动安装：https://git-scm.com/download/win' }
      } else {
        Write-Host '    需要先装 Git for Windows（claude-pro 的 Bash 工具要用它）：' -ForegroundColor Yellow
        Note $(if ($mirror) { 'https://registry.npmmirror.com/binary.html?path=git-for-windows/' } else { 'https://git-scm.com/download/win' })
      }
    }

    Write-Host ''
    Write-Host "claude-pro $version 已安装" -ForegroundColor Green
    if ((Get-Command claude-pro -ErrorAction SilentlyContinue)) { Note '1. 进入你的项目目录，运行：claude-pro' }
    else { Note '1. 重新打开终端（Windows Terminal 要整个关掉再开），进入项目目录运行：claude-pro'; Note "   （不想重开也可以直接运行 $cmd）" }
    Note '2. 第一次启动会打开 /connect：选择 7bit.fun，粘贴在 https://7bit.fun/user 创建的 API Key'
    Note '3. 想用网页控制台：在 claude-pro 里输入 /web，或运行 claude-pro web'
  } catch {
    Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
  }
}
