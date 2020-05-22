#!/bin/bash

set -e

while [ -n "$1" ] ; do
    cmd="$(echo "$2" | cut -d : -f 1)"
    if [ "$cmd" == "rm" ] ; then
        # May already have been done by svn.rmdir.
        git rm --force "$1" > /dev/null
        git commit -m "$3 deleted $1 via etherpad" "$1" > /dev/null
    elif [ "$cmd" == "mv" ] ; then
        extra="$(echo "$2" | cut -d : -f 2-)"
        # Assume already moved by svn.mv.
        git commit -m "$3 moved $1 via etherpad" "$1" "$extra" > /dev/null
    else
        git add "$1" > /dev/null
        git commit -m "$3 edited $1 via etherpad" "$1" > /dev/null
    fi

    shift 3
done

git pull --rebase
git push
