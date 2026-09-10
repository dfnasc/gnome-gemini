UUID = gnome-gemini@dfnasc
EXTRA_SOURCES = geminiApi.js md2pango.js systemInfo.js commandParser.js commandExecutor.js

.PHONY: all compile-schemas pack install clean

all: compile-schemas

compile-schemas:
	glib-compile-schemas schemas/

pack: compile-schemas
	gnome-extensions pack --force $(foreach src,$(EXTRA_SOURCES),--extra-source=$(src))

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip

clean:
	rm -f $(UUID).shell-extension.zip schemas/gschemas.compiled
