/* global Services, MdEditor */

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	// Defines the global MdEditor (see src/main.ts)
	Services.scriptloader.loadSubScript(rootURI + 'content/main.js');
	await MdEditor.startup({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
	MdEditor.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	MdEditor.onMainWindowUnload(window);
}

async function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	await MdEditor.shutdown();
}
