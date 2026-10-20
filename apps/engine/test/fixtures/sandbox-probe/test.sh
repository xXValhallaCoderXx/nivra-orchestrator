#!/bin/sh
# Passes when greet.sh, beside this file, prints what the first argument expects.
expected="${1:-Hello, world}"
actual="$(sh "$(dirname "$0")/greet.sh")"
if [ "$actual" = "$expected" ]; then
  echo "PASS: $actual"
  exit 0
fi
echo "FAIL: expected '$expected', got '$actual'"
exit 1
