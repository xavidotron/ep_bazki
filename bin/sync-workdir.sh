#!/bin/bash

set -e

if ! [ -e "$1" ] ; then
    svn co "file://$HOME/repos/$1/" ~/workdirs/"$1"
else
    svn up ~/workdirs/"$1"
fi
