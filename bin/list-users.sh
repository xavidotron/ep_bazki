#!/bin/bash

set -e

REPO="$(svn info | grep 'Repository Root' | cut -d '/' -f 3-)"

egrep '^[a-z]+ *=' "$REPO/conf/passwd" | awk '{print $1}'
