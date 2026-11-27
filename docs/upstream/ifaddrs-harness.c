/* Compare the patched shim with bionic's getifaddrs(), with RTM_GETLINK
 * allowed and with it refused (EACCES, as Android 11+ does for apps that
 * target API 30+). usage: harness [refuse] */
#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

int rd_getifaddrs(struct ifaddrs **);
void rd_freeifaddrs(struct ifaddrs *);
static int refuse;

ssize_t rd_test_sendto(int fd, const void *buf, size_t len, int flags,
                       const struct sockaddr *to, socklen_t tolen)
{
    const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
    if (refuse && len >= sizeof(*nlh) && nlh->nlmsg_type == RTM_GETLINK) {
        errno = EACCES;
        return -1;
    }
    return sendto(fd, buf, len, flags, to, tolen);
}

/* One line per inet address: "name addr flags-up". */
static int dump(struct ifaddrs *head, char out[][96], int max)
{
    int n = 0;
    for (struct ifaddrs *i = head; i && n < max; i = i->ifa_next) {
        char a[INET6_ADDRSTRLEN] = "";
        if (!i->ifa_addr) continue;
        int fam = i->ifa_addr->sa_family;
        if (fam == AF_INET)
            inet_ntop(fam, &((struct sockaddr_in *)i->ifa_addr)->sin_addr, a, sizeof a);
        else if (fam == AF_INET6)
            inet_ntop(fam, &((struct sockaddr_in6 *)i->ifa_addr)->sin6_addr, a, sizeof a);
        else continue;
        snprintf(out[n++], 96, "%s %s up=%d", i->ifa_name, a, !!(i->ifa_flags & IFF_UP));
    }
    return n;
}

static int cmp(const void *x, const void *y) { return strcmp(x, y); }

int main(int argc, char **argv)
{
    static char want[64][96], got[64][96];
    struct ifaddrs *a, *b;
    refuse = argc > 1 && !strcmp(argv[1], "refuse");
    if (getifaddrs(&a) != 0) { perror("bionic getifaddrs"); return 2; }
    if (rd_getifaddrs(&b) != 0) { perror("shim getifaddrs"); return 1; }
    int nw = dump(a, want, 64), ng = dump(b, got, 64);
    qsort(want, nw, 96, cmp); qsort(got, ng, 96, cmp);
    int ok = nw == ng && nw > 0;
    for (int i = 0; ok && i < nw; i++) ok = !strcmp(want[i], got[i]);
    for (int i = 0; i < ng; i++) printf("  %s\n", got[i]);
    printf("%s: shim %d addresses, bionic %d (%s)\n", ok ? "PASS" : "FAIL", ng, nw,
           refuse ? "RTM_GETLINK refused" : "RTM_GETLINK allowed");
    freeifaddrs(a); rd_freeifaddrs(b);
    return ok ? 0 : 1;
}
