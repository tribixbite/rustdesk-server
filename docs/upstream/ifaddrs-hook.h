/* Test-only: route the shim's symbols to test names (see ifaddrs-harness.c). */
#define sendto rd_test_sendto
#define getifaddrs rd_getifaddrs
#define freeifaddrs rd_freeifaddrs
