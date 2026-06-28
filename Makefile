# Airc — build & deploy helpers.
#
# The Android APK is modeled as a real file target whose prerequisites are the
# Kotlin / resource / manifest / gradle sources. So `make push` only rebuilds
# when something actually changed; otherwise it installs the existing APK.
# (Gradle still does the real incremental work — make just gates the rebuild.)

# --- Config (override on the command line, e.g. `make ADB=adb push`) ----------
ANDROID_DIR := android-app
GRADLEW     := ./gradlew --no-daemon
ADB         := $(HOME)/android/platform-tools/adb
APP_ID      := dev.airc.tmuxremote

APK     := $(ANDROID_DIR)/app/build/outputs/apk/debug/app-debug.apk
RELEASE_APK := $(ANDROID_DIR)/app/build/outputs/apk/release/app-release.apk
SOURCES := $(shell find $(ANDROID_DIR)/app/src -type f 2>/dev/null) \
           $(ANDROID_DIR)/app/build.gradle.kts \
           $(ANDROID_DIR)/build.gradle.kts \
           $(ANDROID_DIR)/settings.gradle.kts \
           $(ANDROID_DIR)/gradle.properties

# Version-stamped name for the release artifact uploaded to GitHub, e.g.
# airc-v1.7.0.apk. Mirrors BuildConfig.GIT_DESCRIBE baked into the build.
VERSION  := $(shell git describe --tags --always --dirty 2>/dev/null || echo unknown)
DIST_APK := airc-$(VERSION).apk

.DEFAULT_GOAL := help

# --- Targets ------------------------------------------------------------------

## build: assemble the debug APK (only when sources changed)
.PHONY: build
build: $(APK)

# The actual file rule: gradle reruns whenever a source is newer than the APK.
$(APK): $(SOURCES)
	cd $(ANDROID_DIR) && $(GRADLEW) assembleDebug

## release-apk: assemble the signed release APK as airc-<version>.apk (for GitHub releases)
.PHONY: release-apk
release-apk:
	@test -f $(ANDROID_DIR)/keystore.properties || \
		{ echo "error: $(ANDROID_DIR)/keystore.properties missing — release would be debug-signed"; exit 1; }
	cd $(ANDROID_DIR) && $(GRADLEW) assembleRelease
	cp $(RELEASE_APK) $(DIST_APK)
	@echo "built $(DIST_APK)"

## push: build a fresh APK if needed, then install it on the connected device
.PHONY: push install
push install: $(APK)
	$(ADB) install -r $(APK)

## launch: start the app on the device (no need to know the activity name)
.PHONY: launch
launch:
	$(ADB) shell monkey -p $(APP_ID) -c android.intent.category.LAUNCHER 1

## deploy: push the APK and launch it
.PHONY: deploy
deploy: push launch

## devices: list connected adb devices
.PHONY: devices
devices:
	$(ADB) devices -l

## check: run the Node/server checks
.PHONY: check
check:
	npm run check

## clean: remove Gradle build outputs
.PHONY: clean
clean:
	cd $(ANDROID_DIR) && $(GRADLEW) clean

## help: list available targets
.PHONY: help
help:
	@echo "Airc make targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
