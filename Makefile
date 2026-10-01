# GenGIS build and release targets.
#   make serve        run the app locally at http://localhost:8080
#   make install      install the Electron build tooling
#   make build        build the desktop app for this machine's OS (output in dist/)
#   make build-win    build the Windows installer (NSIS)
#   make build-mac    build the macOS disk image (needs macOS)
#   make build-linux  build the Linux AppImage and .deb
#   make dist-all     build all three on one machine (fully supported only on macOS)
#   make release      used by the Release workflow (CI=1): bump the version from the conventional commits
#                     since the last tag, update the version shown in the app, commit, tag and push. The
#                     workflow then builds the installers and deploys GitHub Pages. Releases are started
#                     by hand: Actions -> Release -> Run workflow (nothing is released by a merge).
#                     Local use (needs permission to push main): BUMP=major|minor|patch|prerelease, PRE=Beta, DRY=1
#   make version      print the current version

NPX ?= npx
BUMP ?= auto
PRE ?=
RELEASE_FLAGS := $(if $(PRE),--pre=$(PRE),) $(if $(DRY),--dry,) $(if $(CI),--ci,)

.PHONY: help serve install build build-win build-mac build-linux dist-all release version clean

help:
	@sed -n '2,15p' Makefile

serve:
	node serve.js 8080

install:
	npm install

build: install
	$(NPX) electron-builder --publish never

build-win: install
	$(NPX) electron-builder --win --publish never

build-mac: install
	$(NPX) electron-builder --mac --publish never

build-linux: install
	$(NPX) electron-builder --linux --publish never

dist-all: install
	$(NPX) electron-builder -wml --publish never

release:
	node scripts/release.js $(BUMP) $(RELEASE_FLAGS)

version:
	@node scripts/release.js --show

clean:
	rm -rf dist
