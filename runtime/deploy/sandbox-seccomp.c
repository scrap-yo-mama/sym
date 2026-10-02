// SPDX-License-Identifier: AGPL-3.0-only
// Filtre seccomp de l'enfant du bac à sable (INV7, revue 4.1b). Le profil seccomp du compose (seccomp-chromium.json)
// permet clone, setns et unshare à TOUT le conteneur, parce que le bac à sable de Chromium crée des espaces de noms utilisateur.
// L'enfant du bac à sable (uid dédié 1500) n'en a pas besoin : ce programme, exécuté par le lanceur juste après le
// changement d'uid (SANDBOX_SECCOMP, apps/worker/src/sandbox/engine.ts), pose un filtre qui refuse unshare, setns et clone
// avec un drapeau CLONE_NEW* (EPERM), rend clone3 indisponible (ENOSYS : glibc se replie sur clone, dont les drapeaux sont
// lisibles par le filtre), puis exécute la commande. Le filtre est hérité par tout ce qui suit (shell, env, Node) et ne
// peut pas être retiré. Un enfant évadé deux fois n'obtient donc aucun espace de noms utilisateur, donc aucune capacité
// dans un espace imbriqué (surface netfilter, mount… du noyau fermée).
//   sandbox-seccomp <commande absolue> [arguments…]
//   sandbox-seccomp --self-test     (pose le filtre, essaie chaque appel refusé et un clone ordinaire, écrit le résultat en JSON)
// Construit dans deploy/Dockerfile (étape seccomp), sans dépendance hors de la libc.
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__)
#define FILTER_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define FILTER_ARCH AUDIT_ARCH_AARCH64
#else
#error "architecture non prise en charge (x86_64, aarch64)"
#endif

// CLONE_NEWTIME (0x80) n'existe que pour unshare et clone3, tous deux refusés ; dans clone, ce bit est celui du signal.
#define NS_FLAGS (CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET)

#define LOAD(field) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, field))
#define RET(value) BPF_STMT(BPF_RET | BPF_K, (value))

static struct sock_filter filter[] = {
    // Autre architecture (appels 32 bits) : processus tué.
    LOAD(arch),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FILTER_ARCH, 1, 0),
    RET(SECCOMP_RET_KILL_PROCESS),
    LOAD(nr),
#if defined(__x86_64__)
    // ABI x32 (numéros à partir de 0x40000000) : refusée.
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 7, 0),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_unshare, 6, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setns, 5, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 5, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 2),
    // clone : drapeaux en premier argument (x86_64 et aarch64), 32 bits de poids faible (petit-boutiste).
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, NS_FLAGS, 1, 0),
    RET(SECCOMP_RET_ALLOW),
    RET(SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    RET(SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
};

static int install(void) {
  struct sock_fprog prog = {.len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0);
}

static const char *outcome(long r) {
  if (r == 0) return "ok";
  if (errno == EPERM) return "EPERM";
  if (errno == ENOSYS) return "ENOSYS";
  return "autre";
}

// clone brut (comme un fork) avec des drapeaux supplémentaires ; l'enfant sort aussitôt.
static const char *try_clone(unsigned long flags) {
  long pid = syscall(SYS_clone, flags | SIGCHLD, 0, 0, 0, 0);
  if (pid == 0) _exit(0);
  if (pid < 0) return outcome(-1);
  waitpid((pid_t)pid, NULL, 0);
  return "ok";
}

static int self_test(void) {
  const char *unshare_user = outcome(unshare(CLONE_NEWUSER));
  const char *unshare_net = outcome(unshare(CLONE_NEWNET));
  const char *setns_ = outcome(setns(-1, 0));
  const char *clone3_ = outcome(syscall(SYS_clone3, NULL, 0));
  const char *clone_user = try_clone(CLONE_NEWUSER);
  const char *clone_net = try_clone(CLONE_NEWNET);
  const char *clone_plain = try_clone(0);
  printf("{\"unshareUser\":\"%s\",\"unshareNet\":\"%s\",\"setns\":\"%s\",\"clone3\":\"%s\",\"cloneUser\":\"%s\",\"cloneNet\":\"%s\",\"clone\":\"%s\"}\n",
         unshare_user, unshare_net, setns_, clone3_, clone_user, clone_net, clone_plain);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage : sandbox-seccomp <commande absolue> [arguments…] | --self-test\n");
    return 126;
  }
  if (install() != 0) {
    fprintf(stderr, "sandbox-seccomp : filtre seccomp non posé (%s)\n", strerror(errno));
    return 126;
  }
  if (strcmp(argv[1], "--self-test") == 0) return self_test();
  execv(argv[1], &argv[1]);
  fprintf(stderr, "sandbox-seccomp : exec %s : %s\n", argv[1], strerror(errno));
  return 127;
}
