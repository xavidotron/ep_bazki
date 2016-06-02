#!/bin/bash

set -e

if [ -z "$1" ] ; then
    echo "No project specified." >&2
    exit 1
fi

if [ -z "$2" ] ; then
    echo "No initial user specified." >&2
    exit 1
fi

if [ -z "$3" ] ; then
    echo "No initial password specified." >&2
    exit 1
fi

if [ -e checkouts/"$1" ] ; then
    echo "Project $1 already exists." >&2
    exit 1
fi

svnadmin create repos/"$1"

echo "$2 = $3" >> repos/"$1"/conf/passwd
sed -ri 's/#? *anon-access = .*/anon-access = none/;s/#? *password-db = .*/password-db = passwd/' repos/"$1"/conf/svnserve.conf

svn co "file://`pwd`/repos/$1" checkouts/"$1"
