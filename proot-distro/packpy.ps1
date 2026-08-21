$root = "d:\code\dsh-gui\dsh-mobile\app\proot-distro"
$sp = "$root\p2\data\data\com.termux\files\usr\lib\python3.14\site-packages"
tar -czf "$root\proot-distro-py.tar.gz" -C $sp proot_distro
Write-Output "packed:"
Get-Item "$root\proot-distro-py.tar.gz" | Select-Object Length
