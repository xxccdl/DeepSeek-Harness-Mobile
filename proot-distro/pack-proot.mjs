/**
 * 打包 proot-distro 运行时（proot + proot-distro + python3.14 + 依赖库）
 * -> app/android/app/src/main/assets/dsh/proot-distro.dat
 *
 * 用 Node 而非 PowerShell 打包：PowerShell 5.1 在 AMSI 扫描脚本时
 * 会间歇性 AccessViolationException 崩溃，Node/大文件复制不受影响。
 *
 * 数据来源（均为 Termux deb 的 data/data/com.termux/files/usr 结构）：
 *   p1/      proot + loader（bin/proot 已 RUNPATH -> $ORIGIN/../lib）
 *   p2/      proot-distro 脚本 + proot_distro 包（login 已 patch 转发 PROOT_LOADER）
 *   merged/  python3.14 + stdlib + 原生依赖库
 *   libtalloc.deb / shmem.deb   libtalloc.so.2 / libandroid-shmem.so
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = 'd:/code/dsh-gui/dsh-mobile/app/proot-distro'
const STAGE = join(ROOT, 'stage-usr')
const USR = join(STAGE, 'usr')
const OUT = 'd:/code/dsh-gui/dsh-mobile/app/android/app/src/main/assets/dsh/proot-distro.dat'

function mergeUsr(part) {
  const u = join(ROOT, part, 'data/data/com.termux/files/usr')
  if (!existsSync(u)) {
    console.log('!! missing ' + u)
    return
  }
  cpSync(u, USR, { recursive: true, force: true })
}

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(USR, { recursive: true })

mergeUsr('p1')      // proot + loader
mergeUsr('p2')      // proot-distro scripts + proot_distro package
mergeUsr('merged')  // python3.14 + stdlib + native libs

// 去掉运行时不需要的 include/ 头文件与 share/ 文档，减小体积
for (const d of ['include', 'share']) {
  rmSync(join(USR, d), { recursive: true, force: true })
}

// libtalloc / libandroid-shmem（独立 deb，Termux deb 结构）
for (const deb of ['libtalloc.deb', 'shmem.deb']) {
  const tmp = join(ROOT, 't_' + deb.replace(/\.deb$/, ''))
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execSync(`tar -xf "${join(ROOT, deb)}" -C "${tmp}"`, { stdio: 'pipe' })
  execSync(`tar -xf "${join(tmp, 'data.tar.xz')}" -C "${tmp}"`, { stdio: 'pipe' })
  const srclib = join(tmp, 'data/data/com.termux/files/usr/lib')
  if (existsSync(srclib)) cpSync(srclib, join(USR, 'lib'), { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
}

// 打包（prefix 相对：含 usr/ 根）
rmSync(OUT, { force: true })
execSync(`tar -czf "${OUT}" -C "${STAGE}" usr`, { stdio: 'pipe' })

console.log('packed: ' + OUT + ' = ' + (statSync(OUT).size / 1048576).toFixed(1) + ' MB')

// 关键文件校验
const list = execSync(`tar -tf "${OUT}"`, { encoding: 'utf8' })
for (const f of [
  'usr/bin/proot', 'usr/libexec/proot/loader', 'usr/libexec/proot/loader32',
  'usr/bin/python3.14', 'usr/bin/pd', 'usr/bin/proot-distro',
  'usr/lib/libtalloc.so.2', 'usr/lib/libandroid-shmem.so',
  'site-packages/proot_distro/cli.py',
]) {
  console.log((list.includes(f) ? '  OK  ' : '  MISS') + ' ' + f)
}