param([Parameter(Mandatory=$true)][string]$Script, [string[]]$ScriptArgs = @())
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:DSH_NODE_EXECUTABLE
$allArgs = @($Script) + $ScriptArgs
$start.Arguments = ($allArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[Console]::Out.Write($stdout)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
