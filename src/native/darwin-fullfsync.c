#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("usage: darwin-fullfsync <path> [path ...]\n", stderr);
    return 2;
  }

  for (int index = 1; index < argc; index += 1) {
    int descriptor = open(argv[index], O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) {
      fprintf(stderr, "open failed: %s\n", strerror(errno));
      return 1;
    }
    if (fcntl(descriptor, F_FULLFSYNC) < 0) {
      int saved_errno = errno;
      close(descriptor);
      fprintf(stderr, "F_FULLFSYNC failed: %s\n", strerror(saved_errno));
      return 1;
    }
    if (close(descriptor) < 0) {
      fprintf(stderr, "close failed: %s\n", strerror(errno));
      return 1;
    }
  }

  return 0;
}
