#!/bin/bash

set -e

if ! grep -q "^$2 *= *$3$" "passwd/$1" ; then
    echo "Invalid password." >&2
    exit 1
fi
