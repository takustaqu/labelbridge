#!/bin/sh
# BTBridge.app をビルドする（macOS）。出力: target/BTBridge.app
set -eu
cd "$(dirname "$0")/../.."
APP=target/BTBridge.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp tools/bt-bridge/Info.plist "$APP/Contents/Info.plist"
swiftc -O -o "$APP/Contents/MacOS/bt-bridge" tools/bt-bridge/main.swift
codesign --force --sign - "$APP"
echo "built $APP"
