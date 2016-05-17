#!/bin/bash

set -e

REPO="$(svn info | grep 'Repository Root' | cut -d '/' -f 3-)"

if ! grep -q "^$1 *= *$2$" "$REPO/conf/passwd" ; then
    echo "Invalid password." >&2
    exit 1
fi
