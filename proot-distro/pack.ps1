$root = "d:\code\dsh-gui\dsh-mobile\app\proot-distro"
$usr = "$root\merged\data\data\com.termux\files"
tar -czf "$root\usr-add.tar.gz" -C $usr usr
Write-Output "packed:"
Get-Item "$root\usr-add.tar.gz" | Select-Object Length
