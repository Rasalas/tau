.PHONY: all dev build test lint install clean

all: build

dev:
	npm run dev

build:
	npm run build

install: build
	npx electron-builder --mac --dir --publish never
	@osascript -e 'tell application "Tau" to quit' 2>/dev/null || true
	@rm -rf /Applications/Tau.app
	@cp -R release/mac-arm64/Tau.app /Applications/Tau.app
	@xattr -dr com.apple.quarantine /Applications/Tau.app 2>/dev/null || true
	@echo "Tau.app successfully installed to /Applications/Tau.app (v$$(defaults read /Applications/Tau.app/Contents/Info.plist CFBundleShortVersionString))"

test:
	npm test

lint:
	npm run lint

clean:
	rm -rf dist dist-electron dist-kits release
