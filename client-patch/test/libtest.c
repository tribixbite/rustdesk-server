/* Calls the getifaddrs()/freeifaddrs() inside a real librustdesk.so by address and
 * compares the result with bionic's own getifaddrs(). Runs in Termux on Android,
 * where the kernel refuses the RTM_GETLINK dump the way it does for the app.
 *
 * usage: libtest <dir with librustdesk.so and libc++_shared.so> [expect-fail]
 * Exit 0 when the outcome matches the expectation (default: same addresses).
 */
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <ifaddrs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Virtual addresses in the 1.5.3 build (see patch_librustdesk.py). */
#define ANCHOR_NAME "wire_query_onlines"
#define ANCHOR_VADDR 0xec2f90UL
#define GETIFADDRS_VADDR 0x1bfd1d4UL
#define FREEIFADDRS_VADDR 0x1bfd1a8UL

typedef int (*getifaddrs_fn)(struct ifaddrs **);
typedef void (*freeifaddrs_fn)(struct ifaddrs *);

/* Sorted "name address" lines for inet addresses. */
static int collect(struct ifaddrs *head, char out[][96], int max)
{
    int n = 0;
    for (struct ifaddrs *i = head; i && n < max; i = i->ifa_next) {
        char a[INET6_ADDRSTRLEN] = "";
        if (!i->ifa_addr)
            continue;
        int fam = i->ifa_addr->sa_family;
        if (fam == AF_INET)
            inet_ntop(fam, &((struct sockaddr_in *)i->ifa_addr)->sin_addr, a, sizeof a);
        else if (fam == AF_INET6)
            inet_ntop(fam, &((struct sockaddr_in6 *)i->ifa_addr)->sin6_addr, a, sizeof a);
        else
            continue;
        snprintf(out[n++], 96, "%s %s", i->ifa_name, a);
    }
    qsort(out, n, 96, (int (*)(const void *, const void *))strcmp);
    return n;
}

int main(int argc, char **argv)
{
    static char want[64][96], got[64][96];
    char path[4096];
    if (argc < 2) {
        fprintf(stderr, "usage: %s <libdir> [expect-fail]\n", argv[0]);
        return 2;
    }
    int expect_fail = argc > 2 && !strcmp(argv[2], "expect-fail");

    /* libc++_shared.so is resolved by soname; load it from the same dir first. */
    snprintf(path, sizeof path, "%s/libc++_shared.so", argv[1]);
    if (!dlopen(path, RTLD_NOW | RTLD_GLOBAL)) {
        fprintf(stderr, "dlopen %s: %s\n", path, dlerror());
        return 2;
    }
    snprintf(path, sizeof path, "%s/librustdesk.so", argv[1]);
    void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!h) {
        fprintf(stderr, "dlopen %s: %s\n", path, dlerror());
        return 2;
    }
    char *anchor = dlsym(h, ANCHOR_NAME);
    if (!anchor) {
        fprintf(stderr, "dlsym %s: %s\n", ANCHOR_NAME, dlerror());
        return 2;
    }
    char *base = anchor - ANCHOR_VADDR;
    getifaddrs_fn lib_get = (getifaddrs_fn)(base + GETIFADDRS_VADDR);
    freeifaddrs_fn lib_free = (freeifaddrs_fn)(base + FREEIFADDRS_VADDR);

    struct ifaddrs *mine = NULL, *ref = NULL;
    errno = 0;
    int rc = lib_get(&mine);
    int err = errno;
    if (getifaddrs(&ref) != 0) {
        perror("bionic getifaddrs");
        return 2;
    }
    if (rc != 0) {
        printf("library getifaddrs failed: %s\n", strerror(err));
        freeifaddrs(ref);
        return expect_fail ? 0 : 1;
    }
    int nw = collect(ref, want, 64), ng = collect(mine, got, 64);
    int same = nw == ng && nw > 0;
    for (int i = 0; same && i < nw; i++)
        same = !strcmp(want[i], got[i]);
    printf("library getifaddrs: %d addresses, bionic %d, %s\n", ng, nw, same ? "identical" : "DIFFERENT");
    lib_free(mine); /* must pair with whichever getifaddrs produced the list */
    freeifaddrs(ref);
    if (expect_fail)
        return 1;
    return same ? 0 : 1;
}
