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
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
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
  // dereference: 把符号链接解引用为实体文件拷贝，避免链接指向开发机绝对路径
  cpSync(u, USR, { recursive: true, force: true, dereference: true })
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
  if (existsSync(srclib)) cpSync(srclib, join(USR, 'lib'), { recursive: true, force: true, dereference: true })
  rmSync(tmp, { recursive: true, force: true })
}

/**
 * 把 STAGE 里所有符号链接替换为真实文件拷贝（解引用实体化）。
 * Windows cpSync 会把相对符号链接写成指向开发机绝对路径（如 //?/D:/...），
 * 在 Android 上完全失效，导致 apt/node 等加载 .so 时找不到依赖库。
 * 这里遍历替换成实体文件，确保包内不含任何指向开发机的链接。
 */
function dereferenceSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (entry.isDirectory()) {
      dereferenceSymlinks(p)
      continue
    }
    if (!st.isSymbolicLink()) continue
    // 1) 正常路径：读链接目标并解引用（相对/本机绝对都试）
    let real
    try { real = readlinkSync(p) } catch { continue }
    const absTarget = resolve(dirname(p), real)
    if (existsSync(absTarget)) {
      rmSync(p, { force: true })
      cpSync(absTarget, p, { recursive: true, force: true, dereference: true })
      continue
    }
    // 2) 兜底：链接指向开发机 Windows 绝对路径（node:path.resolve 会把 D:\ 当相对路径算错）。
    //    此时同目录里必然有以"链接 basename"为前缀的实体文件（如 libtalloc.so → libtalloc.so.2.4.3），
    //    取第一个匹配的实体文件复制过来，替换掉失效链接。
    const base = entry.name
    const siblings = readdirSync(dir).filter((f) => f !== base &&
      (f === base || f.startsWith(base + '.')))
    // 排除仍是链接的项，避免复制到自身
    const realCand = siblings.find((f) => { try { return !lstatSync(join(dir, f)).isSymbolicLink() } catch { return false } })
    if (realCand) {
      rmSync(p, { force: true })
      cpSync(join(dir, realCand), p, { recursive: true, force: true, dereference: true })
    }
  }
}
dereferenceSymlinks(USR)

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