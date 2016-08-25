#!/bin/bash

set -e

egrep '^[a-z0-9]+ *=' "passwd/$1" | awk '{print $1}'
