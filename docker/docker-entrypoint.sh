#!/bin/sh
set -eu

data_directory="${SCRAPSCACHE_SYNC_DATA_DIR:-/data}"
if [ -z "$data_directory" ] || [ "$data_directory" = "/" ]; then
	echo "Refusing unsafe SCRAPSCACHE_SYNC_DATA_DIR: $data_directory" >&2
	exit 1
fi

mkdir -p "$data_directory"
chown node:node "$data_directory"

backup_directory="${SCRAPSCACHE_BACKUP_DIR:-}"
if [ -n "$backup_directory" ]; then
	if [ "$backup_directory" = "/" ]; then
		echo "Refusing unsafe SCRAPSCACHE_BACKUP_DIR: $backup_directory" >&2
		exit 1
	fi
	mkdir -p "$backup_directory"
	chown node:node "$backup_directory"
fi

exec setpriv --reuid=node --regid=node --init-groups node build
