#!/bin/sh
set -eu

data_directory="${SHARD_SYNC_DATA_DIR:-/data}"
if [ -z "$data_directory" ] || [ "$data_directory" = "/" ]; then
	echo "Refusing unsafe SHARD_SYNC_DATA_DIR: $data_directory" >&2
	exit 1
fi

mkdir -p "$data_directory"
chown node:node "$data_directory"

exec setpriv --reuid=node --regid=node --init-groups node build
