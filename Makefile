.PHONY: all dev build test lint install clean

all: build

dev:
	npm run dev

build:
	npm run build

install: build
	@set -eu; \
	arch=$$(node -p 'process.arch'); \
	case "$$arch" in arm64) source=release/mac-arm64/Tau.app ;; x64) source=release/mac/Tau.app ;; *) echo "Unsupported architecture: $$arch" >&2; exit 1 ;; esac; \
	npx electron-builder --mac --"$$arch" --dir --publish never; \
	test -d "$$source"; \
	target=/Applications/Tau.app; \
	stage=$$(mktemp -d /Applications/.tau-install.XXXXXX); \
	cleanup() { \
		status=$$?; \
		trap - EXIT HUP INT TERM; \
		if [ -e "$$stage/previous.app" ] || [ -L "$$stage/previous.app" ]; then \
			if [ ! -e "$$target" ] && [ ! -L "$$target" ]; then mv "$$stage/previous.app" "$$target" || { echo "Previous app preserved at $$stage/previous.app" >&2; exit 1; }; \
			else echo "Previous app preserved at $$stage/previous.app" >&2; exit "$$status"; fi; \
		fi; \
		rm -rf "$$stage"; \
		exit "$$status"; \
	}; \
	trap cleanup EXIT; \
	trap 'exit 1' HUP INT TERM; \
	cp -R "$$source" "$$stage/Tau.app"; \
	xattr -dr com.apple.quarantine "$$stage/Tau.app" 2>/dev/null || true; \
	osascript -e 'if application "Tau" is running then tell application "Tau" to quit'; \
	if [ -e "$$target" ] || [ -L "$$target" ]; then mv "$$target" "$$stage/previous.app"; fi; \
	mv "$$stage/Tau.app" "$$target"; \
	rm -rf "$$stage/previous.app"; \
	echo "Tau.app successfully installed to $$target (v$$(defaults read "$$target/Contents/Info.plist" CFBundleShortVersionString))"

test:
	npm test

lint:
	npm run lint

clean:
	rm -rf dist dist-electron dist-kits release
