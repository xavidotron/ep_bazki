#!/bin/bash

set -e

REPO="$(svn info | grep 'Repository Root' | cut -d '/' -f 3-)"

echo "$1 = $2" >> "$REPO/conf/passwd"
