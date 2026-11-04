# AccessCare AI — runs the downloaded app on this computer only (http://localhost:8000).
# Uses Windows' built-in PowerShell; nothing is installed. Close this window to stop it.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'app'
$port = 8000
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.webmanifest'='application/manifest+json'; '.json'='application/json';
            '.png'='image/png'; '.glb'='model/gltf-binary'; '.wasm'='application/wasm'; '.task'='application/octet-stream'; '.css'='text/css' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "AccessCare AI is running at http://localhost:$port/  (close this window to stop)"
Start-Process "http://localhost:$port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($path -eq '') { $path = 'index.html' }
  $file = [IO.Path]::GetFullPath((Join-Path $root $path))
  if (-not $file.StartsWith([IO.Path]::GetFullPath($root)) -or -not (Test-Path $file -PathType Leaf)) {
    $ctx.Response.StatusCode = 404; $ctx.Response.Close(); continue
  }
  $ext = [IO.Path]::GetExtension($file).ToLower()
  $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
  $bytes = [IO.File]::ReadAllBytes($file)
  $ctx.Response.ContentLength64 = $bytes.Length
  try { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) } catch { }
  $ctx.Response.Close()
}
