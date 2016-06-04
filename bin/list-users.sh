#!/bin/bash

set -e

egrep '^[a-z]+ *=' "passwd/$1" | awk '{print $1}'
