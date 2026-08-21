// dsh-pathremap — 将旧版 Termux 前缀路径重映射到本 App 实际前缀。
//
// 背景：内嵌的 Termux 二进制（apt/dpkg/proot-distro/python 等）在编译时把
// /data/data/com.termux/files 硬编码进配置读取与安装路径；而本 App 实际前缀是
// /data/user/0/<pkg>/files/usr。libtermux-exec.so 只重映射 exec/shebang，
// 不重映射普通文件读取，且无 root 无法给 /data/data/com.termux 建符号链接。
//
// 方案：LD_PRELOAD 拦截 libc 文件类 API，把以旧前缀开头的路径重写为
// 环境变量 DSH_REMAP_PREFIX 指向的实际 files 目录（读写/创建/删除全部重映射，
// dpkg 的安装写入同样落到真实前缀）。仅重写前缀匹配的路径，其余原样透传。
// bionic 的 stat/open 即 64 位实现，无需 *64 变体。
#define _GNU_SOURCE
#include <dlfcn.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const char LEGACY[] = "/data/data/com.termux/files";
static const size_t LEGACY_LEN = sizeof(LEGACY) - 1;

static char real_prefix[PATH_MAX];
static size_t real_len = 0;

// 双缓冲：rename/symlink/link 等一次调用含两个路径，避免相互覆盖
static __thread char tls_buf[2][PATH_MAX];
static __thread int tls_idx = 0;

__attribute__((constructor)) static void remap_init(void) {
  const char *p = getenv("DSH_REMAP_PREFIX");
  if (p == NULL || *p == '\0') return;
  size_t n = strlen(p);
  while (n > 1 && p[n - 1] == '/') n--;
  if (n == 0 || n >= sizeof(real_prefix)) return;
  memcpy(real_prefix, p, n);
  real_prefix[n] = '\0';
  real_len = n;
}

// 命中旧前缀则返回重映射后的路径（线程局部缓冲），否则原样返回。
static const char *remap(const char *path) {
  if (real_len == 0 || path == NULL) return path;
  if (strncmp(path, LEGACY, LEGACY_LEN) != 0) return path;
  char c = path[LEGACY_LEN];
  if (c != '\0' && c != '/') return path;
  const char *rest = path + LEGACY_LEN;
  size_t rest_len = strlen(rest);
  char *buf = tls_buf[tls_idx];
  tls_idx ^= 1;
  if (real_len + rest_len + 1 > PATH_MAX) return path;
  memcpy(buf, real_prefix, real_len);
  memcpy(buf + real_len, rest, rest_len + 1);
  return buf;
}

#define REAL(fn) ((fn##_fn)dlsym(RTLD_NEXT, #fn))

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);
typedef int (*creat_fn)(const char *, mode_t);
typedef int (*access_fn)(const char *, int);
typedef int (*faccessat_fn)(int, const char *, int, int);
typedef int (*stat_fn)(const char *, struct stat *);
typedef int (*lstat_fn)(const char *, struct stat *);
typedef int (*fstatat_fn)(int, const char *, struct stat *, int);
typedef DIR *(*opendir_fn)(const char *);
typedef int (*mkdir_fn)(const char *, mode_t);
typedef int (*mkdirat_fn)(int, const char *, mode_t);
typedef int (*rmdir_fn)(const char *);
typedef int (*unlink_fn)(const char *);
typedef int (*unlinkat_fn)(int, const char *, int);
typedef int (*rename_fn)(const char *, const char *);
typedef int (*renameat_fn)(int, const char *, int, const char *);
typedef int (*chmod_fn)(const char *, mode_t);
typedef int (*fchmodat_fn)(int, const char *, mode_t, int);
typedef int (*chown_fn)(const char *, uid_t, gid_t);
typedef int (*fchownat_fn)(int, const char *, uid_t, gid_t, int);
typedef int (*symlink_fn)(const char *, const char *);
typedef int (*symlinkat_fn)(const char *, int, const char *);
typedef int (*link_fn)(const char *, const char *);
typedef ssize_t (*readlink_fn)(const char *, char *, size_t);
typedef ssize_t (*readlinkat_fn)(int, const char *, char *, size_t);
typedef char *(*realpath_fn)(const char *, char *);

