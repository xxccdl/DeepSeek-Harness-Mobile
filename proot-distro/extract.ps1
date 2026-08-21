$root = "d:\code\dsh-gui\dsh-mobile\app\proot-distro"
$debs = Get-ChildItem "$root\debs\*.deb"
New-Item -ItemType Directory -Force -Path "$root\merged" | Out-Null
foreach ($d in $debs) {
  $tmp = Join-Path $root ("t_" + [System.IO.Path]::GetFileNameWithoutExtension($d.Name))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  tar -xf $d.FullName -C $tmp
  $data = Join-Path $tmp "data.tar.xz"
  if (Test-Path $data) { tar -xf $data -C "$root\merged" }
}
Write-Output "bin:"
Get-ChildItem "$root\merged\data\data\com.termux\files\usr\bin" | Select-Object Name
Write-Output "lib python:"
Get-ChildItem "$root\merged\data\data\com.termux\files\usr\lib" -Directory | Select-Object Name
