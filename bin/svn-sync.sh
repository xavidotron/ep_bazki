#!/bin/bash

set -e

svn up --accept theirs-conflict | ( grep '^.    ' || : )

while [ -n "$1" ] ; do
    cmd="$(echo "$2" | cut -d : -f 1)"
    extra=""
    if [ "$cmd" == "rm" ] ; then
        # May already have been done by svn.rmdir.
        svn rm --force "$1" > /dev/null
        verb=deleted
    elif [ "$cmd" == "mv" ] ; then
        extra="$(echo "$2" | cut -d : -f 2-)"
        # Assume already moved by svn.mv.
        verb=moved
    else
        svn add --force "$1" > /dev/null
        verb=edited
    fi
    svn ci -m "$3 $verb $1 via etherpad" "$1" "$extra" > /dev/null

    shift 3
done