// ── open 族 ────────────────────────────────────────────────────────────────
int open(const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  return REAL(open)(remap(path), flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  return REAL(openat)(dirfd, remap(path), flags, mode);
}

int creat(const char *path, mode_t mode) { return REAL(creat)(remap(path), mode); }

// bionic 对旧 API 级别导出 *64 别名符号（toybox ls 等直接链接 openat64），
// 必须一并拦截，否则绕过重映射。
int open64(const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  return open(path, flags, mode);
}

int openat64(int dirfd, const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  return openat(dirfd, path, flags, mode);
}

int creat64(const char *path, mode_t mode) { return creat(path, mode); }

// FORTIFY 强化符号：toybox（ls/cat 等）与部分 Termux 二进制直接链接
// __openat_2/__open_2（无 mode 参数），不拦截则绕过重映射。
int __openat_2(int dirfd, const char *path, int flags) {
  return openat(dirfd, path, flags);
}
int __open_2(const char *path, int flags) { return open(path, flags); }

// ── 存在性 / 状态查询 ──────────────────────────────────────────────────────
int access(const char *path, int mode) { return REAL(access)(remap(path), mode); }
int faccessat(int dirfd, const char *path, int mode, int flags) {
  return REAL(faccessat)(dirfd, remap(path), mode, flags);
}
int stat(const char *path, struct stat *st) { return REAL(stat)(remap(path), st); }
int lstat(const char *path, struct stat *st) { return REAL(lstat)(remap(path), st); }
int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
  return REAL(fstatat)(dirfd, remap(path), st, flags);
}

// bionic 的 *64 别名符号（struct stat64 与 struct stat 布局一致）
int stat64(const char *path, struct stat64 *st) { return stat(path, (struct stat *)st); }
int lstat64(const char *path, struct stat64 *st) { return lstat(path, (struct stat *)st); }
int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
  return fstatat(dirfd, path, (struct stat *)st, flags);
}

// ── 目录 ───────────────────────────────────────────────────────────────────
DIR *opendir(const char *path) { return REAL(opendir)(remap(path)); }
int mkdir(const char *path, mode_t mode) { return REAL(mkdir)(remap(path), mode); }
int mkdirat(int dirfd, const char *path, mode_t mode) {
  return REAL(mkdirat)(dirfd, remap(path), mode);
}
int rmdir(const char *path) { return REAL(rmdir)(remap(path)); }

// ── 删除 / 重命名 / 权限 ───────────────────────────────────────────────────
int unlink(const char *path) { return REAL(unlink)(remap(path)); }
int unlinkat(int dirfd, const char *path, int flags) {
  return REAL(unlinkat)(dirfd, remap(path), flags);
}
int rename(const char *oldp, const char *newp) {
  return REAL(rename)(remap(oldp), remap(newp));
}
int renameat(int oldfd, const char *oldp, int newfd, const char *newp) {
  return REAL(renameat)(oldfd, remap(oldp), newfd, remap(newp));
}
int chmod(const char *path, mode_t mode) { return REAL(chmod)(remap(path), mode); }
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
  return REAL(fchmodat)(dirfd, remap(path), mode, flags);
}
int chown(const char *path, uid_t u, gid_t g) { return REAL(chown)(remap(path), u, g); }
int fchownat(int dirfd, const char *path, uid_t u, gid_t g, int flags) {
  return REAL(fchownat)(dirfd, remap(path), u, g, flags);
}

// ── 链接 ───────────────────────────────────────────────────────────────────
int symlink(const char *target, const char *linkpath) {
  return REAL(symlink)(remap(target), remap(linkpath));
}
int symlinkat(const char *target, int dirfd, const char *linkpath) {
  return REAL(symlinkat)(remap(target), dirfd, remap(linkpath));
}
int link(const char *oldp, const char *newp) {
  return REAL(link)(remap(oldp), remap(newp));
}
ssize_t readlink(const char *path, char *buf, size_t len) {
  return REAL(readlink)(remap(path), buf, len);
}
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t len) {
  return REAL(readlinkat)(dirfd, remap(path), buf, len);
}

// realpath：重映射输入；输出为真实前缀路径（调用方后续 open 仍会被重映射）
char *realpath(const char *path, char *resolved) {
  return REAL(realpath)(remap(path), resolved);
}
